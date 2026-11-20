import fs from 'node:fs';
import path from 'node:path';
import { resolveIn } from './paths.mjs';
// "从头再来"工具：清理 Cookie / 站点存储 / 缓存 / 已捕获请求，或用全新隔离 Profile 重启浏览器。
// 目的：避免旧登录态、风控标记、缓存的密钥等污染签名分析与 A/B 对比。
const STORAGE_TYPES = 'cookies,local_storage,indexeddb,websql,service_workers,cache_storage,file_systems,shader_cache,storage_buckets';

function originsOf(page) {
  const set = new Set();
  for (const f of page.frames()) { try { const u = new URL(f.url()); if (/^https?:$/.test(u.protocol)) set.add(u.origin); } catch {} }
  return [...set];
}
// 粗略的可注册域：IP/localhost 原样；常见二级后缀（com.cn 等）取后三段
function registrable(host) {
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const p = host.split('.');
  return (p.length >= 3 && /^(com|net|org|gov|edu|co|ac)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

async function resetSession(a, ctx) {
  const { scope = 'site', cookies = true, storage = true, cache = false, requests = true, reload = true, confirm } = a || {};
  if (confirm !== true) return { text: '[需要确认] reset_session 会不可逆地删除 Cookie/站点存储。确认后请以 confirm=true 再调用。', isError: true };
  const b = ctx.browser; const page = b.activePage;
  if (!page) return { text: '浏览器未打开', isError: true };
  const done = [];
  const cdp = await page.context().newCDPSession(page);
  try {
    const origins = originsOf(page);
    if (scope === 'all') {
      if (cookies) { await cdp.send('Network.clearBrowserCookies'); done.push('全部 Cookie（所有站点）'); }
      if (storage) { for (const o of origins) await cdp.send('Storage.clearDataForOrigin', { origin: o, storageTypes: STORAGE_TYPES.replace('cookies,', '') }).catch(() => {}); done.push(`站点存储 ${origins.length} 个源`); }
    } else {
      // 站点级：当前页所有 frame 源 + 同一注册域下的 Cookie（含 HttpOnly/Secure，经浏览器上下文删除）
      if (cookies) {
        const roots = new Set(origins.map(o => registrable(new URL(o).hostname)));
        const all = await page.context().cookies();
        const victims = all.filter(c => roots.has(registrable(c.domain.replace(/^\./, ''))));
        for (const r of roots) await page.context().clearCookies({ domain: new RegExp('(^|\\.)' + r.replace(/\./g, '\\.') + '$') });
        done.push(`站点 Cookie ${victims.length} 个（域：${[...roots].join(', ')}）`);
      }
      if (storage) {
        for (const o of origins) await cdp.send('Storage.clearDataForOrigin', { origin: o, storageTypes: STORAGE_TYPES.replace('cookies,', '') }).catch(() => {});
        done.push(`localStorage/IndexedDB/CacheStorage/ServiceWorker 等（${origins.length} 个源：${origins.slice(0, 5).join(', ')}${origins.length > 5 ? '…' : ''}）`);
      }
    }
    if (storage) {
      let n = 0; for (const f of page.frames()) { try { await f.evaluate(() => { try { sessionStorage.clear(); } catch {} }); n++; } catch {} }
      done.push(`sessionStorage（${n} 个 frame）`);
    }
    if (cache) { await cdp.send('Network.clearBrowserCache'); done.push('浏览器 HTTP 缓存（全局）'); }
  } finally { await cdp.detach().catch(() => {}); }
  if (requests) {
    const n = b.requests.length; b.clearRequests(); done.push(`应用已捕获请求 ${n} 条`);
    if (ctx.mcp?.has?.('clear_network_requests')) { const r = await ctx.mcp.call('clear_network_requests', { confirm: true }).catch(e => ({ text: e.message, isError: true })); done.push('内核请求记录' + (r.isError ? '（失败：' + String(r.text).slice(0, 80) + '）' : '')); }
  }
  // 验证
  try {
    const left = await page.context().cookies(originsOf(page));
    const ls = await page.evaluate(() => { try { return localStorage.length + '/' + sessionStorage.length; } catch { return '?'; } });
    done.push(`验证：当前页剩余 Cookie ${left.length} 个，localStorage/sessionStorage 条目 ${ls}`);
  } catch {}
  if (reload) { await b.reload(); await new Promise(r => setTimeout(r, 3000)); done.push(`已刷新页面，重新捕获请求 ${b.requests.length} 条`); }
  return { text: '已重置会话：\n- ' + done.join('\n- ') + '\n提示：之前拿到的 scriptId/reqid 已失效，请重新 list_network_requests / list_scripts。' };
}

async function getCookies(a, ctx) {
  const page = ctx.browser.activePage; if (!page) return { text: '浏览器未打开', isError: true };
  const urls = a?.url ? [a.url] : originsOf(page);
  const list = await page.context().cookies(urls);
  const filt = a?.name ? list.filter(c => c.name.includes(a.name)) : list;
  if (!filt.length) return { text: `无 Cookie（范围：${urls.join(', ')}）` };
  return { text: `Cookie ${filt.length} 个（范围：${urls.slice(0, 4).join(', ')}）：\n` + filt.map(c => `${c.name}=${String(c.value).slice(0, 80)}${c.value.length > 80 ? '…' : ''}  [${c.domain}${c.path}${c.httpOnly ? ' HttpOnly' : ''}${c.secure ? ' Secure' : ''}${c.expires > 0 ? ' 过期:' + new Date(c.expires * 1000).toISOString().slice(0, 10) : ' 会话'}]`).join('\n') };
}

async function restartFresh(a, ctx) {
  if (a?.confirm !== true) return { text: '[需要确认] restart_browser_fresh 会关闭当前浏览器并用全新的临时 Profile（无任何 Cookie/存储/缓存/登录）重启。确认后请以 confirm=true 再调用。', isError: true };
  if (!ctx.relaunch) return { text: '当前环境不支持重启浏览器', isError: true };
  const url = a.url || ctx.browser.activePage?.url();
  const r = await ctx.relaunch({ isolated: true, url });
  return { text: `已用全新隔离 Profile 重启浏览器${url ? '并打开 ' + url : ''}（Profile: ${r.profileDir}）。已捕获请求 ${r.requests} 条。所有旧 reqid/scriptId 均已失效。` };
}

export const RESET_TOOLS = [
  { name: 'reset_session', description: '「从头再来」：一次性清理当前站点或所有站点的 Cookie/存储/缓存/已捕获请求，默认随后刷新页面重新抓包。用于重新触发签名请求前、复现失败怀疑被旧状态或缓存密钥干扰时、A/B 对比有/无登录态时。安全模式下由应用向用户弹出确认，不要自行填写 confirm 代替用户。',
    schema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: '必须为 true 才执行；这一步应由用户确认，不要自己填。' },
        scope: { type: 'string', enum: ['site', 'all'], description: '清理范围：site 只清当前页面涉及的站点（默认），all 清全部站点。' },
        cookies: { type: 'boolean', description: '是否清 Cookie（含 HttpOnly/Secure），默认 true。' },
        storage: { type: 'boolean', description: '是否清 localStorage/IndexedDB/CacheStorage/ServiceWorker/sessionStorage，默认 true。' },
        cache: { type: 'boolean', description: '是否清浏览器全局 HTTP 缓存，默认 false（影响其他站点，较慢）。' },
        requests: { type: 'boolean', description: '是否清空已捕获请求，默认 true。' },
        reload: { type: 'boolean', description: '清理后是否刷新页面重新抓包，默认 true。' },
      },
      required: ['confirm'],
    }, run: resetSession },
  { name: 'restart_browser_fresh', description: '关闭浏览器并用全新的临时隔离 Profile 重启（完全干净：无 Cookie/存储/缓存/扩展状态）。比 reset_session 更彻底，用于怀疑设备指纹或风控标记残留、需要首次访问行为时。安全模式下由应用向用户弹出确认，不要自行填写 confirm 代替用户。',
    schema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: '必须为 true 才执行；这一步应由用户确认，不要自己填。' },
        url: { type: 'string', description: '重启后要打开的网址；省略则停在空白页。' },
      },
      required: ['confirm'],
    }, run: restartFresh },
  { name: 'get_cookies', description: '只读：列出 Cookie（含 HttpOnly/Secure/过期）。用于确认签名密钥是否来自 Cookie、对比清理前后差异。',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '只取匹配该网址的 Cookie；省略则取当前页面。' },
        name: { type: 'string', description: '只取该名称的 Cookie。' },
      },
    }, run: getCookies },
];

