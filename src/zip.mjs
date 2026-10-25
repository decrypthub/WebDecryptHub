// No archive-created links, device files, paths outside the destination or
// unbounded decompression. Existing files are replaced atomically.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import { pipeline } from 'node:stream/promises';
import { resolveIn } from './paths.mjs';

export async function extractZip(file, { dir, maxBytes = 2 * 1024 ** 3, maxEntries = 100000 } = {}) {
  const root = path.resolve(dir); fs.mkdirSync(root, { recursive: true }); resolveIn(root, '.');
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (e, z) => e ? reject(e) : resolve(z)));
  let entries = 0, bytes = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = e => { if (settled) return; settled = true; zip.close(); reject(e); };
    zip.on('error', fail); zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
    zip.on('entry', entry => { (async () => {
      if (++entries > maxEntries || (bytes += entry.uncompressedSize) > maxBytes || entry.uncompressedSize > 512 * 1024 ** 2) throw new Error('ZIP 超过解压限制');
      const mode = entry.externalFileAttributes >>> 16, type = mode & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) throw new Error('ZIP 中含符号链接或特殊文件，已拒绝');
      const name = entry.fileName.replace(/\\/g, '/'), target = resolveIn(root, name);
      if (name.endsWith('/')) fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true }); resolveIn(root, name);
        const temp = target + '.' + crypto.randomUUID() + '.part';
        try {
          const stream = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry, (e, s) => e ? rejectStream(e) : resolveStream(s)));
          await pipeline(stream, fs.createWriteStream(temp, { flags: 'wx', mode: mode ? mode & 0o777 : 0o644 }));
          resolveIn(root, name); fs.renameSync(temp, target);
        } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
      }
      if (!settled) zip.readEntry();
    })().catch(fail); });
    zip.readEntry();
  });
}
