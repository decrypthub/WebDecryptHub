// 面向 JSVMP / 强混淆站点的“先在页面调用原函数，再抽离”工具链（直接走 CDP 主世界，不占用内核工具锁）
//   hook_signer        在页面主世界挂钩 XHR/fetch/Headers，记录目标参数被写入时的值与 JS 调用栈（可选刷新以覆盖首屏请求）
//   get_hook_records   读取挂钩记录（值、URL、去重后的调用栈帧：脚本 URL:行:列 + 函数名）
//   page_call          在页面主世界执行表达式/调用原函数（黑盒对拍：同输入同输出），返回 JSON
//   webpack_expose     捕获 webpack 的 __webpack_require__ 到 window.__jsra_wreq，可按模块 id 调用原模块
//   webpack_extract    从页面递归抽取模块及依赖，生成可在 run_node 中独立运行的 bundle 文件
import fs from 'node:fs';
import path from 'node:path';

async function mainEval(page, expression, { timeout = 30000 } = {}) {
  if (!page) throw new Error('浏览器未打开');
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout, allowUnsafeEvalBlockedByCSP: true });
    if (r.exceptionDetails) { const d = r.exceptionDetails; throw new Error('页面执行异常: ' + (d.exception?.description || d.text || JSON.stringify(d)).slice(0, 1500)); }
    return r.result.value;
  } finally { await cdp.detach().catch(() => {}); }
}
const clip = (s, n) => (s = typeof s === 'string' ? s : JSON.stringify(s, null, 1) ?? String(s), s.length > n ? s.slice(0, n) + `\n…(截断，原长 ${s.length})` : s);

function hookSource(names) {
  return `(() => {
  const NAMES = ${JSON.stringify(names.map(n => n.toLowerCase()))};
  const W = window; W.__jsraHooks = W.__jsraHooks || []; W.__jsraHookNames = NAMES;
  if (W.__jsraHooked) return 'already';
  W.__jsraHooked = true;
  const want = k => (W.__jsraHookNames || []).includes(String(k).toLowerCase());
  const rec = (kind, name, value, url) => { try { const st = new Error().stack.split('\\n').slice(2, 40).join('\\n'); W.__jsraHooks.push({ t: Date.now(), kind, name, value: String(value).slice(0, 2000), url: String(url || '').slice(0, 500), stack: st }); if (W.__jsraHooks.length > 300) W.__jsraHooks.splice(0, 100); } catch (e) {} };
  const qp = (u, kind) => { try { const x = new URL(u, location.href); for (const [k, v] of x.searchParams) if (want(k)) rec(kind, k, v, x.href); } catch (e) {} };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.setRequestHeader, XB = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__jsraUrl = u; qp(u, 'xhr.url'); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (want(k)) rec('xhr.header', k, v, this.__jsraUrl); return XS.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { try { if (typeof b === 'string') for (const n of W.__jsraHookNames) if (b.toLowerCase().includes(n)) rec('xhr.body', n, b, this.__jsraUrl); } catch (e) {} return XB.apply(this, arguments); };
  const HS = Headers.prototype.set, HA = Headers.prototype.append;
  Headers.prototype.set = function (k, v) { if (want(k)) rec('headers.set', k, v); return HS.apply(this, arguments); };
  Headers.prototype.append = function (k, v) { if (want(k)) rec('headers.append', k, v); return HA.apply(this, arguments); };
  const F = W.fetch;
  if (F) W.fetch = function (input, init) { try { const u = typeof input === 'string' ? input : input && input.url; qp(u, 'fetch.url'); const h = init && init.headers; if (h) { const it = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h); for (const [k, v] of it) if (want(k)) rec('fetch.header', k, v, u); } } catch (e) {} return F.apply(this, arguments); };
  return 'installed';
})()`;
}

function parseStack(stack) {
  return String(stack || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/);
    return m ? { fn: m[1] || '(匿名)', url: m[2], line: +m[3], col: +m[4] } : { raw: l };
  });
}

