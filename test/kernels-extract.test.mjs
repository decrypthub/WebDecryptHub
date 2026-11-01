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

// 「相对目录符号链接」不是所有平台都能构造：Windows 无开发者模式时 symlink 直接 EPERM，
// 有权限时 Node 也会建出文件型链接（无法当目录穿越）。这两种情况都不该让本文件假红 ——
// Windows 的内核走 zip 分发（见 downloadGithub / matchAsset），tar + .app 链接只服务 macOS。
const relativeDirLink = (() => {
  try {
    const probe = tmp();
    fs.mkdirSync(path.join(probe, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(probe, 'MacOS/Chromium'), 'bin');
    fs.symlinkSync('MacOS', path.join(probe, 'Current'));
    // 建得出来不代表能用：真穿过去读一次，确认它是可遍历的目录链接。
    const through = fs.readFileSync(path.join(probe, 'Current/Chromium'), 'utf8');
    fs.rmSync(probe, { recursive: true, force: true });
    return through === 'bin' ? null : '相对目录符号链接不可穿越（' + process.platform + '）';
  } catch (e) {
    return '相对目录符号链接不可用（' + process.platform + '：' + (e.code || e.message) + '）';
  }
})();

// 手写 tar 条目：拒绝越界链接是安全逻辑，必须在本机无符号链接特权时也能验证，
// 所以夹具不经过 fs.symlinkSync，直接构造带 linkpath 的条目。
function tarHeader(name, size, type, linkname = '') {
  const b = Buffer.alloc(512, 0);
  b.write(name, 0, 100, 'utf8');
  b.write('0000644\0', 100, 8);
  b.write('0000000\0', 108, 8);
  b.write('0000000\0', 116, 8);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  b.write('00000000000\0', 136, 12);
  b.write('        ', 148, 8);
  b.write(type, 156, 1);
  b.write(linkname, 157, 100, 'utf8');
  b.write('ustar\0' + '00', 257, 8);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return b;
}

function fileEntry(name, content) {
  const data = Buffer.from(content, 'utf8');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([tarHeader(name, data.length, '0'), data, pad]);
}

const linkEntry = (name, target) => tarHeader(name, 0, '2', target);
const dirEntry = (name) => tarHeader(name, 0, '5');

test('extractKernel: 保留 .app 内部的相对符号链接', { skip: relativeDirLink }, async () => {
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
  for (const [name, target] of [['abs', '/etc/passwd'], ['up', '../../etc'], ['sub/up', '../../../tmp'], ['absup', '/tmp/x']]) {
    const work = tmp(), archive = path.join(work, 'kernel.tar.gz');
    fs.writeFileSync(archive, Buffer.concat([
      fileEntry('a.txt', 'x'),
      ...name.split('/').slice(0, -1).map((part, i) => dirEntry(name.split('/').slice(0, i + 1).join('/') + '/')),
      linkEntry(name, target),
      Buffer.alloc(1024, 0),
    ]));
    const out = path.join(work, 'out'); fs.mkdirSync(out);
    await assert.rejects(extractKernel(archive, out), /内核包含指向目录外的链接|内核链接指向目录外|内核链接无法解析|路径越界/, name + ' -> ' + target);
  }
});
