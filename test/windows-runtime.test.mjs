import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { hostIntegrity, fileIntegrity, prepareBuildExecutable, prepareBrowserDistribution } from '../src/windows-runtime.mjs';
const windows = process.platform === 'win32';
const icacls = (file, ...args) => execFileSync(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [file, ...args], { windowsHide: true, stdio: 'pipe' });
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-integrity-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('Windows host integrity is read from the actual token, independently of file ownership', { skip: !windows }, async () => {
  const state = await hostIntegrity({ fresh: true }); assert.ok(state.rid >= 8192); assert.equal(state.normal, true);
});
test('only the owned build executable receives normal integrity; the surrounding directory stays low', { skip: !windows }, async t => {
  const root = fixture(t), file = path.join(root, 'own.exe'); fs.writeFileSync(file, 'owned build fixture');
  icacls(root, '/setintegritylevel', '(OI)(CI)L', '/T', '/Q'); assert.equal((await fileIntegrity(file)).rid, 4096);
  await prepareBuildExecutable(file, root); assert.equal((await fileIntegrity(file)).rid, 8192); assert.equal((await fileIntegrity(root)).rid, 4096);
  await assert.rejects(prepareBuildExecutable(file, path.join(root, 'another')), /超出/);
});
test('browser code including DLLs is provisioned without touching profiles, and junctions are rejected', { skip: !windows }, async t => {
  const root = fixture(t), code = path.join(root, 'browser'), profile = path.join(root, 'profile'); fs.mkdirSync(code); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(code, 'chrome.exe'), 'fixture'); fs.writeFileSync(path.join(code, 'chrome.dll'), 'fixture'); fs.writeFileSync(path.join(profile, 'cookies'), 'private');
  icacls(root, '/setintegritylevel', '(OI)(CI)L', '/T', '/Q');
  await prepareBrowserDistribution(code, root);
  assert.equal((await fileIntegrity(path.join(code, 'chrome.dll'))).rid, 8192); assert.equal((await fileIntegrity(profile)).rid, 4096); assert.equal((await fileIntegrity(root)).rid, 4096);
  await assert.rejects(prepareBrowserDistribution(root, root), /子目录/);
  fs.symlinkSync(profile, path.join(code, 'outside'), 'junction');
  await assert.rejects(prepareBrowserDistribution(code, root), /链接|link/i);
});