async function hookSigner({ names, reload = true, waitMs = 6000 }, ctx) {
  const page = ctx.browser.activePage; if (!page) return { text: '浏览器未打开', isError: true };
  if (!names?.length) return { text: '需要 names：目标参数名数组（请求头名或 URL 参数名），如 ["x-zse-96"]', isError: true };
  const src = hookSource(names);
  const cdp = await page.context().newCDPSession(page);
  try {
    if (ctx.browser.__hookScriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: ctx.browser.__hookScriptId }).catch(() => {});
    const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src, runImmediately: true });
    ctx.browser.__hookScriptId = r.identifier;
  } finally { await cdp.detach().catch(() => {}); }
  const now = await mainEval(page, src).catch(e => 'err:' + e.message);
  if (reload) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await new Promise(r => setTimeout(r, waitMs)); }
  const n = await mainEval(page, '(window.__jsraHooks||[]).length').catch(() => 0);
  return { text: `已挂钩参数 ${JSON.stringify(names)}（当前页：${now}；后续导航自动生效）。${reload ? '已刷新页面，' : ''}当前记录 ${n} 条。用 get_hook_records 查看值与调用栈；若为 0，请在页面触发目标操作后再查看。` };
}

async function getHookRecords({ name, limit = 8, clear }, ctx) {
  const page = ctx.browser.activePage; if (!page) return { text: '浏览器未打开', isError: true };
  let recs = await mainEval(page, `(window.__jsraHooks||[])`) || [];
  if (clear) await mainEval(page, 'window.__jsraHooks=[]');
  if (name) recs = recs.filter(r => r.name.toLowerCase() === String(name).toLowerCase());
  if (!recs.length) return { text: '暂无挂钩记录。先调用 hook_signer，并在页面触发目标请求。' };
  const out = recs.slice(-limit).map((r, i) => {
    const frames = parseStack(r.stack).filter(f => f.url && !/^(native|<anonymous>)/.test(f.url)).slice(0, 14);
    return `#${i + 1} [${r.kind}] ${r.name} = ${r.value.slice(0, 200)}\n  url: ${r.url}\n  调用栈（由近到远）:\n` + frames.map(f => `    ${f.fn}  ${f.url}:${f.line}:${f.col}`).join('\n');
  });
  return { text: `共 ${recs.length} 条记录，显示最近 ${out.length} 条：\n\n` + out.join('\n\n') + `\n\n提示：栈顶附近（排除挂钩自身）即签名写入点；用 get_script_source(url, 行列附近 offset) 或 search_in_sources 精读；然后用 page_call 在页面直接调用该函数对拍。` };
}

async function pageCall({ expression, timeoutMs = 30000 }, ctx) {
  const page = ctx.browser.activePage; if (!page) return { text: '浏览器未打开', isError: true };
  if (!expression) return { text: '需要 expression', isError: true };
  const wrapped = `(async () => { const __r = await (async () => (${expression}))(); try { return JSON.parse(JSON.stringify(__r === undefined ? null : __r)); } catch (e) { return String(__r); } })()`;
  try { const v = await mainEval(page, wrapped, { timeout: timeoutMs }); return { text: '返回值：\n' + clip(v, 8000) }; }
  catch (e) {
    // 表达式可能是语句块，退回直接执行
    try { const v = await mainEval(page, expression, { timeout: timeoutMs }); return { text: '返回值：\n' + clip(v, 8000) }; }
    catch (e2) { return { text: String(e2.message || e2), isError: true }; }
  }
}

const EXPOSE = `(() => {
  const W = window;
  if (W.__jsra_wreq) return { ok: true, cached: true, modules: Object.keys(W.__jsra_wreq.m || {}).length };
  const keys = Object.getOwnPropertyNames(W).filter(k => /^webpack(Chunk|Jsonp)/i.test(k) && W[k] && typeof W[k].push === 'function');
  for (const k of keys) {
    let req = null; const id = 'jsra' + Date.now() + Math.random();
    try { W[k].push([[id], {}, r => { req = r; }]); } catch (e) {}
    if (!req) { try { const mid = id + 'm'; W[k].push([[id + 'b'], { [mid]: (m, e, r) => { req = r; } }, [[mid]]]); } catch (e) {} }
    if (req && req.m) { W.__jsra_wreq = req; return { ok: true, chunkVar: k, modules: Object.keys(req.m).length, cacheKeys: Object.keys(req.c || {}).length }; }
  }
  return { ok: false, chunkVars: keys, hint: '未发现 webpack 运行时；可能是 vite/rollup 或非模块化脚本，请改用 hook_signer 定位全局函数后 page_call 调用' };
})()`;

