import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { estimateTokens, contextTokens, modelLimit, splitForCompress, trimToolOutput, readRef, transcript } from '../context.mjs';

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
  assert.ok(contextTokens(m) > 0); assert.match(transcript(old), /调用工具: x/);
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
