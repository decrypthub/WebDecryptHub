// 安装器与更新关闭流程的静态检查：不按映像名结束进程，锁定写入会先重试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTreeArgs } from '../sidecar/proctree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const nsisFiles = [
  'src-tauri/windows/hooks.nsh',
  'src-tauri/windows/installer.nsi',
  'scripts/installer.nsi',
];

test('installers do not taskkill by image name', () => {
  for (const rel of nsisFiles) {
    const text = read(rel);
    assert.equal(/taskkill/i.test(text), false, rel);
    assert.equal(/\/IM\b/.test(text), false, rel);
    assert.equal(/Stop-Process\s+-Name/i.test(text), false, rel);
  }
});

test('stop script only targets install-dir WebDecryptHub, sidecar, and bundled node', () => {
  const hooks = read('src-tauri/windows/hooks.nsh');
  const names = hooks.match(/\$\$names = @\(([^)]+)\)/);
  assert.ok(names, 'missing names allowlist');
  const list = names[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(list, ['WebDecryptHub.exe', 'jsra-sidecar.exe', 'node.exe']);
  assert.match(hooks, /StartsWith\(\$\$root, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(hooks, /Stop-Process -Id \$\$p\.ProcessId/);
  assert.equal(/chrome\.exe/i.test(names[1]), false);
  assert.match(hooks, /SetOverwrite try/);
  assert.match(hooks, /!define WDH_WRITE_RETRIES 16/);
  assert.match(hooks, /WDH_WRITE_WAIT_MS 500/);
});

test('tauri template retries the locked payload writes and still packages every resource', () => {
  const nsi = read('src-tauri/windows/installer.nsi');
  assert.match(nsi, /!insertmacro WDH_Extract "\$\{MAINBINARYSRCPATH\}"/);
  assert.match(nsi, /\{\{#each resources\}\}/);
  assert.match(nsi, /!insertmacro WDH_Extract "\{\{no-escape @key\}\}" "\$INSTDIR\\\{\{this\.\[1\]\}\}"/);
  assert.match(nsi, /!define MUI_FINISHPAGE_RUN_TEXT "立即启动 WebDecryptHub"/);
  assert.match(nsi, /!define MUI_FINISHPAGE_RUN_CHECKED/);
  assert.match(nsi, /!define MUI_PAGE_HEADER_TEXT "正在安装"/);
  assert.match(nsi, /headerImage|HEADERIMAGE/);
});

test('manual installer uses the same stop and retry helpers', () => {
  const nsi = read('scripts/installer.nsi');
  assert.match(nsi, /!include "\.\.\\src-tauri\\windows\\hooks\.nsh"/);
  assert.ok(nsi.indexOf('SetCompressor') < nsi.indexOf('hooks.nsh'), 'hooks include Functions and must follow SetCompressor');
  assert.match(nsi, /Call WDH_StopInstallDirProcesses/);
  assert.match(nsi, /Call un\.WDH_StopInstallDirProcesses/);
  assert.match(nsi, /WDH_Extract "payload\\\$\{APP\}\.exe"/);
  assert.match(nsi, /WDH_Extract "payload\\jsra-sidecar\.exe"/);
  assert.match(nsi, /\/x node\.exe/);
  assert.match(nsi, /WDH_Extract "payload\\resources\\node\\node\.exe"/);
  assert.match(nsi, /RequestExecutionLevel user/);
  assert.match(nsi, /!define VER "1\.3\.1"/);
});

test('app stops the sidecar before the installer and shows 正在安装', () => {
  const updater = read('ui/src/updater.js');
  const prepare = updater.indexOf('prepareForUpdate');
  const install = updater.indexOf('update.install');
  assert.ok(prepare > 0 && install > prepare);
  assert.match(read('ui/src/forms.jsx'), /正在安装/);
  assert.match(read('sidecar/index.mjs'), /'prepare-exit'/);
  assert.match(read('sidecar/index.mjs'), /sessions\.closeAll\(\)/);
  assert.match(read('src-tauri/src/main.rs'), /prepare_for_update/);
  assert.match(read('src-tauri/src/shutdown.rs'), /is_install_dir_image/);
  const win = killTreeArgs(9, 'win32');
  assert.deepEqual(win.args, ['/PID', '9', '/T', '/F']);
});

test('version is 1.3.1 in the release surfaces', () => {
  for (const rel of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'ui/src/transport.js']) {
    assert.match(read(rel), /1\.3\.1/, rel);
  }
  assert.match(read('src-tauri/tauri.conf.json'), /"installMode": "currentUser"/);
  assert.match(read('src-tauri/tauri.conf.json'), /windows\/header\.bmp/);
  assert.match(read('src-tauri/tauri.conf.json'), /windows\/sidebar\.bmp/);
  assert.match(read('src-tauri/tauri.conf.json'), /windows\/installer\.ico/);
});