async function webpackExpose({ search }, ctx) {
  const page = ctx.browser.activePage; if (!page) return { text: '浏览器未打开', isError: true };
  const r = await mainEval(page, EXPOSE);
  let text = '结果：' + JSON.stringify(r);
  if (r?.ok && search) {
    const hits = await mainEval(page, `(() => { const q = ${JSON.stringify(search)}; const m = window.__jsra_wreq.m; const out = []; for (const id in m) { const s = m[id].toString(); const i = s.indexOf(q); if (i >= 0) out.push({ id, len: s.length, ctx: s.slice(Math.max(0, i - 120), i + 160) }); if (out.length >= 12) break; } return out; })()`);
    text += `\n包含「${search}」的模块（最多 12 个）：\n` + hits.map(h => `• 模块 ${h.id}（${h.len} 字符）：…${h.ctx}…`).join('\n');
  }
  if (r?.ok) text += `\n\n用法：page_call 中可直接 window.__jsra_wreq("<模块id>") 取得模块导出并调用原函数对拍；确认后用 webpack_extract 抽取为本地可运行 bundle。`;
  return { text };
}

async function webpackExtract({ ids, outputFile = 'extracted_bundle.js', maxModules = 600 }, ctx) {
  const page = ctx.browser.activePage; if (!page) return { text: '浏览器未打开', isError: true };
  if (!ids?.length) return { text: '需要 ids：入口模块 id 数组', isError: true };
  const ok = await mainEval(page, EXPOSE);
  if (!ok?.ok) return { text: '无法捕获 webpack 运行时：' + JSON.stringify(ok), isError: true };
  const res = await mainEval(page, `(() => {
    const m = window.__jsra_wreq.m; const seen = new Map(); const queue = ${JSON.stringify(ids.map(String))}; const missing = [];
    while (queue.length && seen.size < ${Number(maxModules) || 600}) {
      const id = queue.shift(); if (seen.has(id)) continue;
      const f = m[id]; if (!f) { missing.push(id); continue; }
      const src = f.toString(); seen.set(id, src);
      const pm = src.match(/^(?:function\\s*[\\w$]*)?\\s*\\(([^)]*)\\)/) || src.match(/^([\\w$]+)\\s*=>/);
      const params = pm ? pm[1].split(',').map(s => s.trim()) : [];
      const rq = params[2] || params[0];
      if (rq) { const re = new RegExp('(?<![\\\\w$.])' + rq.replace(/\\$/g, '\\\\$') + '\\\\(\\\\s*(?:(\\\\d+)|"([^"]+)"|\\'([^\\']+)\\')\\\\s*\\\\)', 'g'); let x; while ((x = re.exec(src))) { const d = x[1] || x[2] || x[3]; if (!seen.has(d)) queue.push(d); } }
    }
    const helpers = {}; for (const k of Object.keys(window.__jsra_wreq)) { const v = window.__jsra_wreq[k]; if (typeof v === 'function' && k.length <= 3) { try { helpers[k] = v.toString(); } catch (e) {} } }
    return { modules: [...seen.entries()], missing, helpers, truncated: queue.length > 0 };
  })()`);
  const lines = [
    `// WebDecryptHub webpack_extract：从 ${safeUrl(page)} 抽取的 ${res.modules.length} 个模块（入口 ${ids.join(', ')}）`,
    '// 用法（run_node，envPatch=true）：eval(require("fs").readFileSync("' + outputFile + '","utf8")); const mod = __jsra_req("<id>");',
    'var __jsra_modules = {',
    ...res.modules.map(([id, src]) => `${JSON.stringify(id)}: (${src}),`),
    '};',
    'var __jsra_cache = {};',
    'function __jsra_req(id) { id = String(id); if (__jsra_cache[id]) return __jsra_cache[id].exports; var f = __jsra_modules[id]; if (!f) throw new Error("模块未抽取: " + id); var mod = __jsra_cache[id] = { id: id, loaded: false, exports: {} }; f.call(mod.exports, mod, mod.exports, __jsra_req); mod.loaded = true; return mod.exports; }',
    '__jsra_req.m = __jsra_modules; __jsra_req.c = __jsra_cache; __jsra_req.g = globalThis;',
    '__jsra_req.o = function (o, p) { return Object.prototype.hasOwnProperty.call(o, p); };',
    '__jsra_req.d = function (e, d) { for (var k in d) if (__jsra_req.o(d, k) && !__jsra_req.o(e, k)) Object.defineProperty(e, k, { enumerable: true, get: d[k] }); };',
    '__jsra_req.r = function (e) { if (typeof Symbol !== "undefined" && Symbol.toStringTag) Object.defineProperty(e, Symbol.toStringTag, { value: "Module" }); Object.defineProperty(e, "__esModule", { value: true }); };',
    '__jsra_req.n = function (m) { var g = m && m.__esModule ? function () { return m["default"]; } : function () { return m; }; __jsra_req.d(g, { a: g }); return g; };',
    '__jsra_req.t = function (v, mode) { if (mode & 1) v = __jsra_req(v); return v; };',
    '__jsra_req.nmd = function (m) { m.paths = []; if (!m.children) m.children = []; return m; }; __jsra_req.hmd = __jsra_req.nmd;',
    '__jsra_req.e = function () { return Promise.resolve(); }; __jsra_req.p = "";',
    '// 页面中的其它运行时辅助（原样，如依赖闭包可能需手动修补）：',
    ...Object.entries(res.helpers).filter(([k]) => !['o', 'd', 'r', 'n', 't', 'nmd', 'hmd', 'e', 'g', 'p', 'm', 'c'].includes(k)).map(([k, s]) => `try { __jsra_req[${JSON.stringify(k)}] = (${s}); } catch (e) {}`),
    'if (typeof module !== "undefined" && module.exports) module.exports = __jsra_req;',
    'globalThis.__jsra_req = __jsra_req;',
  ];
  const out = path.resolve(ctx.projectDir, outputFile);
  if (!out.startsWith(ctx.projectDir)) return { text: '输出路径必须在项目目录内', isError: true };
  fs.writeFileSync(out, lines.join('\n'));
  return { text: `已抽取 ${res.modules.length} 个模块 → ${outputFile}（${fs.statSync(out).size} 字节）。${res.missing.length ? '缺失模块：' + res.missing.join(',') + '（可能是异步 chunk 尚未加载，先在页面触发相关功能再抽取）' : '依赖完整'}${res.truncated ? '；已达 maxModules 上限，依赖未完全展开' : ''}。\n下一步：run_node(envPatch=true) 中 eval 该文件后调用 __jsra_req(入口id)，用与 page_call 相同的输入对拍，输出必须逐字节一致。` };
}
function safeUrl(p) { try { return p.url(); } catch { return ''; } }

