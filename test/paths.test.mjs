// 路径约束：唯一的 resolveIn() 实现 + 工具侧真的用上了它。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveIn, tryResolveIn } from '../src/paths.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-path-'));

test('resolveIn: 允许根目录内的一切写法', () => {
  const root = tmp();
  assert.equal(resolveIn(root, 'a.js'), path.join(root, 'a.js'));
  assert.equal(resolveIn(root, 'sub/dir/a.js'), path.join(root, 'sub', 'dir', 'a.js'));
  assert.equal(resolveIn(root, 'sub/../a.js'), path.join(root, 'a.js'));   // 绕回来仍在根内
  assert.equal(resolveIn(root, ''), root);
  assert.equal(resolveIn(root, '.'), root);
  // 落在根内的绝对路径也允许
  assert.equal(resolveIn(root, path.join(root, 'b.js')), path.join(root, 'b.js'));
});

test('resolveIn: 拒绝越界（父目录、绝对路径、同名前缀的兄弟目录）', () => {
  const base = tmp();
  const root = path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(base, 'project-evil'), { recursive: true });
  assert.throws(() => resolveIn(root, '../x'), /路径越界/);
  assert.throws(() => resolveIn(root, '../project-evil/x'), /路径越界/);
  assert.throws(() => resolveIn(root, path.join(base, 'etc', 'passwd')), /路径越界/);
  // 旧实现用裸 startsWith，会把 project-evil 当成 project 的子目录
  assert.throws(() => resolveIn(root, path.join(base, 'project-evil', 'x')), /路径越界/);
});

test('resolveIn: 错误信息带原样入参，模型能自己改', () => {
  const root = tmp();
  try { resolveIn(root, '../../secret'); assert.fail('应当抛错'); }
  catch (e) { assert.match(e.message, /\.\.\/\.\.\/secret/); assert.match(e.message, /相对路径/); }
});

test('tryResolveIn: 越界返回 null 而不抛', () => {
  const root = tmp();
  assert.equal(tryResolveIn(root, '../x'), null);
  assert.ok(tryResolveIn(root, 'ok.js'));
});

test('deobfuscate_code: source 越界直接报错（不再接受任意绝对路径）', async () => {
  let LOCAL_TOOLS = null;
  try { ({ LOCAL_TOOLS } = await import('../localtools.mjs')); } catch { /* 缺依赖时跳过 */ }
  if (!LOCAL_TOOLS) return;
  const tool = LOCAL_TOOLS.find(t => t.name === 'deobfuscate_code');
  const root = tmp();
  await assert.rejects(() => tool.run({ source: '../../../etc/passwd' }, { projectDir: root }), /路径越界/);
  await assert.rejects(() => tool.run({ source: path.resolve(root, '..', 'x.js') }, { projectDir: root }), /路径越界/);
});

test('net_load_har: 只读项目目录内的 HAR', async () => {
  let LOCAL_TOOLS = null;
  try { ({ LOCAL_TOOLS } = await import('../localtools.mjs')); } catch { /* 跳过 */ }
  if (!LOCAL_TOOLS) return;
  const tool = LOCAL_TOOLS.find(t => t.name === 'net_load_har');
  const root = tmp();
  const ctx = { projectDir: root, browser: { imported: [] } };
  await assert.rejects(() => tool.run({ file: '../../secret.har' }, ctx), /路径越界/);
});
