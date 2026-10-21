import { ENV_BOOT } from './envboot.mjs';
// 本地分析工具（不依赖浏览器）：反混淆、加密特征识别、请求差异、签名参数检测、Node 沙箱、导出代码、笔记
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {RESET_TOOLS} from './resettools.mjs';
import {VM_TOOLS} from './vmtools.mjs';
import {NET_TOOLS} from './nettools.mjs';
import {AST_TOOLS} from './asttools.mjs';
import {FINGERPRINT_TOOLS} from './fingerprint.mjs';
import {VMP_TOOLS} from './vmptrace.mjs';
import {ANTIDEBUG_TOOLS} from './antidebug.mjs';
import {ENV_TOOLS} from './envtools.mjs';
import {WORKSPACE_TOOLS} from './workspace.mjs';

function readMaybeFile(projectDir, s) {
  if (!s) return '';
  if (s.length < 400 && !s.includes('\n')) {
    const p = path.isAbsolute(s) ? s : path.join(projectDir, s);
    try { if (fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8'); } catch {}
  }
  return s;
}

async function deobfuscate({ code, source, outputFile }, ctx) {
  let input = code || '';
  if (!input && source) input = readMaybeFile(ctx.projectDir, source);
  if (!input) throw new Error('需要 code 或 source');
  const { webcrack } = await import('webcrack');
  const res = await webcrack(input, { sandbox: async c => c, jsx: false, unpack: true, deobfuscate: true, mangle: false });
  let result = res.code;
  let note = '';
  if (res.bundle) note = `检测到打包产物，模块数=${Object.keys(res.bundle.modules || {}).length}（如需拆分可用 save 导出）`;
  if (outputFile) { const p = path.join(ctx.projectDir, outputFile); fs.writeFileSync(p, result); return { text: `已反混淆并写入 ${p}（${result.length} 字节）。${note}` }; }
  return { text: `反混淆结果（${result.length} 字节）：\n\`\`\`js\n${result.slice(0, 8000)}${result.length > 8000 ? '\n...(截断，使用 outputFile 保存完整结果)' : ''}\n\`\`\`\n${note}` };
}

function detectCrypto({ code, source }, ctx) {
  let input = code || (source ? readMaybeFile(ctx.projectDir, source) : '');
  if (!input) throw new Error('需要 code 或 source');
  const sigs = [
    ['MD5', /\b(67452301|efcdab89|98badcfe|10325476|d76aa478)\b|['"]md5['"]/i],
    ['SHA-1', /\b(5a827999|6ed9eba1|8f1bbcdc|ca62c1d6)\b|sha1/i],
    ['SHA-256', /\b(6a09e667|bb67ae85|428a2f98|71374491)\b|sha256/i],
    ['AES', /\b(637c777b|52096ad5)\b|['"]aes['"]|sbox|rijndael/i],
    ['DES/3DES', /des\b|tripledes|0x0f0f0f0f/i],
    ['RSA', /rsa|0x10001\b|modpow|bigint|e:\s*65537/i],
    ['Base64', /abcdefghijklmnopqrstuvwxyz0123456789\+\//i],
    ['国密 SM2/3/4', /sm2|sm3|sm4|0x79cc4519|0x7380166f/i],
    ['HMAC', /hmac|0x5c5c|0x3636|ipad|opad/i],
    ['CRC32', /crc32|0xedb88320/i],
    ['RC4', /rc4|identity.{0,20}256/i],
    ['CryptoJS', /CryptoJS/],
    ['jsencrypt', /JSEncrypt|setPublicKey/i],
  ];
  const hits = sigs.filter(([, re]) => re.test(input)).map(([n]) => n);
  const consts = [...input.matchAll(/0x[0-9a-f]{6,8}/gi)].slice(0, 20).map(m => m[0]);
  return { text: `加密特征识别：\n命中算法：${hits.length ? hits.join('、') : '未发现明显标准算法特征（可能是自定义/VM 混淆）'}\n可疑魔数常量（前若干个）：${consts.join(', ') || '无'}` };
}

function diffRequests({ ids, urlPattern }, ctx) {
  let reqs = ctx.browser.requests;
  if (urlPattern) reqs = reqs.filter(r => r.url.includes(urlPattern));
  if (ids && ids.length) reqs = ctx.browser.requests.filter(r => ids.includes(r.id));
  if (reqs.length < 2) throw new Error('至少需要两个匹配请求来对比，请多次触发目标操作');
  const parse = r => {
    const o = {};
    try { const u = new URL(r.url); u.searchParams.forEach((v, k) => (o['query.' + k] = v)); } catch {}
    if (r.postData) {
      try { const j = JSON.parse(r.postData); for (const k in j) o['body.' + k] = typeof j[k] === 'object' ? JSON.stringify(j[k]) : String(j[k]); }
      catch { try { new URLSearchParams(r.postData).forEach((v, k) => (o['form.' + k] = v)); } catch {} }
    }
    return o;
  };
  const parsed = reqs.slice(-5).map(parse);
  const keys = [...new Set(parsed.flatMap(Object.keys))];
  const lines = keys.map(k => {
    const vals = parsed.map(p => p[k]);
    const uniq = new Set(vals);
    return `${uniq.size > 1 ? '🔸变化' : '  固定'} ${k} = ${[...uniq].slice(0, 3).map(v => (v || '').slice(0, 40)).join(' | ')}`;
  });
  return { text: `对比了 ${parsed.length} 个请求（${reqs[0].url.slice(0, 80)}）：\n${lines.join('\n')}\n\n🔸标记的是每次都变化的参数，通常是时间戳/随机数/签名。` };
}

function entropy(s) { const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1; let e = 0; for (const k in f) { const p = f[k] / s.length; e -= p * Math.log2(p); } return e; }

function findSignatureParams({ urlPattern }, ctx) {
  let reqs = ctx.browser.requests.filter(r => ['xhr', 'fetch'].includes(r.type));
  if (urlPattern) reqs = reqs.filter(r => r.url.includes(urlPattern));
  const cand = {};
  const consider = (src, k, v) => {
    v = String(v); const key = src + '.' + k;
    let score = 0;
    if (/^[a-f0-9]{32}$/i.test(v)) score += 5, (cand[key] = (cand[key] || { hints: [] }));
    if (/^[a-f0-9]{40}$/i.test(v)) score += 5;
    if (/^[a-f0-9]{64}$/i.test(v)) score += 5;
    if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(v)) score += 3;
    if (/^\d{10,13}$/.test(v)) score += 2;
    if (v.length >= 24 && v.length < 4000 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v) && entropy(v) > 4) score += 4; // 高熵（JSVMP 输出：x-zse-96、a_bogus、x-s、h5st 等）
    if (/sign|token|sig|secret|hash|nonce|encrypt|_s|ts|timestamp|salt|key/i.test(k)) score += 3;
    if (score > 0) { cand[key] = cand[key] || { hints: [], sample: v, n: 0 }; cand[key].n++; cand[key].sample = v; cand[key].score = Math.max(cand[key].score || 0, score); }
  };
  for (const r of reqs) {
    try { const u = new URL(r.url); u.searchParams.forEach((v, k) => consider('query', k, v)); } catch {}
    if (r.postData) { try { const j = JSON.parse(r.postData); for (const k in j) consider('body', k, j[k]); } catch { try { new URLSearchParams(r.postData).forEach((v, k) => consider('form', k, v)); } catch {} } }
    for (const k in (r.headers || {})) if (/sign|token|auth|sig|nonce|x-/i.test(k)) consider('header', k, r.headers[k]);
  }
  const ranked = Object.entries(cand).sort((a, b) => b[1].score - a[1].score).slice(0, 15);
  if (!ranked.length) return { text: '未发现明显的签名/加密参数。请先在页面上触发接口请求，再重试。' };
  return { text: `疑似签名/加密参数（按可疑度排序）：\n` + ranked.map(([k, v]) => `• ${k}  分值${v.score}  示例=${v.sample.slice(0, 48)}`).join('\n') + `\n\n建议：用 get_request_initiator 找到发起请求的调用栈，或 search_in_sources 搜索参数名定位生成位置。` };
}

function runNode({ code, envPatch, url, env }, ctx) {
  return new Promise((resolve, reject) => {
    const _a=process.argv[1]; const _self=(_a && /\.(mjs|cjs|js)$/.test(_a))?[_a]:[];
    const child = spawn(process.execPath, _self, { env: { ...process.env, JSRA_MODE: 'run-node', JSRA_PROJECT_DIR: ctx.projectDir }, timeout: 60000, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', () => {
      try {
        const j = JSON.parse(out);
        let t = j.ok ? `执行成功。返回值：${j.result}\n` : `执行失败：${j.error}\n`;
        if (j.logs && j.logs.length) t += `console 输出：\n${j.logs.join('\n')}\n`;
        if (j.missing && j.missing.length) {
          const bot = /webdriver|selenium|cdc_|phantom|nightmare|driver|callPhantom|domAutomation|_Selenium|casper|__fx|ubot|spawn|emit|buffer|_resourceLoader|_sessionHistory/i;
          const need = j.missing.filter(k => !bot.test(k)), probes = j.missing.filter(k => bot.test(k));
          if (need.length) t += `\n⚠️ 补环境中被访问但缺失的属性（按需补全，或用 capture_page_env 采集真实值）：\n${need.join(', ')}`;
          if (probes.length) t += `\nℹ️ 自动化/Node 特征探针（真实浏览器中本就不存在，保持缺失即可，不要补）：${probes.join(', ')}`;
        }
        resolve({ text: t });
      } catch { reject(new Error('沙箱返回异常：' + (err || out).slice(0, 500))); }
    });
    child.stdin.write(JSON.stringify({ code, envPatch: !!envPatch, env: env || undefined, url: url || (ctx.browser?.activePage && safe(() => ctx.browser.activePage.url())) }));
    child.stdin.end();
  });
}

// 导出复现代码并实际执行校验：未定义变量/缺 import/自测断言失败都会作为错误返回给模型修正
async function exportCode({ language, algorithm, pseudocode, code, params, notes, outputFile, selfTest, envPatch, env }, ctx) {
  const body = code || pseudocode || '';
  const py = language === 'python';
  const name = (outputFile || `signature.${py ? 'py' : 'js'}`).replace(/[^\w.-]/g, '_');
  const p = path.join(ctx.projectDir, name);
  const c = py ? '#' : '//';
  const content = `${c} 自动生成的签名复现代码（WebDecryptHub）\n${c} 算法: ${algorithm || '未知'}\n${c} 参数: ${params || ''}\n${c} 说明: ${(notes || '').replace(/\n/g, ' ')}\n\n${body}\n` +
    (selfTest ? (py ? `\nif __name__ == "__main__":\n${selfTest.split('\n').map(l => '    ' + l).join('\n')}\n    print("SELFTEST_OK")\n` : `\n;(function(){\n${selfTest}\nconsole.log("SELFTEST_OK");})();\n`) : '');
  fs.writeFileSync(p, content);
  let r;
  if (py) {
    const cmd = process.platform === 'win32' ? 'python' : 'python3';
    r = await new Promise(res => {
      let out = '', err = '';
      let ch; try { ch = spawn(cmd, [p], { cwd: ctx.projectDir, timeout: 20000, windowsHide: true }); } catch (e) { return res({ code: -1, out, err: String(e) }); }
      ch.stdout.on('data', d => (out += d)); ch.stderr.on('data', d => (err += d));
      ch.on('error', e => res({ code: -1, out, err: String(e) })); ch.on('close', code => res({ code, out, err }));
    });
    if (r.code === -1 && /ENOENT/.test(r.err)) return { text: `已导出 python 代码到 ${p}（本机未找到 ${cmd}，未能执行校验）` };
  } else {
    // JS：走与 run_node 相同的自启动沙箱（单文件 sidecar 中 process.execPath 是 sidecar 本身，不能直接执行 .js）
    const _a = process.argv[1]; const _self = (_a && /\.(mjs|cjs|js)$/.test(_a)) ? [_a] : [];
    r = await new Promise(res => {
      let out = '', err = '';
      const ch = spawn(process.execPath, _self, { env: { ...process.env, JSRA_MODE: 'run-node', JSRA_PROJECT_DIR: ctx.projectDir }, timeout: 45000, windowsHide: true });
      ch.stdout.on('data', d => (out += d)); ch.stderr.on('data', d => (err += d));
      ch.on('close', () => { try { const j = JSON.parse(out); res({ code: j.ok ? 0 : 1, out: (j.logs || []).join('\n'), err: j.error || '' }); } catch { res({ code: 1, out: '', err: err || out }); } });
      ch.stdin.end(JSON.stringify({ code: content, envPatch: !!envPatch, env: env || undefined, url: safe(() => ctx.browser.activePage.url()) || undefined }));
    });
  }
  if (r.code === -1 && /ENOENT/.test(r.err)) return { text: `已导出 ${language} 代码到 ${p}（本机未找到 ${cmd}，未能执行校验）` };
  const tail = s => { const l = s.trim().split('\n'); return l.length <= 10 ? l.join('\n') : [...l.slice(0, 3), '…', ...l.slice(-6)].join('\n'); };
  if (r.code !== 0) return { isError: true, text: `已写入 ${p}，但执行失败（退出码 ${r.code}）——导出的代码必须可独立运行（包含 import、常量表、辅助函数）。请修正后重新 export_code：\n${tail(r.err || r.out)}` };
  if (selfTest && !r.out.includes('SELFTEST_OK')) return { isError: true, text: `已写入 ${p}，自测未通过：\n${tail(r.out + '\n' + r.err)}` };
  if (!py && envPatch) { try { writeStandalone(p, content, env, ctx); } catch (e) { /* 独立包装失败不影响主结果 */ } }
  return { text: `已导出 ${language} 代码到 ${p}，并已实际执行${selfTest ? '且自测通过 ✅' : '（未提供 selfTest，建议用抓包样本断言输出一致）'}${r.out.trim() ? '\n输出：' + tail(r.out.replace('SELFTEST_OK', '')) : ''}` };
}

// envPatch 的 JS 导出额外生成 <名>.standalone.cjs：内嵌补环境引导 + 采集的环境，可直接 `node xxx.standalone.cjs` 运行
function writeStandalone(p, content, env, ctx) {
  let capEnv = env || {};
  if (typeof capEnv === 'string') capEnv = JSON.parse(fs.readFileSync(path.resolve(ctx.projectDir, capEnv), 'utf8'));
  const out = p.replace(/\.js$/, '') + '.standalone.cjs';
  const src = `// WebDecryptHub 独立运行包装：node ${path.basename(out)}\n'use strict';\nconst vm = require('vm'), fs = require('fs'), path = require('path');\nconst ENV = ${JSON.stringify(capEnv)};\nconst BOOT = ${JSON.stringify(ENV_BOOT)};\nconst CODE = ${JSON.stringify(content)};\n` +
    `const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, URL, URLSearchParams, Buffer, queueMicrotask, structuredClone, crypto: globalThis.crypto, atob: s => Buffer.from(s, 'base64').toString('latin1'), btoa: s => Buffer.from(String(s), 'latin1').toString('base64'), require: n => require(n), readProjectFile: p => fs.readFileSync(path.resolve(__dirname, p), 'utf8'), module: { exports: {} } };\n` +
    `sb.exports = sb.module.exports; const ctx = vm.createContext(sb); vm.runInContext(BOOT, ctx)({ env: ENV, url: ENV.href, t0: Date.now(), missing: () => {}, keep: { require: 1, module: 1, exports: 1, Buffer: 1, readProjectFile: 1 } });\n` +
    `const prevCwd = process.cwd(); try { process.chdir(__dirname); } catch (e) {}\nvm.runInContext(CODE, ctx, { filename: ${JSON.stringify(path.basename(p))} });\nmodule.exports = sb.module.exports; try { process.chdir(prevCwd); } catch (e) {}\n`;
  fs.writeFileSync(out, src);
  return out;
}

function notesWrite({ content, append }, ctx) {
  const p = path.join(ctx.projectDir, 'findings.md');
  if (append) fs.appendFileSync(p, '\n' + content + '\n'); else fs.writeFileSync(p, content);
  return { text: `已${append ? '追加' : '写入'}分析笔记 ${p}` };
}

function generateReport({ title, content }, ctx) {
  const p = path.join(ctx.projectDir, 'report.md');
  const findings = (() => { try { return fs.readFileSync(path.join(ctx.projectDir, 'findings.md'), 'utf8'); } catch { return ''; } })();
  fs.writeFileSync(p, `# ${title || 'JS 逆向分析报告'}\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n\n${content || ''}\n\n---\n## 过程笔记\n${findings}\n`);
  return { text: `已生成报告 ${p}` };
}

function safe(f) { try { return f(); } catch { return ''; } }

async function injectStatus(a, ctx) {
  const inj = ctx.browser.injector;
  if (!inj) return { text: 'Injector 未初始化', isError: true };
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  const st = await inj.status(page);
  const arm = a.rearm ? await inj.armAll() : null;
  return { text: '注入状态：' + JSON.stringify({ ...st, rearm: arm }, null, 2) };
}
async function injectRearm(a, ctx) {
  const inj = ctx.browser.injector;
  if (!inj) return { text: 'Injector 未初始化', isError: true };
  if (a.name && a.source) inj.register(a.name, a.source);
  const r = await inj.armAll();
  const st = await inj.status();
  return { text: '已重新武装：' + JSON.stringify({ arm: r, status: st }, null, 2) };
}


const LOCAL_TOOLS = [
  { name: 'deobfuscate_code', description: '使用 webcrack+babel 对混淆/压缩 JS 进行反混淆与美化，可拆分 webpack 打包。入参 code 或 source(脚本文件路径)，可选 outputFile 保存。', schema: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' }, outputFile: { type: 'string' } } }, run: deobfuscate },
  { name: 'detect_crypto', description: '识别代码中的加密/哈希算法特征（MD5/SHA/AES/RSA/国密/HMAC/CryptoJS 等）。入参 code 或 source。', schema: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' } } }, run: async (a, c) => detectCrypto(a, c) },
  { name: 'diff_requests', description: '对比多次相同接口请求的参数，找出每次变化的字段（通常是签名/时间戳/随机数）。入参 urlPattern 或 ids 数组。需要先多次触发同一请求。', schema: { type: 'object', properties: { urlPattern: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } } }, run: async (a, c) => diffRequests(a, c) },
  { name: 'find_signature_params', description: '扫描已捕获的 XHR/Fetch 请求，按可疑度列出疑似签名/加密参数（hash 长度、base64、关键词命名等）。入参可选 urlPattern。', schema: { type: 'object', properties: { urlPattern: { type: 'string' } } }, run: async (a, c) => findSignatureParams(a, c) },
  { name: 'run_node', description: '在隔离的 Node 沙箱中运行 JS 代码并返回结果与 console 输出。envPatch=true 时提供 window/document/navigator/localStorage 等浏览器补环境，并报告被访问但缺失的属性，便于迭代补环境。用于复现/验证签名算法。可 require 纯计算模块（crypto/buffer/zlib 等）；可用 require("fs").readFileSync("相对路径") 或 readProjectFile(p) 只读读取项目目录内文件（如 save_script_source 保存的脚本、抓包样本）。', schema: { type: 'object', properties: { code: { type: 'string' }, envPatch: { type: 'boolean' }, env: { type: 'string', description: 'capture_page_env 生成的环境 JSON 文件名（项目目录内），需同时 envPatch=true' }, url: { type: 'string' } }, required: ['code'] }, run: runNode },
  { name: 'export_code', description: '导出签名复现代码到项目目录并实际运行校验。code 必须是可独立运行的完整代码（含 import/常量表/辅助函数，不能是伪代码）。强烈建议提供 selfTest：用抓包得到的真实输入调用函数并 assert 输出等于抓包值；失败会返回报错供修正。language=python|js。', schema: { type: 'object', properties: { language: { type: 'string', enum: ['python', 'js'] }, code: { type: 'string', description: '完整可运行代码' }, selfTest: { type: 'string', description: '自测语句，例如 assert sign(...) == "抓包值"' }, algorithm: { type: 'string' }, params: { type: 'string' }, notes: { type: 'string' }, outputFile: { type: 'string' }, envPatch: { type: 'boolean', description: 'JS 代码需要浏览器补环境（window/document/navigator）时设为 true；同时会生成可直接 node 运行的 .standalone.cjs' }, env: { type: 'string', description: 'capture_page_env 生成的环境 JSON 文件名' }, pseudocode: { type: 'string', description: '兼容旧参数，等同 code' } }, required: ['language'] }, run: async (a, c) => exportCode(a, c) },
  { name: 'notes_write', description: '记录/追加分析发现到 findings.md。append=true 追加。', schema: { type: 'object', properties: { content: { type: 'string' }, append: { type: 'boolean' } }, required: ['content'] }, run: async (a, c) => notesWrite(a, c) },
  { name: 'generate_report', description: '生成最终 Markdown 分析报告 report.md（自动附带 findings.md 内容）。', schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } } }, run: async (a, c) => generateReport(a, c) },
];

const INJECT_TOOLS = [
  { name: 'inject_status', description: '检查页面内持久注入状态（window.__jsra_inject / antiDebug / fingerprint / vmp）。rearm=true 时重新武装所有已登记脚本。', schema: { type: 'object', properties: { rearm: { type: 'boolean' } } }, run: injectStatus },
  { name: 'inject_rearm', description: '重新武装 Injector（Page.addScriptToEvaluateOnNewDocument + context.addInitScript + Target.setAutoAttach）。可选登记 name+source。', schema: { type: 'object', properties: { name: { type: 'string' }, source: { type: 'string' } } }, run: injectRearm },
];
LOCAL_TOOLS.push(...NET_TOOLS, ...AST_TOOLS, ...WORKSPACE_TOOLS, ...ANTIDEBUG_TOOLS, ...VMP_TOOLS, ...FINGERPRINT_TOOLS, ...RESET_TOOLS, ...VM_TOOLS, ...INJECT_TOOLS, ...ENV_TOOLS);
export {LOCAL_TOOLS};