// 采集真实页面环境（navigator/location/cookie/screen/storage + 指定全局变量），写入项目目录 JSON，供 run_node/export_code 的 env 参数注入
async function capturePageEnv({ globals = [], outputFile }, ctx) {
  const page = ctx.browser?.activePage;
  const expr = `(() => {
    const safeClone = (v, d = 0) => { if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v; if (d > 6) return undefined; if (Array.isArray(v)) return v.slice(0, 2000).map(x => safeClone(x, d + 1)); const o = {}; let n = 0; for (const k of Object.keys(v)) { if (n++ > 500) break; try { const c = safeClone(v[k], d + 1); if (c !== undefined) o[k] = c; } catch (e) {} } return o; };
    const nav = {}; for (const k of ['userAgent','platform','language','languages','vendor','vendorSub','product','productSub','appName','appCodeName','appVersion','webdriver','hardwareConcurrency','deviceMemory','maxTouchPoints','cookieEnabled','doNotTrack','onLine']) { try { nav[k] = safeClone(navigator[k]); } catch (e) {} }
    const ls = {}; try { for (let i = 0; i < localStorage.length && i < 200; i++) { const k = localStorage.key(i); const v = localStorage.getItem(k); if (v && v.length < 4000) ls[k] = v; } } catch (e) {}
    const ss = {}; try { for (let i = 0; i < sessionStorage.length && i < 200; i++) { const k = sessionStorage.key(i); const v = sessionStorage.getItem(k); if (v && v.length < 4000) ss[k] = v; } } catch (e) {}
    const g = {}; for (const name of ${JSON.stringify(globals)}) { try { if (name in window) g[name] = safeClone(window[name]); } catch (e) {} }
    return { href: location.href, ua: navigator.userAgent, navigator: nav, cookie: document.cookie, referrer: document.referrer, title: document.title,
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth },
      historyLength: history.length, localStorage: ls, sessionStorage: ss, globals: g,
      suspiciousGlobals: Object.keys(window).filter(k => /^(__|_[A-Z$]|\\$)/.test(k) && !/^__(jsra|REACT|VUE)/i.test(k)).slice(0, 80) };
  })()`;
  const env = await mainEval(page, expr);
  const name = (outputFile || `page-env-${(() => { try { return new URL(env.href).hostname; } catch { return 'page'; } })()}.json`).replace(/[^\w.-]/g, '_');
  fs.writeFileSync(path.join(ctx.projectDir, name), JSON.stringify(env, null, 1));
  const gsum = Object.keys(env.globals).map(k => k + '(' + JSON.stringify(env.globals[k] ?? null).length + 'B)').join(', ') || '无';
  return { text: `已采集页面环境 → ${name}\nURL: ${env.href}\nUA: ${env.ua}\ncookie ${env.cookie.length} 字节；localStorage ${Object.keys(env.localStorage).length} 项；注入全局变量: ${gsum}\n页面上其它可疑全局变量（可再次调用并加入 globals）：${env.suspiciousGlobals.join(', ') || '无'}\n用法：run_node({ envPatch: true, env: "${name}", code }) / export_code({ envPatch: true, env: "${name}", ... })。若页面内 eval 抽离代码能通过服务器校验而 Node 不能，说明是环境差异：对比 missing 列表与页面真实值逐项补齐。` };
}

