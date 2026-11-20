// 守住两件事：
// 1. RESET_TOOLS 里的每个工具都必须真的出现在 tools() 里，且 call() 能分发到
// 2. 未知参数必须报错并列出可接受参数，不能静默丢弃
//
// 这类 bug 的特征是「代码写了、测试绿、但功能不可达」——只有直接断言可达性才抓得住。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RESET_TOOLS } from '../src/resettools.mjs';
import { validateArgs } from '../src/protocol.mjs';

test('RESET_TOOLS 的每个工具都必须出现在 tools() 里', async () => {
  const { WebRuntime } = await import('../src/service.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-tools-'));
  const rt = new WebRuntime({ root: dir, dataDir: dir, kernelDir: dir });
  const names = rt.tools().map((t) => t.name);
  for (const tool of RESET_TOOLS) {
    assert.ok(names.includes(tool.name), `${tool.name} 定义了但没有出现在 tools() 里（AI 看不到它）`);
  }
});

test('RESET_TOOLS 的每个工具都要下发可用的 schema', async () => {
  const { WebRuntime } = await import('../src/service.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-tools-'));
  const rt = new WebRuntime({ root: dir, dataDir: dir, kernelDir: dir });
  const byName = new Map(rt.tools().map((t) => [t.name, t]));
  for (const tool of RESET_TOOLS) {
    const wire = byName.get(tool.name);
    assert.ok(wire, `${tool.name} 不在 tools() 里`);
    assert.equal(typeof wire.description, 'string');
    assert.ok(wire.description.length > 20, `${tool.name} 的 description 太短，模型看不出用途`);
    assert.equal(wire.inputSchema?.type, 'object');
  }
});

test('RESET_TOOLS 的读取类工具真的能跑（不依赖浏览器）', async () => {
  const { WebRuntime } = await import('../src/service.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-tools-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'function sign(x){ return x * 2 }\n');
  const rt = new WebRuntime({ root: dir, dataDir: dir, kernelDir: dir });

  const files = await rt.call('list_project_files', {});
  assert.ok(!files.isError, files.text);
  assert.match(files.text, /a\.js/);

  const g = await rt.call('grep_file', { file: 'a.js', pattern: 'sign' });
  assert.ok(!g.isError, g.text);
  assert.match(g.text, /offset/);

  const s = await rt.call('read_file_slice', { file: 'a.js', offset: 0, length: 20 });
  assert.ok(!s.isError, s.text);
  assert.match(s.text, /a\.js/);
});

test('危险操作的 confirm 守卫生效', async () => {
  const { WebRuntime } = await import('../src/service.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-tools-'));
  const rt = new WebRuntime({ root: dir, dataDir: dir, kernelDir: dir });

  for (const name of ['reset_session', 'restart_browser_fresh']) {
    const r = await rt.call(name, { confirm: false });
    assert.equal(r.isError, true, `${name} 没有 confirm 就执行了`);
    assert.match(r.text, /需要确认/);
  }
});

test('未知参数报错并列出可接受的参数名', () => {
  const schema = {
    type: 'object',
    properties: { url: { type: 'string' }, limit: { type: 'number' } },
    required: [],
  };
  const r = validateArgs(schema, { urls: 'x' }, { strict: true });
  assert.equal(r.ok, false, '未知参数被静默接受了');
  assert.match(r.error, /urls/);
  assert.match(r.error, /"url"/);
  assert.match(r.error, /"limit"/);
});

test('未知参数不改变同名合法参数的校验', () => {
  const schema = {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  };
  assert.equal(validateArgs(schema, { url: 'https://a' }, { strict: true }).ok, true);
  assert.equal(validateArgs(schema, {}, { strict: true }).ok, false);
});

test('非 strict 模式保持宽松（不破坏旧调用方）', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const r = validateArgs(schema, { a: 'x', extra: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.dropped, []);
});
