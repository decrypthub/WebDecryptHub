// 补环境工具：Proxy 缺失访问日志、从指纹报告生成、iterate（跑→列缺失→补丁→重跑）、可选 jsdom
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ENV_BOOT } from './envboot.mjs';

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 从 fingerprint report 生成 env JSON 补丁骨架 */
function fromFingerprint(report) {
  const hits = report.hits || [];
  const nav = {}, screen = {}, extras = {};
  for (const h of hits) {
    if (h.cat === 'navigator' && h.api && h.ret != null) nav[h.api] = coerce(h.ret);
    if (h.cat === 'screen' && h.api && h.ret != null) screen[h.api] = coerce(h.ret);
    if (h.cat === 'timezone' && h.ret) extras.timeZone = h.ret;
  }
  return { navigator: nav, screen, ...extras };
}
function coerce(s) {
  if (s === 'true') return true; if (s === 'false') return false;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.startsWith('[') || s.startsWith('{')) { try { return JSON.parse(s); } catch {} }
  return s;
}

/** 可配置浏览器环境 Proxy：记录每次缺失属性访问 */
function buildEnvProxy(baseEnv = {}, opts = {}) {
  const missing = [];
  const seen = new Set();
  const logMissing = (path) => {
    if (seen.has(path)) return;
    // 忽略噪声
    if (/^(then|toJSON|nodejs|inspect|valueOf|constructor|@@|Symbol)/.test(path.split('.').pop() || '')) return;
    seen.add(path);
    missing.push({ path, t: Date.now() });
  };
  const handler = (name, target) => ({
    get(t, k, r) {
      if (typeof k === 'symbol') return Reflect.get(t, k, r);
      if (!(k in t) && k !== 'then') logMissing(name + '.' + k);
      const v = Reflect.get(t, k, r);
      if (v && typeof v === 'object' && opts.deep) return new Proxy(v, handler(name + '.' + k, v));
      return v;
    },
    has(t, k) {
      if (!(k in t) && typeof k === 'string') logMissing(name + '?' + k);
      return Reflect.has(t, k);
    },
  });
  return { missing, logMissing, handler, seen };
}

async function runWithEnv(code, envCap, opts = {}) {
  const det = buildEnvProxy(envCap, { deep: !!opts.deep });
  const sandbox = {
    console: { log: (...a) => out.push(['log', a.join(' ')]), warn: (...a) => out.push(['warn', a.join(' ')]), error: (...a) => out.push(['error', a.join(' ')]), info() {}, debug() {} },
    out: undefined,
    Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
  };
  const out = [];
  sandbox.console = {
    log: (...a) => out.push(['log', a.map(String).join(' ')]),
    warn: (...a) => out.push(['warn', a.map(String).join(' ')]),
    error: (...a) => out.push(['error', a.map(String).join(' ')]),
    info() {}, debug() {},
  };
  const ctx = vm.createContext(sandbox);
  const boot = `
    var __missing = [];
    var __miss = function(p){ __missing.push(p); };
    (${ENV_BOOT})({ env: ${JSON.stringify(envCap || {})}, url: ${JSON.stringify(opts.url || envCap?.href || 'https://example.com/')}, t0: Date.now(), keep: {}, missing: __miss });
  `;
  vm.runInContext(boot, ctx, { timeout: 5000 });
  // 外层再包一层 window Proxy 捕更深缺失
  vm.runInContext(`
    (function(){
      var _m = __missing;
      function wrap(name, obj){
        if (!obj || typeof obj !== 'object') return obj;
        return new Proxy(obj, { get: function(t,k,r){
          if (typeof k === 'string' && !(k in t) && k !== 'then') _m.push(name+'.'+k);
          return Reflect.get(t,k,r);
        }});
      }
      navigator = wrap('navigator', navigator);
      document = wrap('document', document);
      screen = wrap('screen', screen);
      location = wrap('location', location);
    })();
  `, ctx);
  let result = null, error = null;
  try {
    result = vm.runInContext(code, ctx, { timeout: opts.timeout || 15000 });
    if (result && typeof result.then === 'function') result = await Promise.race([result, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), opts.timeout || 15000))]);
  } catch (e) { error = String(e && e.stack || e.message || e).slice(0, 2000); }
  const missing = vm.runInContext('__missing.slice()', ctx);
  return { result, error, missing, console: out };
}