export const VM_TOOLS = [
  { name: 'capture_page_env', description: '采集当前页面真实环境（navigator/UA/location/cookie/screen/localStorage/sessionStorage + 指定的全局变量如 __ZH__、_bdata）保存为项目内 JSON。之后 run_node/export_code 传 env: "<文件名>" 注入沙箱，解决抽离代码在 Node 中因环境差异签名被服务器拒绝（403）的问题。', schema: { type: 'object', properties: { globals: { type: 'array', items: { type: 'string' }, description: '要一并采集的 window 全局变量名' }, outputFile: { type: 'string' } } }, run: capturePageEnv },
  { name: 'hook_signer', description: '【VM/混淆站点首选】在页面主世界挂钩 XHR/fetch/Headers，记录目标参数（请求头或 URL 参数）被写入时的值与完整 JS 调用栈；默认刷新页面以覆盖首屏请求。比搜源码更快定位 JSVMP 签名入口。', schema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: '参数名，如 ["x-zse-96"]、["a_bogus"]、["x-s","x-t"]、["h5st"]' }, reload: { type: 'boolean' }, waitMs: { type: 'number' } }, required: ['names'] }, run: hookSigner },
  { name: 'get_hook_records', description: '读取 hook_signer 记录：参数值、请求 URL、调用栈（函数名 脚本URL:行:列）。可按 name 过滤，clear=true 读取后清空。', schema: { type: 'object', properties: { name: { type: 'string' }, limit: { type: 'number' }, clear: { type: 'boolean' } } }, run: getHookRecords },
  { name: 'page_call', description: '在页面主世界执行 JS 表达式（可 await），用于直接调用页面原函数做黑盒对拍，例如 window.__jsra_wreq("123").default("abc")、window.byted_acrawler.frontierSign(...)、new ParamsSign({...}).sign(...)。返回 JSON。', schema: { type: 'object', properties: { expression: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['expression'] }, run: pageCall },
  { name: 'webpack_expose', description: '捕获页面 webpack 运行时 __webpack_require__ 到 window.__jsra_wreq，返回模块数；可选 search 在全部模块源码中搜索关键字（如 "x-zse-96"）返回模块 id 与上下文。', schema: { type: 'object', properties: { search: { type: 'string' } } }, run: webpackExpose },
  { name: 'webpack_extract', description: '从页面递归抽取 webpack 模块及其依赖，生成可在 run_node 中独立运行的 bundle（含最小 webpack 运行时，导出 __jsra_req）。用于把已在页面对拍通过的原函数“抽离”到本地。', schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, outputFile: { type: 'string' }, maxModules: { type: 'number' } }, required: ['ids'] }, run: webpackExtract },
];
