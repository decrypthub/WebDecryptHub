import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractZip } from '../src/zip.mjs';
const regular = 'UEsDBBQAAAAAADGeWF2PKKQfBAAAAAQAAAAPAAAAbmVzdGVkL2ZpbGUudHh0c2FmZVBLAQIUABQAAAAAADGeWF2PKKQfBAAAAAQAAAAPAAAAAAAAAAAAAACAAQAAAABuZXN0ZWQvZmlsZS50eHRQSwUGAAAAAAEAAQA9AAAAMQAAAAAA';
const symlink = 'UEsDBBQAAAAAAAAAIQAGUP3wCgAAAAoAAAAEAAAAbGluay4uL291dHNpZGVQSwMEFAAAAAAAMZ5YXfs5K4IDAAAAAwAAAA0AAABsaW5rL2V2aWwudHh0YmFkUEsBAhQDFAAAAAAAAAAhAAZQ/fAKAAAACgAAAAQAAAAAAAAAAAAAAP+hAAAAAGxpbmtQSwECFAAUAAAAAAAxnlhd+zkrggMAAAADAAAADQAAAAAAAAAAAAAAgAEsAAAAbGluay9ldmlsLnR4dFBLBQYAAAAAAgACAG0AAABaAAAAAAA=';
function setup(t, data) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zip-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const file = path.join(root, 'test.zip'); fs.writeFileSync(file, Buffer.from(data, 'base64')); return { file, dir: path.join(root, 'out') }; }
test('runtime ZIP extraction supports regular files', async t => { const s = setup(t, regular); await extractZip(s.file, s); assert.equal(fs.readFileSync(path.join(s.dir, 'nested/file.txt'), 'utf8'), 'safe'); });
test('runtime ZIP extraction rejects archive-created symlinks', async t => { const s = setup(t, symlink); await assert.rejects(() => extractZip(s.file, s), /链接|特殊/); assert.equal(fs.existsSync(path.join(s.dir, 'link')), false); });
test('runtime ZIP extraction bounds decompressed size before writing', async t => { const s = setup(t, regular); await assert.rejects(() => extractZip(s.file, { ...s, maxBytes: 3 }), /限制/); assert.equal(fs.existsSync(path.join(s.dir, 'nested/file.txt')), false); });
