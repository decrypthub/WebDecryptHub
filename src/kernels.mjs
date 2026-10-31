// User-selected browser binaries. Downloads are staged, bounded and verified before activation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { extractZip } from './zip.mjs';
import { resolveIn, atomicJson } from './paths.mjs';
import { requireNormalHost, prepareBrowserDistribution } from './windows-runtime.mjs';

const MAX = 1024 ** 3;
const CLOAK_KEY = 'MKFKwIhUcKWq5xTuNA0Ovg99njcDEcEJvmWYYhApvaU=';
export function repositoryName(value = 'CloakHQ/cloakbrowser') {
  const v = String(value).trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(v) || v.includes('..')) throw new Error('填写 GitHub 仓库 owner/repo');
  return v;
}
export function archiveAssets(release) {
  return ((release || {}).assets || []).filter(a => /\.(zip|tar\.gz)$/i.test(a.name));
}
// 返回与当前平台/架构匹配的唯一文件；不匹配时返回 null（用于跨 Release 查找）。
export function matchAsset(release, { asset, platform = process.platform, arch = process.arch } = {}) {
  const all = archiveAssets(release);
  if (asset) return all.find(a => a.name === asset) || null;
  const platforms = platform === 'win32' ? /windows|win(?:32|64|-)/i : platform === 'darwin' ? /darwin|mac/i : /linux/i;
  const arches = arch === 'arm64' ? /arm64|aarch64/i : /x64|amd64|win64|x86_64/i;
  const found = all.filter(a => platforms.test(a.name) && arches.test(a.name));
  return found.length === 1 ? found[0] : null;
}
export function chooseAsset(release, options = {}) {
  const target = matchAsset(release, options);
  if (target) return target;
  if (options.asset) throw new Error('未找到 Release 文件：' + options.asset);
  throw new Error('请指定当前系统的 Release 文件名。可选：' + archiveAssets(release).map(a => a.name).join(', '));
}
// 未登录的 GitHub API 每小时只有 60 次额度，用尽即返回 403；配置令牌可提升到 5000 次。
// api=false 用于公开网页：github.com 会拒绝 API 的 Accept 类型（406），也不能带令牌。
function githubHeaders(api = true) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return {
    'User-Agent': 'WebDecryptHub',
    Accept: api ? 'application/vnd.github+json' : 'text/html,application/xhtml+xml',
    ...(api && token ? { Authorization: 'Bearer ' + token } : {}),
  };
}
function rateLimited(status, resetAt) {
  const at = resetAt ? new Date(resetAt * 1000) : null;
  const when = at && !Number.isNaN(at.getTime()) ? '，额度约 ' + at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 恢复' : '';
  const err = new Error(`GitHub 请求受限（HTTP ${status}）${when}。可设置 GH_TOKEN 环境变量提升额度。`);
  err.status = status;
  err.resetAt = resetAt || 0;
  return err;
}
async function response(url, fetcher, ms = 20000, api = true) {
  const r = await fetcher(url, { signal: AbortSignal.timeout(ms), headers: githubHeaders(api) });
  if (!r.ok) {
    // 限流单独区分，调用方据此改走不需要 API 额度的网页通道。
    if (r.status === 403 || r.status === 429) throw rateLimited(r.status, Number(r.headers?.get?.('x-ratelimit-reset')) || 0);
    throw new Error(`GitHub HTTP ${r.status}：${url}`);
  }
  return r;
}
async function small(url, fetcher, api = true) { const r = await response(url, fetcher, 20000, api); const chunks = []; let n = 0; for await (const c of r.body) { if ((n += c.length) > 2e6) throw new Error('下载元数据过大'); chunks.push(c); } return Buffer.concat(chunks); }
// API 额度用尽时改走网页通道：/releases 列出标签，expanded_assets 片段列出该标签下的文件。
// 两者都是公开页面，不消耗 API 额度；解析结果与 API 返回的 { tag_name, assets } 形状保持一致。
export function parseReleaseTags(html) {
  const re = /\/releases\/tag\/([^"'<>?\s]+)/g, out = [], seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    let tag; try { tag = decodeURIComponent(m[1]); } catch { continue; }
    if (!tag || seen.has(tag)) continue;
    seen.add(tag); out.push(tag);
  }
  return out;
}
export function parseReleaseAssets(html, repository) {
  const prefix = '/' + String(repository).toLowerCase() + '/releases/download/', out = [], seen = new Set();
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].replace(/&amp;/g, '&');
    if (!href.toLowerCase().startsWith(prefix)) continue;
    const clean = href.split('?')[0].split('#')[0];
    let name; try { name = decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1)); } catch { continue; }
    if (!name || seen.has(name)) continue;
    seen.add(name); out.push({ name, browser_download_url: 'https://github.com' + clean });
  }
  return out;
}
export async function releasesFromHtml(repository, fetcher, { tag, pages = 3, want = 3, concurrency = 4 } = {}) {
  const read = async (url) => (await small(url, fetcher, false)).toString('utf8');
  // 官方把构建分散在多个 Release，且新版本可能只有签名清单，所以要逐页找、逐版本确认。
  let tags;
  if (tag) tags = [tag];
  else {
    tags = [];
    for (let page = 1; page <= pages; page++) {
      const found = parseReleaseTags(await read(`https://github.com/${repository}/releases?page=${page}`));
      if (!found.length) break;
      for (const t of found) if (!tags.includes(t)) tags.push(t);
    }
  }
  const releases = [];
  for (let i = 0; i < tags.length && releases.length < want; i += concurrency) {
    const batch = tags.slice(i, i + concurrency);
    const html = await Promise.all(batch.map((t) => read(`https://github.com/${repository}/releases/expanded_assets/${encodeURIComponent(t)}`)));
    batch.forEach((t, index) => {
      if (releases.length >= want) return;
      const assets = parseReleaseAssets(html[index], repository);
      if (assets.some(a => /\.(zip|tar\.gz)$/i.test(a.name))) releases.push({ tag_name: t, assets });
    });
  }
  return releases;
}
export function verifyCloak(manifest, signature, version, asset) {
  const text = signature.toString().trim(), sig = Buffer.from(text, 'base64');
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(CLOAK_KEY, 'base64').toString('base64url') }, format: 'jwk' });
  if (sig.toString('base64') !== text || !crypto.verify(null, manifest, key, sig)) throw new Error('CloakBrowser 签名验证失败');
  const lines = manifest.toString('utf8').split(/\r?\n/);
  if (!lines.some(l => l.trim() === 'version=' + version)) throw new Error('CloakBrowser 签名清单版本不匹配');
  const line = lines.map(l => l.match(/^([a-f\d]{64})\s+\*?(.+)$/i)).find(m => m?.[2] === asset);
  if (!line) throw new Error('签名清单缺少当前内核');
  return line[1].toLowerCase();
}
export function installedKernel(userData, kind = 'github') {
  try { const meta = JSON.parse(fs.readFileSync(path.join(userData, 'kernels', kind + '.json'), 'utf8')); const file = resolveIn(path.join(userData, 'kernels'), meta.relativePath); if (fs.statSync(file).isFile()) return { ...meta, path: file }; } catch {}
  return null;
}
export async function probeKernel(userData, executablePath) {
  const { BrowserManager } = await import('./browser.mjs');
  const root = path.resolve(userData, 'kernel-checks'); fs.mkdirSync(root, { recursive: true }); resolveIn(root, '.');
  const directory = fs.mkdtempSync(path.join(root, 'check-')), browser = new BrowserManager();
  try {
    await browser.launch({ executablePath, headless: true, profileDir: path.join(directory, 'profile'), isolated: false, projectDir: directory, embed: false });
    const title = await browser.activePage.title(); await browser.activePage.screenshot({ timeout: 10000 });
    return { ok: true, title, path: executablePath };
  } catch (e) {
    const message = String(e.message).replace(/\x1b\[[0-9;]*m/g, ''), code = message.match(/exitCode=(\d+)|spawn (\w+)/);
    return { ok: false, error: '内核启动检查失败：' + (code ? code[0] : message.split('\n')[0]).slice(0, 500) + '。可以重新下载内核后再试。' };
  } finally { await browser.close(); resolveIn(root, path.relative(root, directory)); try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} }
}
export async function extractKernel(archive, dir) {
  if (archive.endsWith('.zip')) return extractZip(archive, { dir });
  const tar = await import('tar'); let bytes = 0, entries = 0, problem = ''; const links = [];
  // tar 的 filter 抛错会冒成未捕获异常（旧实现会直接带栈退出）；这里跳过该条目并留到解压后统一报错。
  await tar.x({ file: archive, cwd: dir, strict: true, preservePaths: false, filter(name, entry) {
    if (problem) return false;
    try {
      resolveIn(dir, name);
      if (++entries > 100000 || (bytes += entry.size || 0) > 2 * MAX || entry.size > 512e6) { problem = '内核解压超过限制'; return false; }
      // macOS 的 .app 必须保留框架内部的相对符号链接；只接受解码后仍落在目录内的链接，
      // 解压完成后再用 realpath 复核一次，防止链式链接逃逸。
      if (entry.type === 'SymbolicLink') {
        const target = String(entry.linkpath || '');
        if (!target || path.isAbsolute(target)) { problem = '内核包含指向目录外的链接'; return false; }
        resolveIn(dir, path.join(path.dirname(name), target));
        links.push(name);
        return true;
      }
      if (!['File', 'Directory', 'OldFile'].includes(entry.type)) { problem = '内核包含链接或特殊文件'; return false; }
      return true;
    } catch (error) { problem = error.message; return false; }
  } });
  if (problem) throw new Error(problem);
  if (!links.length) return;
  const root = fs.realpathSync(dir);
  for (const name of links) {
    let resolved;
    try { resolved = fs.realpathSync(path.resolve(dir, name)); } catch { throw new Error('内核链接无法解析：' + name); }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('内核链接指向目录外：' + name);
  }
}
function findExecutable(dir, requested) {
  if (requested) { const f = resolveIn(dir, requested); if (!fs.statSync(f).isFile()) throw new Error('指定的浏览器程序不存在'); return f; }
  const names = process.platform === 'win32' ? ['chrome.exe', 'chromium.exe', 'msedge.exe'] : process.platform === 'darwin' ? ['Chromium', 'Google Chrome for Testing', 'Google Chrome'] : ['chrome', 'chromium'];
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter(f => names.includes(path.basename(f))).sort((a, b) => a.length - b.length);
  if (!files.length) throw new Error('压缩包内未找到 Chromium 程序，请指定包内可执行文件路径');
  return resolveIn(dir, files[0]);
}
// 官方把不同平台的构建分散在多个 Release（新版本可能只发布 Linux/Windows）。按新到旧找到第一个
// 真正含当前平台文件的版本，避免 macOS 停留在最新 Release 的 Linux/Windows 包上直接失败。
export function selectRelease(releases, options = {}) {
  for (const candidate of releases) {
    const asset = matchAsset(candidate, options);
    if (asset) return { release: candidate, asset };
  }
  if (options.asset) throw new Error('未找到 Release 文件：' + options.asset);
  const names = [...new Set(releases.flatMap(r => archiveAssets(r).map(a => a.name)))];
  throw new Error(names.length
    ? '没有找到支持当前系统的内核文件，请指定 Release 文件名。可选：' + names.join(', ')
    : '没有找到可下载的浏览器 Release，请填写版本标签');
}
export async function downloadGithub(userData, options = {}, progress = () => {}, fetcher = fetch) {
  await requireNormalHost();
  const repository = repositoryName(options.repository), cloak = repository.toLowerCase() === 'cloakhq/cloakbrowser', kind = cloak ? 'cloak' : 'github';
  progress({ phase: 'metadata', source: 'GitHub', got: 0, total: 0 });
  const api = 'https://api.github.com/repos/' + repository + '/releases';
  let list;
  try {
    const data = JSON.parse((await small(api + (options.tag ? '/tags/' + encodeURIComponent(options.tag) : '?per_page=30'), fetcher)).toString());
    list = Array.isArray(data)
      ? data.filter(r => !r.draft && !r.prerelease && (!cloak || /^chromium-v/.test(String(r.tag_name))))
      : [data];
  } catch (e) {
    // 未登录额度用尽（403/429）时改走网页通道，避免用户只能看到“请稍后再试”。
    if (e.status !== 403 && e.status !== 429) throw e;
    progress({ phase: 'metadata', source: 'GitHub 网页', got: 0, total: 0 });
    list = await releasesFromHtml(repository, fetcher, { tag: options.tag });
    if (!list.length) throw new Error(e.message + ' 网页备用通道也没有找到可下载的 Release。');
  }
  const { release, asset } = selectRelease(list, options);
  const url = String(asset.browser_download_url || '');
  if (!url.toLowerCase().startsWith(('https://github.com/' + repository + '/releases/download/').toLowerCase())) throw new Error('只接受该仓库的 GitHub Release 下载地址');
  let expected = options.sha256 || String(asset.digest || '').replace(/^sha256:/, ''), signed = false;
  if (expected && !/^[a-f\d]{64}$/i.test(expected)) throw new Error('SHA-256 格式无效');
  if (cloak) {
    const base = url.slice(0, url.lastIndexOf('/'));
    const manifest = await small(base + '/SHA256SUMS', fetcher), signature = await small(base + '/SHA256SUMS.sig', fetcher);
    expected = verifyCloak(manifest, signature, release.tag_name.replace(/^chromium-v/, ''), asset.name); signed = true;
  }
  const root = path.resolve(userData, 'kernels'); fs.mkdirSync(root, { recursive: true }); resolveIn(root, '.');
  const staging = fs.mkdtempSync(path.join(root, 'install-')), archive = path.join(staging, asset.name.endsWith('.zip') ? 'payload.zip' : 'payload.tar.gz'), unpack = path.join(staging, 'browser'); fs.mkdirSync(unpack);
  try {
    const r = await response(url, fetcher, 600000), total = Number(r.headers.get('content-length')) || asset.size || 0;
    if (total > MAX) throw new Error('内核下载超过 1GB 限制');
    const hash = crypto.createHash('sha256'); let got = 0, last = 0;
    await pipeline(r.body, new Transform({ transform(chunk, _, next) { got += chunk.length; if (got > MAX) return next(new Error('下载超过大小限制')); hash.update(chunk); if (Date.now() - last > 250) { last = Date.now(); progress({ phase: 'download', source: 'GitHub', got, total }); } next(null, chunk); } }), fs.createWriteStream(archive, { flags: 'wx' }));
    const sha256 = hash.digest('hex'); if ((total && got !== total) || (expected && expected.toLowerCase() !== sha256)) throw new Error('内核完整性校验失败');
    progress({ phase: 'extract', source: 'GitHub', got, total }); await extractKernel(archive, unpack);
    const exe = findExecutable(unpack, options.executable); if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    await prepareBrowserDistribution(unpack, staging);
    const folder = kind + '-' + crypto.randomUUID(), relativePath = folder + '/browser/' + path.relative(unpack, exe).split(path.sep).join('/');
    // Keep the previous installation valid until the new complete directory is activated.
    fs.unlinkSync(archive); const target = resolveIn(root, folder); fs.renameSync(staging, target);
    const meta = { kind, repository, version: release.tag_name, asset: asset.name, relativePath, sha256, verified: signed ? 'Ed25519 + SHA-256' : expected ? 'SHA-256' : '已计算 SHA-256', downloadedAt: new Date().toISOString() };
    atomicJson(path.join(root, kind + '.json'), meta); progress({ phase: 'done', got, total }); return { ...meta, path: path.join(root, relativePath) };
  } finally { if (fs.existsSync(staging)) { resolveIn(root, path.relative(root, staging)); fs.rmSync(staging, { recursive: true, force: true }); } }
}
