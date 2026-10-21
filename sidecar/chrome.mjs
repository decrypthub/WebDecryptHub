// 查找系统 Chrome / 下载 Chrome for Testing
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function candidates() {
  const p = process.platform;
  if (p === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Google\\Chrome Beta\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];
    return roots.flatMap(r => rel.map(x => path.join(r, x)));
  }
  if (p === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'];
}

function cftDir(userData) { return path.join(userData, 'chrome-for-testing'); }

function cftPlatform() {
  const p = process.platform, a = process.arch;
  if (p === 'win32') return a === 'ia32' ? 'win32' : 'win64';
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux64';
}

function cftExecutable(userData) {
  const dir = cftDir(userData);
  const plat = cftPlatform();
  const map = {
    win64: 'chrome-win64/chrome.exe', win32: 'chrome-win32/chrome.exe', linux64: 'chrome-linux64/chrome',
    'mac-arm64': 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'mac-x64': 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  };
  return path.join(dir, map[plat]);
}

function findChrome(userData, custom) {
  const list = [];
  if (custom) list.push({ path: custom, source: '自定义' });
  for (const c of candidates()) list.push({ path: c, source: '系统' });
  if (userData) list.push({ path: cftExecutable(userData), source: 'Chrome for Testing' });
  const seen = new Set();
  const found = list.filter(c => { const k = path.resolve(c.path).toLowerCase(); if (seen.has(k)) return false; seen.add(k); try { return fs.statSync(c.path).isFile(); } catch { return false; } });
  return found;
}

// 下载 Chrome for Testing：官方源优先，失败自动切换国内镜像（npmmirror）；断点不续传但会校验解压结果。
const META_URLS = [
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
];
const PINNED_VERSION = '155.0.8059.84'; // 官方版本接口不可达（如国内网络）时使用的已验证稳定版
async function fetchT(url, ms = 20000) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); try { return await fetch(url, { signal: ac.signal }); } finally { clearTimeout(t); } }
async function downloadCft(userData, onProgress = () => {}) {
  let stable = null, metaErr = '';
  for (const u of META_URLS) { try { const r = await fetchT(u); if (r.ok) { stable = (await r.json()).channels.Stable; break; } metaErr = 'HTTP ' + r.status; } catch (e) { metaErr = e.message; } }
  const plat = cftPlatform();
  if (!stable) stable = { version: PINNED_VERSION, downloads: { chrome: [{ platform: plat, url: `https://storage.googleapis.com/chrome-for-testing-public/${PINNED_VERSION}/${plat}/chrome-${plat}.zip` }] } };
  const item = stable.downloads.chrome.find(d => d.platform === plat);
  if (!item) throw new Error('当前平台无可用下载: ' + plat);
  const mirror = `https://cdn.npmmirror.com/binaries/chrome-for-testing/${stable.version}/${plat}/chrome-${plat}.zip`;
  const dir = cftDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'chrome.zip.part');
  let lastErr = '';
  for (const [src, url] of [['官方源', item.url], ['国内镜像', mirror]]) {
    try {
      onProgress({ phase: 'download', source: src, got: 0, total: 0, version: stable.version });
      const r = await fetchT(url, 60000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const total = Number(r.headers.get('content-length')) || 0;
      const out = fs.createWriteStream(zipPath);
      let got = 0, last = 0;
      for await (const chunk of r.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise(ok => out.once('drain', ok));
        if (Date.now() - last > 250) { last = Date.now(); onProgress({ phase: 'download', source: src, got, total, version: stable.version }); }
      }
      await new Promise(ok => out.end(ok));
      if (total && got !== total) throw new Error(`下载不完整 ${got}/${total}`);
      onProgress({ phase: 'extract', source: src, got, total, version: stable.version });
      const extract = (await import('extract-zip')).default;
      fs.rmSync(path.join(dir, 'chrome-' + plat), { recursive: true, force: true });
      await extract(zipPath, { dir });
      fs.rmSync(zipPath, { force: true });
      const exe = cftExecutable(userData);
      if (!fs.existsSync(exe)) throw new Error('解压后未找到 ' + exe);
      if (process.platform !== 'win32') { try { fs.chmodSync(exe, 0o755); } catch {} }
      onProgress({ phase: 'done', source: src, got, total, version: stable.version });
      return { path: exe, version: stable.version, source: src };
    } catch (e) { lastErr = `${src}：${e.message}`; try { fs.rmSync(zipPath, { force: true }); } catch {} }
  }
  throw new Error('下载失败（已尝试官方源与国内镜像）。' + lastErr + '。也可手动安装 Chrome/Edge 后在设置中指定路径。');
}

export { findChrome, downloadCft, cftExecutable };
