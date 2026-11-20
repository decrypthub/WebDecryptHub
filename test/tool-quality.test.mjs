// 守住工具定义的信息质量：
// - 每个参数都要有实质 description（模型不该靠参数名猜）
// - description 不该罗列参数名（agent-experience: say each fact once）
// - 工具定义总量要有预算上限（防无限膨胀）
// - 报错要给下一步（模型撞到时能自救）
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function runtime() {
  const { WebRuntime } = await import('../src/service.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-ax-'));
  return { rt: new WebRuntime({ root: dir, dataDir: dir, kernelDir: dir }), dir };
}

test('每个参数都有实质 description', async () => {
  const { rt } = await runtime();
  const missing = [];
  const weak = [];
  for (const t of rt.tools()) {
    for (const [k, v] of Object.entries(t.inputSchema?.properties || {})) {
      const d = v.description;
      if (!d) missing.push(`${t.name}.${k}`);
      else if (d.length < 6) weak.push(`${t.name}.${k}=${JSON.stringify(d)}`);
    }
  }
  assert.deepEqual(missing, [], '这些参数缺 description，模型只能靠参数名猜');
  assert.deepEqual(weak, [], '这些参数的 description 太短，没有信息量');
});

test('description 不罗列参数名', async () => {
  const { rt } = await runtime();
  const offenders = [];
  for (const t of rt.tools()) {
    const props = Object.keys(t.inputSchema?.properties || {});
    const dup = props.filter((p) => new RegExp(`(^|[^a-zA-Z_])${p}([^a-zA-Z_]|$)`).test(t.description || ''));
    if (dup.length >= 2) offenders.push(`${t.name}: ${dup.join(', ')}`);
  }
  assert.deepEqual(offenders, [], '这些工具在 description 里罗列参数名，应该把规则写到参数上');
});

test('工具定义总量在预算内', async () => {
  const { rt } = await runtime();
  const chars = JSON.stringify(rt.tools()).length;
  // 未加载 debugger 时约 3000 token。留 20% 余量给后续加工具。
  assert.ok(chars < 11000, `工具定义 ${chars} 字符超出预算（上限 11000）`);
});

test('元素定位三选一的关系写在参数上', async () => {
  const { rt } = await runtime();
  const click = rt.tools().find((t) => t.name === 'browser_click');
  const p = click.inputSchema.properties;
  assert.match(p.selector.description, /role/, 'selector 应说明与 role+name 的关系');
  assert.match(p.role.description, /name/, 'role 应说明必须与 name 配对');
  assert.match(p.name.description, /role/, 'name 应说明必须与 role 配对');
});

test('未知工具报错给出 discover_tools 指引', async () => {
  const { rt } = await runtime();
  await assert.rejects(
    () => rt.call('evaluate_script', { confirm: true, function: '() => 1' }),
    (e) => {
      assert.match(e.message, /discover_tools/, '没加载调试器时应该告诉调用方怎么加载');
      return true;
    },
  );
});

test('read_file_slice 超限时给出继续读的 offset', async () => {
  const { rt, dir } = await runtime();
  fs.writeFileSync(path.join(dir, 'long.txt'), 'A'.repeat(20000));
  const r = await rt.call('read_file_slice', { file: 'long.txt', offset: 0, length: 99999 });
  assert.match(r.text, /offset=12000/, '截断时必须说清下一步从哪继续');
  assert.match(r.text, /12000/, '应说明单次上限');

  const tail = await rt.call('read_file_slice', { file: 'long.txt', offset: 19000, length: 3000 });
  assert.doesNotMatch(tail.text, /未读完/, '读到文件尾就不该再提示未读完');
});