async function envDetect(a, ctx) {
  let envCap = {};
  if (a.env) {
    const p = path.isAbsolute(a.env) ? a.env : path.join(ctx.projectDir, a.env);
    envCap = loadJson(p);
  }
  if (a.fingerprint) {
    const p = path.isAbsolute(a.fingerprint) ? a.fingerprint : path.join(ctx.projectDir, a.fingerprint);
    Object.assign(envCap, fromFingerprint(loadJson(p)));
  }
  const code = a.code || (a.source ? fs.readFileSync(path.isAbsolute(a.source) ? a.source : path.join(ctx.projectDir, a.source), 'utf8') : '');
  if (!code) return { text: '需要 code 或 source', isError: true };
  const r = await runWithEnv(code, envCap, { url: a.url, timeout: a.timeout || 15000, deep: true });
  const uniq = [...new Set(r.missing)];
  const outFile = path.join(ctx.projectDir, a.outputFile || `env-missing-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ missing: uniq, error: r.error, result: r.result, console: r.console }, null, 2));
  // 自动补丁建议
  const patch = {};
  for (const m of uniq) {
    const [root, ...rest] = m.split('.');
    if (rest.length === 1) {
      patch[root] = patch[root] || {};
      patch[root][rest[0]] = null; // 待填
    }
  }
  const patchFile = path.join(ctx.projectDir, 'env-auto-patch.json');
  fs.writeFileSync(patchFile, JSON.stringify({ ...envCap, ...deepMerge(envCap, patch) }, null, 2));
  return { text: `Env 检测：缺失 ${uniq.length} 项${r.error ? '；错误 ' + r.error.slice(0, 200) : '；ok'}\n缺失：\n` + uniq.slice(0, 40).map(x => '  ' + x).join('\n') + `\n已保存 ${path.relative(ctx.projectDir, outFile)} 与 env-auto-patch.json` };
}

function deepMerge(a, b) {
  const o = { ...a };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) o[k] = deepMerge(a[k] || {}, b[k]);
    else if (!(k in o)) o[k] = b[k];
  }
  return o;
}

async function envIterate(a, ctx) {
  const max = a.rounds || 5;
  let envCap = {};
  if (a.env) envCap = loadJson(path.isAbsolute(a.env) ? a.env : path.join(ctx.projectDir, a.env));
  if (a.fingerprint) Object.assign(envCap, fromFingerprint(loadJson(path.isAbsolute(a.fingerprint) ? a.fingerprint : path.join(ctx.projectDir, a.fingerprint))));
  const code = a.code || fs.readFileSync(path.isAbsolute(a.source) ? a.source : path.join(ctx.projectDir, a.source), 'utf8');
  const history = [];
  for (let i = 0; i < max; i++) {
    const r = await runWithEnv(code, envCap, { url: a.url, timeout: a.timeout || 15000 });
    const uniq = [...new Set(r.missing)];
    history.push({ round: i + 1, missing: uniq.length, error: r.error ? r.error.slice(0, 300) : null, sample: uniq.slice(0, 15) });
    if (!uniq.length && !r.error) {
      const envFile = path.join(ctx.projectDir, a.outputEnv || 'env-iterated.json');
      fs.writeFileSync(envFile, JSON.stringify(envCap, null, 2));
      return { text: `iterate 成功 @ round ${i + 1}。环境已保存 ${path.relative(ctx.projectDir, envFile)}\n` + history.map(h => `  r${h.round}: missing=${h.missing} err=${h.error || '–'}`).join('\n') };
    }
    // 自动填常见默认值
    for (const m of uniq) {
      const parts = m.split('.');
      if (parts.length < 2) continue;
      let cur = envCap;
      for (let j = 0; j < parts.length - 1; j++) {
        if (parts[j].includes('<')) break; // element<...>
        cur[parts[j]] = cur[parts[j]] || {};
        cur = cur[parts[j]];
      }
      const last = parts[parts.length - 1];
      if (cur && typeof cur === 'object' && !(last in cur)) {
        cur[last] = defaultsFor(parts.join('.'));
      }
    }
    if (a.jsdom) {
      try {
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: a.url || envCap.href || 'https://example.com/' });
        envCap._jsdomHint = true;
        // 把 jsdom 的 navigator 摘要合并
        const n = dom.window.navigator;
        envCap.navigator = Object.assign({}, envCap.navigator, {
          userAgent: n.userAgent, platform: n.platform, language: n.language,
          hardwareConcurrency: n.hardwareConcurrency || 8,
        });
      } catch (e) { history[history.length - 1].jsdom = e.message; }
    }
  }
  const envFile = path.join(ctx.projectDir, a.outputEnv || 'env-iterated.json');
  fs.writeFileSync(envFile, JSON.stringify(envCap, null, 2));
  fs.writeFileSync(path.join(ctx.projectDir, 'env-iterate-log.json'), JSON.stringify(history, null, 2));
  return { text: `iterate ${max} 轮结束（仍有缺失或错误）。\n` + history.map(h => `  r${h.round}: missing=${h.missing} err=${h.error || '–'}\n    ${h.sample.join(', ')}`).join('\n') + `\n环境草稿 ${path.relative(ctx.projectDir, envFile)}` };
}

function defaultsFor(path) {
  if (/webdriver$/i.test(path)) return false;
  if (/cookieEnabled|onLine/i.test(path)) return true;
  if (/hardwareConcurrency|deviceMemory|maxTouchPoints/i.test(path)) return 8;
  if (/width|height|avail/i.test(path)) return 1080;
  if (/colorDepth|pixelDepth/i.test(path)) return 24;
  if (/language/i.test(path)) return 'zh-CN';
  if (/platform/i.test(path)) return 'Win32';
  if (/userAgent/i.test(path)) return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  if (/plugins|mimeTypes/i.test(path)) return [];
  return null;
}

async function envFromFp(a, ctx) {
  const p = path.isAbsolute(a.fingerprint) ? a.fingerprint : path.join(ctx.projectDir, a.fingerprint || '');
  if (!a.fingerprint || !fs.existsSync(p)) return { text: '需要 fingerprint JSON', isError: true };
  const patch = fromFingerprint(loadJson(p));
  const out = path.join(ctx.projectDir, a.outputFile || 'env-from-fingerprint.json');
  fs.writeFileSync(out, JSON.stringify(patch, null, 2));
  return { text: `已从指纹报告生成环境：${path.relative(ctx.projectDir, out)}\n` + JSON.stringify(patch, null, 2).slice(0, 1500) };
}

export const ENV_TOOLS = [
  { name: 'env_detect_missing', description: '【补环境检测】在 Node 用 ENV_BOOT+Proxy 跑脚本，列出所有缺失属性访问。可吃 fingerprint JSON / env JSON。', schema: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' }, env: { type: 'string' }, fingerprint: { type: 'string' }, url: { type: 'string' }, outputFile: { type: 'string' }, timeout: { type: 'number' } } }, run: envDetect },
  { name: 'env_iterate', description: '【补环境迭代】跑→列缺失→自动填默认→重跑，最多 rounds 轮。jsdom=true 时尝试合并 jsdom navigator。产出 env-iterated.json。', schema: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' }, env: { type: 'string' }, fingerprint: { type: 'string' }, url: { type: 'string' }, rounds: { type: 'number' }, jsdom: { type: 'boolean' }, outputEnv: { type: 'string' }, timeout: { type: 'number' } } }, run: envIterate },
  { name: 'env_from_fingerprint', description: '从 fingerprint_report JSON 生成 env JSON 补丁。', schema: { type: 'object', properties: { fingerprint: { type: 'string' }, outputFile: { type: 'string' } }, required: ['fingerprint'] }, run: envFromFp },
];
