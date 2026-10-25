import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== metadata.version) throw Error('Package and component versions differ');
const destination = path.join(
  root,
  'dist',
  'wdh-' + metadata.version + '-' + process.platform + '-' + process.arch + '-' + Date.now(),
);
fs.mkdirSync(destination, { recursive: true });
const files = [];
function copy(source, target, relative) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw Error('Refusing component source link: ' + relative);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source))
      if (!['.bin', '.cache'].includes(name))
        copy(path.join(source, name), path.join(target, name), relative + '/' + name);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    files.push({
      path: relative.replaceAll('\\', '/'),
      size: stat.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
    });
  }
}
for (const item of [
  'src',
  'node_modules',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
])
  copy(path.join(root, item), path.join(destination, item), item);

manifest.platform = process.platform;
manifest.arch = process.arch;
manifest.files = files;
fs.writeFileSync(path.join(destination, 'component.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'dist', 'latest-component.txt'), destination + '\n');
console.log('Component directory: ' + destination);
console.log('Verified files: ' + files.length + '; browser binaries: none');
