// Node 沙箱执行器：独立子进程中运行，支持“补环境”模式并记录缺失的浏览器属性访问
import vm from 'node:vm';
import { createRequire } from 'node:module';
// 允许复现代码常用的纯计算模块；禁止 fs/child_process/net 等有副作用的模块
const SAFE_MODULES = new Set(['crypto', 'buffer', 'util', 'zlib', 'querystring', 'url', 'string_decoder', 'assert', 'events']);
const nodeRequire = createRequire(import.meta.url);
import nodeFs from 'node:fs';
import { ENV_BOOT } from './envboot.mjs';
import nodePath from 'node:path';
// 只读、限定在项目目录内的 fs（读取 save_script_source 保存的大脚本、抓包样本等）
const PROJECT_DIR = process.env.JSRA_PROJECT_DIR ? nodePath.resolve(process.env.JSRA_PROJECT_DIR) : '';
function inProject(p) {
  if (!PROJECT_DIR) throw new Error('沙箱未设置项目目录，无法读取文件');
  const r = nodePath.resolve(PROJECT_DIR, String(p));
  if (r !== PROJECT_DIR && !r.startsWith(PROJECT_DIR + nodePath.sep)) throw new Error(`沙箱只允许读取项目目录内的文件：${p}`);
  return r;
}
const projectFs = Object.freeze({
  readFileSync: (p, o) => nodeFs.readFileSync(inProject(p), o),
  existsSync: p => { try { return nodeFs.existsSync(inProject(p)); } catch { return false; } },
  readdirSync: (p = '.') => nodeFs.readdirSync(inProject(p)),
  statSync: p => nodeFs.statSync(inProject(p)),
  promises: Object.freeze({ readFile: async (p, o) => nodeFs.promises.readFile(inProject(p), o) }),
});
function safeRequire(name) { const n = String(name).replace(/^node:/, ''); if (n === 'fs' || n === 'fs/promises') return n === 'fs' ? projectFs : projectFs.promises; if (!SAFE_MODULES.has(n)) throw new Error(`沙箱禁止 require('${name}')；允许：${[...SAFE_MODULES].join(', ')}，以及只读的 fs（限项目目录）`); return nodeRequire('node:' + n); }
export function runSandboxFromStdin() {
let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', async () => {
  let out = { ok: false }; let logsRef = [];
  try {
    const { code, envPatch, url, env } = JSON.parse(input);
    const logs = []; logsRef = logs;
    const missing = new Set();
    const fmt = a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
    const cons = {
      log: (...a) => logs.push(a.map(fmt).join(' ')),
      info: (...a) => logs.push(a.map(fmt).join(' ')),
      warn: (...a) => logs.push('[warn] ' + a.map(fmt).join(' ')),
      error: (...a) => logs.push('[error] ' + a.map(fmt).join(' ')),
      debug: () => {},
    };
    const sandbox = {
      console: cons, setTimeout, clearTimeout, setInterval, clearInterval,
      TextEncoder, TextDecoder, URL, URLSearchParams, Buffer,
      atob: s => Buffer.from(s, 'base64').toString('latin1'),
      btoa: s => Buffer.from(String(s), 'latin1').toString('base64'),
      crypto: globalThis.crypto, queueMicrotask, structuredClone,
      require: safeRequire, readProjectFile: p => projectFs.readFileSync(p, 'utf8'), PROJECT_DIR,
    };
    sandbox.module = { exports: {} }; sandbox.exports = sandbox.module.exports;
    const ctx = vm.createContext(sandbox);
    if (envPatch) {
      // 采集的页面环境：env 可以是对象，或项目目录内 JSON 文件路径（capture_page_env 的输出）
      let capEnv = env || null;
      if (typeof capEnv === 'string') capEnv = JSON.parse(projectFs.readFileSync(capEnv, 'utf8'));
      const boot = vm.runInContext(ENV_BOOT, ctx, { filename: 'envboot.js' });
      boot({ env: capEnv || {}, url, t0: Date.now(), missing: k => missing.add(k), keep: { require: 1, module: 1, exports: 1, Buffer: 1, readProjectFile: 1, PROJECT_DIR: 1 } });
    }
    let result = vm.runInContext(code, ctx, { timeout: 20000, displayErrors: true });
    if (result && typeof result.then === 'function') result = await Promise.race([result, new Promise((_, rej) => setTimeout(() => rej(new Error('异步结果超时 20s')), 20000))]);
    out = { ok: true, result: fmt(result), logs, missing: [...missing] };
  } catch (e) {
    out = { ok: false, error: String(e && e.message ? e.message + '\n' + String(e.stack || '').split('\n').slice(0, 4).join('\n') : e), logs: logsRef, missing: [] };
  }
  process.stdout.write(JSON.stringify(out));
});
}
