// 内核解压：macOS .app 需要保留内部相对链接，但不能让链接逃出解压目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { extractKernel } from '../src/kernels.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-kernel-'));

async function pack(work, entries) {
  const src = path.join(work, 'src'), archive = path.join(work, 'kernel.tar.gz');
  fs.mkdirSync(src, { recursive: true });
  await tar.c({ gzip: true, file: archive, cwd: src }, entries);
  const out = path.join(work, 'out'); fs.mkdirSync(out);
  return { archive, out, src };
}

test('extractKernel: 保留 .app 内部的相对符号链接', async () => {
  const work = tmp(), src = path.join(work, 'src');
  fs.mkdirSync(path.join(src, 'Chromium.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Chromium.app/Contents/MacOS/Chromium'), 'bin');
  fs.symlinkSync('MacOS', path.join(src, 'Chromium.app/Contents/Current'));
  const archive = path.join(work, 'kernel.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: src }, ['Chromium.app']);
  const out = path.join(work, 'out'); fs.mkdirSync(out);
  await extractKernel(archive, out);
  assert.equal(fs.readFileSync(path.join(out, 'Chromium.app/Contents/Current/Chromium'), 'utf8'), 'bin');
});

test('extractKernel: 拒绝绝对路径和越界的符号链接', async () => {
  for (const [name, target] of [['abs', '/etc/passwd'], ['up', '../../etc'], ['sub/up', '../../../tmp']]) {
    const work = tmp(), src = path.join(work, 'src');
    fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'x');
    fs.symlinkSync(target, path.join(src, name));
    const archive = path.join(work, 'kernel.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: src }, [...new Set(['a.txt', name.split('/')[0]])]);
    const out = path.join(work, 'out'); fs.mkdirSync(out);
    await assert.rejects(extractKernel(archive, out), /内核包含指向目录外的链接|内核链接指向目录外|内核链接无法解析|路径越界/, name + ' -> ' + target);
  }
});
