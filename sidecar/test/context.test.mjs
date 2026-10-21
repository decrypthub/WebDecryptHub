import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { estimateTokens, contextTokens, modelLimit, limitInfo, compactTrigger, breakdown, microcompact, splitByTokens, buildSummaryRequest, splitForCompress, trimToolOutput, readRef, transcript } from '../context.mjs';

test('estimateTokens CJK vs latin', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('a'.repeat(36)), 10);
  assert.equal(estimateTokens(''), 0);
});
test('modelLimit', () => {
  assert.equal(modelLimit({ openai: { model: 'deepseek-v4.1-flash' } }), 128000);
  assert.equal(modelLimit({ contextWindow: 32000 }), 32000);
  assert.equal(modelLimit({ provider: 'anthropic', anthropic: { model: 'claude-sonnet-4-5' } }), 200000);
});
test('splitForCompress keeps tool pairs and recent turns', () => {
  const m = [{ role: 'system', content: 's' },
    { role: 'user', content: 'u1' }, { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'r' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3' }];
  const { old, recent } = splitForCompress(m, 2);
  assert.equal(old.length, 4); assert.equal(recent[0].content, 'u2'); assert.equal(recent.length, 4);
  assert.ok(contextTokens(m) > 0); assert.match(transcript(old), /调用工具\]: x/);
});
test('single long turn splits at non-tool boundary', () => {
  const m = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 10; i++) { m.push({ role: 'assistant', content: '', tool_calls: [{ id: 't' + i, function: { name: 'n', arguments: '{}' } }] }); m.push({ role: 'tool', tool_call_id: 't' + i, content: 'x' }); }
  const { old, recent } = splitForCompress(m, 2);
  assert.ok(old.length > 0); assert.notEqual(recent[0].role, 'tool');
});
test('trimToolOutput stores ref and readRef pages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  const big = 'r12 ' + 'x'.repeat(20000);
  const t = trimToolOutput(big, { dir, name: 'net_list' });
  const ref = t.match(/ctx_[0-9a-f]{10}/)[0];
  assert.ok(t.length < 2500); assert.match(t, /net_get\(id\)/);
  const r = readRef(dir, ref, 100, 500); assert.match(r.text, /100-600\/20004/);
  assert.equal(readRef(dir, '../etc/passwd').isError, true);
  assert.equal(trimToolOutput('short', { dir }), 'short');
});

test('per-model window, legacy and inferred', () => {
  assert.deepEqual(limitInfo({ provider: 'openai', openai: { model: 'deepseek-v4.1-flash', contextWindow: 1000000 } }), { limit: 1000000, inferred: false });
  assert.deepEqual(limitInfo({ provider: 'openai', openai: { model: 'deepseek-v4.1-flash' } }), { limit: 128000, inferred: true });
  assert.equal(modelLimit({ provider: 'anthropic', anthropic: { model: 'claude-x', contextWindow: 500000 }, openai: { contextWindow: 128000 } }), 500000);
});
test('compactTrigger uses threshold and reserve', () => {
  assert.equal(compactTrigger(128000, 0.85), 108800);
  assert.equal(compactTrigger(1000000, 0.85), 850000);
  assert.equal(compactTrigger(30000, 0.95), 27000); // 10% 预留
});
test('breakdown categories and microcompact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  const m = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q ' + 'a'.repeat(3600), _attTok: 900 }];
  for (let i = 0; i < 5; i++) m.push({ role: 'tool', name: 'net_get', content: 'y'.repeat(5000) });
  const b = breakdown(m, [{ name: 't' }]);
  assert.ok(b.attachments === 900 && b.toolResults > 6000 && b.tools > 0 && b.system > 0);
  const r = microcompact(m, { dir, keep: 3 });
  assert.equal(r.count, 2); assert.ok(r.saved > 2000);
  assert.match(m[2].content, /ctx_[0-9a-f]{10}/); assert.equal(m[6].content.length, 5000);
  assert.equal(microcompact(m, { dir, keep: 3 }).count, 0);
});
test('splitByTokens keeps recent budget and previous summary', () => {
  const m = [{ role: 'system', content: 's' }, { role: 'user', _summary: {}, content: '【检查点】\nOLD' }, { role: 'assistant', _ack: true, content: 'ok' }];
  for (let i = 0; i < 6; i++) m.push({ role: 'user', content: 'u' + i + ' ' + 'z'.repeat(360) }, { role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, function: { name: 'n', arguments: '{}' } }] }, { role: 'tool', content: 'r'.repeat(360) }, { role: 'assistant', content: 'a' + i });
  const { previousSummary, old, recent } = splitByTokens(m, 250);
  assert.equal(previousSummary, 'OLD'); assert.notEqual(recent[0].role, 'tool');
  assert.ok(old.length > 10 && recent.length >= 1); assert.ok(!old.some(x => x._summary || x._ack));
  const req = buildSummaryRequest(old, { previousSummary, instructions: '关注 sign 算法' });
  assert.match(req[1].content, /<previous-summary>/); assert.match(req[1].content, /关注 sign 算法/); assert.match(req[1].content, /## 下一步/);
});