// —— 本地文件检索：对 save_script_source 落盘的大脚本做搜索/切片，不占用浏览器 ——
function resolveInProject(projectDir, f) {
  const p = resolveIn(projectDir, f || '');
  if (!fs.existsSync(p)) { const cand = fs.readdirSync(projectDir, { recursive: true }).filter(x => String(x).endsWith(path.basename(f || ''))).slice(0, 5); throw new Error(`文件不存在：${f}${cand.length ? '；项目内相近文件：' + cand.join(', ') : ''}`); }
  return p;
}
async function grepFile(a, ctx) {
  const p = resolveInProject(ctx.projectDir, a.file);
  const text = fs.readFileSync(p, 'utf8');
  // context 是 token 炸弹的入口：模型常写 context:800/900，一次 4 处命中就是 7KB 进上下文。
  // 默认给一眼能认出的窗口即可，精读交给 read_file_slice；另设单次返回总量上限。
  const ctxLen = Math.max(0, Math.min(a.context ?? 120, 400)), max = Math.min(a.maxResults ?? 10, 50);
  const BUDGET = 6000;
  let re; try { re = a.regex ? new RegExp(a.pattern, 'g') : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch (e) { return { text: '正则无效：' + e.message, isError: true }; }
  const hits = []; let m, total = 0, used = 0, cut = false;
  while ((m = re.exec(text))) {
    total++;
    if (hits.length < max) {
      const snippet = text.slice(Math.max(0, m.index - ctxLen), m.index + m[0].length + ctxLen);
      if (used + snippet.length > BUDGET) { cut = true; } else { hits.push({ offset: m.index, snippet }); used += snippet.length; }
    }
    if (m[0] === '') re.lastIndex++;
    if (total > 5000) break;
  }
  if (!total) return { text: `在 ${path.basename(p)}（${text.length} 字符）中未找到 ${a.pattern}` };
  const tail = cut ? `\n（已达单次返回上限，剩下的用 read_file_slice(offset) 精读；想要更大窗口就调小 context）` : '';
  return { text: `在 ${path.basename(p)}（${text.length} 字符）中找到 ${total} 处，显示前 ${hits.length} 处（offset 可配合 read_file_slice 精读）：\n` + hits.map(h => `--- offset ${h.offset} ---\n${h.snippet}`).join('\n') + tail };
}
async function readSlice(a, ctx) {
  const p = resolveInProject(ctx.projectDir, a.file);
  const text = fs.readFileSync(p, 'utf8');
  const want = a.length ?? 3000;
  const off = Math.max(0, a.offset | 0), len = Math.min(want, 12000);
  const end = Math.min(text.length, off + len);
  // 被截断时必须说清下一步，否则调用方只知道"没读完"却不知道该怎么办。
  const notes = [];
  if (want > 12000) notes.push(`单次上限 12000 字符（请求 ${want}）`);
  if (end < text.length) notes.push(`文件共 ${text.length} 字符，用 offset=${end} 继续读`);
  const tail = notes.length ? `\n\n[未读完] ${notes.join('；')}。` : '';
  return { text: `${path.basename(p)} [${off}, ${end}) / ${text.length}：\n${text.slice(off, off + len)}${tail}` };
}
function listFiles(a, ctx) {
  const files = fs.readdirSync(ctx.projectDir, { recursive: true }).map(String).filter(f => { try { return fs.statSync(path.join(ctx.projectDir, f)).isFile(); } catch { return false; } });
  return { text: `项目目录 ${ctx.projectDir} 共 ${files.length} 个文件：\n` + files.slice(0, 200).map(f => `${f}  (${fs.statSync(path.join(ctx.projectDir, f)).size} B)`).join('\n') };
}
RESET_TOOLS.push(
  { name: 'grep_file', description: '在项目目录内已落盘的文件（如 save_script_source 保存的大脚本、反混淆结果）中搜索关键字或正则。不占用浏览器，适合页面卡顿/超时或脚本数 MB 的情况。', schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '相对项目目录的文件路径。' },
      pattern: { type: 'string', description: '要搜索的关键字；regex 为 true 时按正则解释。' },
      regex: { type: 'boolean', description: 'true 把 pattern 当正则，默认 false 按字面量匹配。' },
      context: { type: 'number', description: '每处命中前后各取多少字符，默认 120，上限 400。调大容易撑爆返回。' },
      maxResults: { type: 'number', description: '最多返回几处命中，默认 10，上限 50。' },
    },
    required: ['file', 'pattern'],
  }, run: grepFile },
  { name: 'read_file_slice', description: '按字符偏移读取项目目录内文件的一段，配合 grep_file 拿到的 offset 精读函数实现。', schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '相对项目目录的文件路径。' },
      offset: { type: 'number', description: '起始字符偏移，通常来自 grep_file 返回的 offset。' },
      length: { type: 'number', description: '读取长度，默认 3000，上限 12000；要更多就调大 offset 分次读。' },
    },
    required: ['file', 'offset'],
  }, run: readSlice },
  { name: 'list_project_files', description: '列出项目目录内已保存的文件（脚本、反混淆结果、导出代码、笔记），含体积。不确定文件叫什么名字时先用这个。', schema: { type: 'object', properties: {} }, run: listFiles },
);
