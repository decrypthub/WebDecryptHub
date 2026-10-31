// 内核 Release 选择：官方把不同平台的构建放在不同 Release，必须按平台找到真正可用的那一个。
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAsset, selectRelease, githubHeaders } from '../src/kernels.mjs';

test('GitHub requests carry a token when one is configured', () => {
  const withToken = githubHeaders({ DECRYPTHUB_GITHUB_TOKEN: 'fixture-token' });
  assert.equal(withToken.Authorization, 'Bearer fixture-token');
  assert.equal(githubHeaders({}).Authorization, undefined);
});

const asset = (name) => ({ name, browser_download_url: 'https://github.com/CloakHQ/cloakbrowser/releases/download/t/' + name, size: 1 });
const release = (tag, names) => ({ tag_name: tag, assets: names.map(asset) });

const newest = release('chromium-v155.0.8059.39.2-pro', []); // 只有 SHA256SUMS，无平台包
const linuxOnly = release('chromium-v146.0.7680.177.5', ['cloakbrowser-linux-x64.tar.gz', 'cloakbrowser-windows-x64.zip']);
const mac = release('chromium-v145.0.7632.109.2', ['cloakbrowser-darwin-arm64.tar.gz', 'cloakbrowser-darwin-x64.tar.gz', 'cloakbrowser-linux-x64.tar.gz']);

test('selectRelease: macOS arm64 跳过只有 Linux/Windows 的新版本', () => {
  const { release: picked, asset: file } = selectRelease([newest, linuxOnly, mac], { platform: 'darwin', arch: 'arm64' });
  assert.equal(picked.tag_name, mac.tag_name);
  assert.equal(file.name, 'cloakbrowser-darwin-arm64.tar.gz');
});

test('selectRelease: Windows 命中最新且有平台包的版本', () => {
  const { release: picked, asset: file } = selectRelease([newest, linuxOnly, mac], { platform: 'win32', arch: 'x64' });
  assert.equal(picked.tag_name, linuxOnly.tag_name);
  assert.equal(file.name, 'cloakbrowser-windows-x64.zip');
});

test('selectRelease: 指定文件名时只在该文件存在的 Release 上生效', () => {
  const { release: picked } = selectRelease([newest, linuxOnly, mac], { asset: 'cloakbrowser-darwin-x64.tar.gz' });
  assert.equal(picked.tag_name, mac.tag_name);
  assert.throws(() => selectRelease([newest, linuxOnly], { asset: 'cloakbrowser-darwin-x64.tar.gz' }), /未找到 Release 文件/);
});

test('selectRelease: 没有平台匹配时列出可选文件名，而不是抛平台错误', () => {
  assert.throws(() => selectRelease([linuxOnly], { platform: 'darwin', arch: 'arm64' }), /没有找到支持当前系统的内核文件.*cloakbrowser-windows-x64\.zip/);
  assert.throws(() => selectRelease([newest], { platform: 'darwin', arch: 'arm64' }), /没有找到可下载的浏览器 Release/);
});

test('matchAsset: 同名平台包在同一个 Release 中不唯一时返回 null', () => {
  const ambiguous = release('chromium-v1', ['cloakbrowser-linux-x64.tar.gz', 'cloakbrowser-linux-x64-legacy.tar.gz']);
  assert.equal(matchAsset(ambiguous, { platform: 'linux', arch: 'x64' }), null);
  assert.equal(matchAsset(ambiguous, { asset: 'cloakbrowser-linux-x64.tar.gz' }).name, 'cloakbrowser-linux-x64.tar.gz');
});
