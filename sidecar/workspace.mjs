// AI 工作区：每个会话独立目录，可写脚本、用捆绑 Node 运行、npm install（带镜像回退）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import https from 'node:https';
import http from 'node:http';

const MAX_OUT = 80000;
const DEFAULT_TIMEOUT = 60000;
const SHELL_TIMEOUT_MAX = 120000;
const JOB_TIMEOUT_MAX = 10 * 60 * 1000;
const buckets = new Map();

const SECRET_RE = /(API_KEY|SECRET|PASSWORD|ACCESS_TOKEN|AUTH_TOKEN|CREDENTIAL|_TOKEN)$/i;

// 子进程环境：永不传入 WDH_LLM_API_KEY，并去掉常见密钥变量
export function childEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v == null) continue;
    if (k === 'WDH_LLM_API_KEY' || k === 'JSRA_OPENAI_KEY') continue;
    if (SECRET_RE.test(k)) continue;
    env[k] = String(v);
  }
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  delete env.WDH_LLM_API_KEY;
  return env;
}

function wsDir(ctx) {
  const d = path.join(ctx.projectDir, 'workspace');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function safePath(root, rel) {
  const p = path.resolve(root, rel || '.');
  if (!p.startsWith(path.resolve(root))) throw new Error('路径越界：只能访问工作区目录');
  return p;
}
function findNode() {
  // 1) 环境变量 2) 捆绑的 node（resources/node/）3) 系统 node
  if (process.env.JSRA_NODE) return process.env.JSRA_NODE;
  const here = path.dirname(new URL(import.meta.url).pathname);
  const bundled = [
    path.join(here, 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    path.join(here, '..', 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    path.join(here, '..', '..', 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
  ];
  for (const c of bundled) { try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {} }
  // process.execPath 在 sidecar 编译体里是自身，不能用来跑用户脚本
  const self = process.execPath || '';
  if (/node(\.exe)?$/i.test(self) && !/sidecar/i.test(self)) return self;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}
function run(cmd, args, { cwd, timeout = DEFAULT_TIMEOUT, env } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: childEnv({ ...process.env, ...env }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ code: -1, out, err: err + '\n[超时 ' + timeout + 'ms]' }); }, timeout);
    child.stdout.on('data', d => { out += d; if (out.length > MAX_OUT) out = out.slice(-MAX_OUT); });
    child.stderr.on('data', d => { err += d; if (err.length > MAX_OUT) err = err.slice(-MAX_OUT); });
    child.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message) }); });
  });
}

async function wsWrite(a, ctx) {
  const root = wsDir(ctx);
  const p = safePath(root, a.path || a.file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, a.content ?? '');
  return { text: `已写入 ${path.relative(root, p)}（${Buffer.byteLength(a.content ?? '')} 字节）` };
}
async function wsRead(a, ctx) {
  const root = wsDir(ctx);
  const p = safePath(root, a.path || a.file);
  const buf = fs.readFileSync(p);
  const text = a.binary ? buf.toString('base64') : buf.toString('utf8');
  return { text: `文件 ${path.relative(root, p)}（${buf.length} 字节）${a.binary ? ' [base64]' : ''}：\n` + text.slice(0, a.max || 30000) + (text.length > (a.max || 30000) ? '\n…(截断)' : '') };
}
async function wsList(a, ctx) {
  const root = wsDir(ctx);
  const base = safePath(root, a.path || '.');
  const out = [];
  function walk(d, depth) {
    if (depth > (a.depth ?? 3)) return;
    for (const name of fs.readdirSync(d).sort()) {
      if (name === 'node_modules' && !a.includeModules) { out.push(path.relative(root, path.join(d, name)) + '/  (省略)'); continue; }
      const p = path.join(d, name); const st = fs.statSync(p);
      out.push((st.isDirectory() ? name + '/' : name) + (st.isFile() ? `  ${st.size}B` : ''));
      if (st.isDirectory() && name !== 'node_modules') walk(p, depth + 1);
    }
  }
  if (fs.existsSync(base)) walk(base, 0);
  return { text: out.length ? `工作区 ${path.relative(ctx.projectDir, root) || 'workspace'}/：\n` + out.map(x => '  ' + x).join('\n') : '工作区为空。用 workspace_write 创建脚本。' };
}
async function wsRun(a, ctx) {
  const root = wsDir(ctx);
  const node = findNode();
  const entry = a.file || a.path || 'index.js';
  const args = a.eval ? ['-e', a.eval] : [safePath(root, entry), ...(a.args || [])];
  if (!a.eval) { /* file mode */ } else { args; }
  const r = await run(node, a.eval ? ['-e', a.eval] : [path.relative(root, safePath(root, entry)), ...(a.args || [])], { cwd: root, timeout: a.timeoutMs || DEFAULT_TIMEOUT });
  return { text: `node ${a.eval ? '-e …' : entry} → exit ${r.code}\n` + (r.out || '') + (r.err ? '\n[stderr]\n' + r.err : ''), isError: r.code !== 0 };
}
async function wsNpm(a, ctx) {
  const root = wsDir(ctx);
  const node = findNode();
  // npm 可能与 node 同目录，或系统 npm
  const npmCandidates = [path.join(path.dirname(node), process.platform === 'win32' ? 'npm.cmd' : 'npm'), 'npm'];
  let npm = 'npm'; for (const c of npmCandidates) { try { if (c === 'npm' || fs.existsSync(c)) { npm = c; break; } } catch {} }
  const pkgs = a.packages || (a.package ? [a.package] : []);
  const args = a.command === 'init' ? ['init', '-y'] : ['install', ...pkgs, ...(a.dev ? ['--save-dev'] : [])];
  const registries = [
    a.registry,
    process.env.JSRA_NPM_REGISTRY,
    'https://registry.npmmirror.com',
    'https://registry.npmjs.org',
  ].filter(Boolean);
  let last = null;
  for (const reg of registries) {
    const r = await run(npm, [...args, '--registry', reg], { cwd: root, timeout: a.timeoutMs || 180000, env: { npm_config_registry: reg } });
    last = r;
    if (r.code === 0) return { text: `npm ${args.join(' ')} @ ${reg} → ok\n` + (r.out || r.err).slice(-4000) };
  }
  return { text: `npm 失败：\n` + (last?.err || last?.out || ''), isError: true };
}

function lineNo(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
function findAll(text, needle) {
  const at = [];
  if (!needle) return at;
  let i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) { at.push(i); i += needle.length; }
  return at;
}
function nearby(text, oldStr) {
  const first = String(oldStr).split('\n')[0].trim().slice(0, 80);
  const lines = text.split('\n');
  let i = first ? lines.findIndex(l => l.includes(first.slice(0, 40))) : 0;
  if (i < 0) return '文件中连首行片段都未出现。文件开头：\n' + text.slice(0, 500);
  const from = Math.max(0, i - 2), to = Math.min(lines.length, i + 4);
  return lines.slice(from, to).map((l, n) => `${from + n + 1}|${l}`).join('\n');
}

export function workspaceFileSize(projectDir, rel) {
  try {
    const root = path.join(projectDir, 'workspace');
    if (!fs.existsSync(root)) return 0;
    const p = safePath(root, rel || '');
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return 0;
    return fs.statSync(p).size;
  } catch { return 0; }
}

export function editWorkspace(projectDir, a) {
  try {
    const root = wsDir({ projectDir });
    const rel = a?.path || a?.file;
    if (!rel) return { text: '需要 path', isError: true };
    const oldStr = a.old_string != null ? String(a.old_string) : (a.old != null ? String(a.old) : '');
    const newStr = a.new_string != null ? String(a.new_string) : (a.new != null ? String(a.new) : null);
    if (!oldStr) return { text: 'old_string 不能为空。请给出要替换的原文（须与文件中的片段完全一致，含空格与换行）。', isError: true };
    if (newStr == null) return { text: '需要 new_string', isError: true };
    if (oldStr === newStr) return { text: 'old_string 与 new_string 相同，没有改动。', isError: true };
    const p = safePath(root, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { text: `文件不存在：${rel}`, isError: true };
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes('\0')) return { text: '该文件像是二进制，不能用 workspace_edit。', isError: true };
    const replaceAll = !!(a.replace_all ?? a.replaceAll);
    const at = findAll(text, oldStr);
    if (!at.length) return { text: `未找到与 old_string 完全一致的片段。请对照下面的上下文后重试：\n${nearby(text, oldStr)}`, isError: true };
    if (!replaceAll && at.length !== 1) {
      const lines = at.slice(0, 8).map(i => lineNo(text, i));
      return { text: `old_string 匹配了 ${at.length} 处（约在第 ${lines.join('、')} 行），不是唯一匹配。请加长上下文使其唯一，或设置 replace_all=true。`, isError: true };
    }
    const next = replaceAll ? text.split(oldStr).join(newStr) : text.slice(0, at[0]) + newStr + text.slice(at[0] + oldStr.length);
    fs.writeFileSync(p, next);
    return { text: `已替换 ${path.relative(root, p)}：${replaceAll ? at.length + ' 处' : '1 处'}` };
  } catch (e) { return { text: String(e.message || e), isError: true }; }
}

function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^(?:' + re + ')$', 'i');
}
function matchGlob(rel, glob) {
  if (!glob) return true;
  const n = rel.replace(/\\/g, '/');
  if (globToRegExp(glob).test(n)) return true;
  if (!String(glob).includes('/')) return globToRegExp('**/' + glob).test(n);
  return false;
}

export function grepWorkspace(projectDir, a) {
  try {
    const root = wsDir({ projectDir });
    const pattern = a?.pattern;
    if (!pattern) return { text: '需要 pattern', isError: true };
    const source = a.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    let re;
    try { re = new RegExp(source, a.ignoreCase ? 'i' : ''); } catch (e) { return { text: '正则无效：' + e.message, isError: true }; }
    const base = safePath(root, a.path || '.');
    if (!fs.existsSync(base)) return { text: '路径不存在：' + (a.path || '.'), isError: true };
    const hits = [];
    const max = Math.min(200, Math.max(1, a.max || 80));
    const scan = (file) => {
      if (hits.length >= max) return;
      let st; try { st = fs.statSync(file); } catch { return; }
      if (!st.isFile() || st.size > 1500000) return;
      const rel = path.relative(root, file);
      if (!matchGlob(rel, a.glob)) return;
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      if (text.slice(0, 8000).includes('\0')) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 240)}`);
      }
    };
    const walk = (d, depth) => {
      if (hits.length >= max || depth > 8) return;
      let names; try { names = fs.readdirSync(d); } catch { return; }
      for (const name of names.sort()) {
        if (hits.length >= max) return;
        if (name === 'node_modules' && !a.includeModules) continue;
        const p = path.join(d, name);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (name !== 'node_modules' || a.includeModules) walk(p, depth + 1); }
        else scan(p);
      }
    };
    if (fs.statSync(base).isDirectory()) walk(base, 0); else scan(base);
    return { text: hits.length ? `匹配 ${hits.length} 处${hits.length >= max ? '（已截断）' : ''}：\n` + hits.join('\n') : '无匹配' };
  } catch (e) { return { text: String(e.message || e), isError: true }; }
}

function shellBin() {
  if (process.platform === 'win32') return { cmd: process.env.ComSpec || 'cmd.exe', argsPrefix: ['/d', '/s', '/c'] };
  return { cmd: '/bin/sh', argsPrefix: ['-c'] };
}
function bucket(projectDir) {
  const root = wsDir({ projectDir });
  let b = buckets.get(root);
  if (!b) { b = { jobs: new Map(), seq: 0 }; buckets.set(root, b); }
  return { root, b };
}
function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill();
  } catch { try { child.kill('SIGKILL'); } catch {} }
}
function jobText(job) {
  const state = job.code == null ? 'running' : (job.killed || job.signal ? `killed${job.signal ? ' ' + job.signal : ''}` : `exit ${job.code}`) + (job.timedOut ? ' timeout' : '');
  const body = (job.out || '') + (job.err ? (job.out ? '\n' : '') + '[stderr]\n' + job.err : '');
  return `job ${job.id} ${state} pid=${job.pid || '-'}\n${body}`.slice(0, MAX_OUT);
}
function armJob(job, child, timeoutMs, signal) {
  const cap = (prev, d) => { const s = prev + d.toString(); return s.length > MAX_OUT ? s.slice(-MAX_OUT) : s; };
  child.stdout?.on('data', d => { job.out = cap(job.out, d); });
  child.stderr?.on('data', d => { job.err = cap(job.err, d); });
  const stop = () => { job.killed = true; killTree(child); };
  const timer = setTimeout(() => { job.timedOut = true; stop(); }, timeoutMs);
  const onAbort = () => stop();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const finish = (code, sig) => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    if (job.code == null) job.code = code == null ? (sig ? -1 : 0) : code;
    if (sig) job.signal = sig;
    job.ended = Date.now();
  };
  child.on('close', finish);
  child.on('error', e => { job.err += String(e.message || e); finish(-1, null); });
}

export function shellWorkspace(projectDir, a, signal) {
  try {
    const cmd = String(a?.cmd || a?.command || '').trim();
    if (!cmd) return { text: '需要 cmd', isError: true };
    if (cmd.length > 20000) return { text: '命令过长', isError: true };
    const { root, b } = bucket(projectDir);
    const background = !!a?.background;
    const requested = Number(a?.timeoutMs) || (background ? JOB_TIMEOUT_MAX : DEFAULT_TIMEOUT);
    const timeoutMs = background ? Math.min(JOB_TIMEOUT_MAX, Math.max(1000, requested)) : Math.min(SHELL_TIMEOUT_MAX, Math.max(1000, requested));
    const sh = shellBin();
    const child = spawn(sh.cmd, [...sh.argsPrefix, cmd], {
      cwd: root,
      env: childEnv(process.env),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const id = 'j' + (++b.seq);
    const job = { id, cmd, child, pid: child.pid, out: '', err: '', code: null, signal: null, killed: false, timedOut: false, started: Date.now() };
    b.jobs.set(id, job);
    if (b.jobs.size > 30) { for (const [k, v] of b.jobs) if (v.code != null && k !== id) { b.jobs.delete(k); if (b.jobs.size <= 20) break; } }
    armJob(job, child, timeoutMs, signal);
    if (!background) {
      return new Promise(resolve => {
        let settled = false;
        const done = () => { if (settled) return; settled = true; resolve({ text: jobText(job), isError: job.code !== 0 }); };
        if (job.code != null) done();
        else { child.on('close', done); child.on('error', () => setTimeout(done, 0)); }
      });
    }
    return { text: `已在后台启动 id=${id} pid=${child.pid || '-'}\n用 workspace_job_output 查看输出，workspace_job_kill 结束。命令：${cmd.slice(0, 180)}` };
  } catch (e) { return { text: String(e.message || e), isError: true }; }
}

export function jobOutput(projectDir, a) {
  const { b } = bucket(projectDir);
  const job = b.jobs.get(String(a?.id || ''));
  if (!job) return { text: '没有这个后台任务：' + (a?.id || ''), isError: true };
  const offset = Math.max(0, a?.offset | 0);
  const full = jobText(job);
  const slice = full.slice(offset, offset + 20000);
  return { text: `offset=${offset} next=${offset + slice.length} total=${full.length}\n` + slice };
}

export function jobKill(projectDir, a) {
  const { b } = bucket(projectDir);
  const job = b.jobs.get(String(a?.id || ''));
  if (!job) return { text: '没有这个后台任务：' + (a?.id || ''), isError: true };
  if (job.code != null) return { text: `任务 ${job.id} 已经结束（${job.signal ? 'killed ' + job.signal : 'exit ' + job.code}）` };
  job.killed = true;
  killTree(job.child);
  return { text: `已结束任务 ${job.id}` };
}

export function killAllJobs(projectDir) {
  try {
    const root = path.join(projectDir, 'workspace');
    const b = buckets.get(root);
    if (!b) return;
    for (const job of b.jobs.values()) if (job.code == null) { job.killed = true; killTree(job.child); }
  } catch {}
}

const S = (props, req) => ({ type: 'object', properties: props, ...(req ? { required: req } : {}) });
export const WORKSPACE_TOOLS = [
  { name: 'workspace_list', description: '列出当前会话 AI 工作区（project/workspace/）下的文件树。脚本、npm 包、运行产物都在这里。', schema: S({ path: { type: 'string' }, depth: { type: 'number' }, includeModules: { type: 'boolean' } }), run: wsList },
  { name: 'workspace_write', description: '写入/覆盖工作区内的文件（自动创建目录）。用于保存复现脚本、测试用例、package.json 等。覆盖已有的较大文件（≥8KB）时，安全模式会请用户在界面确认。', schema: S({ path: { type: 'string' }, file: { type: 'string' }, content: { type: 'string' } }, ['content']), run: wsWrite },
  { name: 'workspace_read', description: '读取工作区文件内容。', schema: S({ path: { type: 'string' }, file: { type: 'string' }, max: { type: 'number' }, binary: { type: 'boolean' } }), run: wsRead },
  { name: 'workspace_edit', description: '精确替换工作区文件中的一段文本。old_string 必须与文件内容完全一致；默认只能匹配一处，否则失败并返回行号，可设 replace_all=true 替换全部。改长脚本时优先用它，不要整文件重写。', schema: S({ path: { type: 'string' }, file: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']), run: (a, ctx) => editWorkspace(ctx.projectDir, a) },
  { name: 'workspace_grep', description: '在工作区文件中搜索。pattern 为正则（literal=true 时按原文）；可用 path 限定目录、glob 过滤文件名（如 *.js）。跳过 node_modules。', schema: S({ pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, literal: { type: 'boolean' }, ignoreCase: { type: 'boolean' }, max: { type: 'number' }, includeModules: { type: 'boolean' } }, ['pattern']), run: (a, ctx) => grepWorkspace(ctx.projectDir, a) },
  { name: 'workspace_run', description: '用捆绑/系统 Node 在工作区目录运行脚本（file）或表达式（eval）。有超时（默认 60s）与输出截断；cwd 固定为工作区。不会把 WDH_LLM_API_KEY 传给子进程。', schema: S({ file: { type: 'string' }, path: { type: 'string' }, eval: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }), run: wsRun },
  { name: 'workspace_npm', description: '在工作区执行 npm install（或 init）。自动尝试配置的 registry → npmmirror 镜像 → npmjs。packages 为包名数组。安全模式下 install 会请用户在界面确认。', schema: S({ packages: { type: 'array', items: { type: 'string' } }, package: { type: 'string' }, command: { type: 'string', enum: ['install', 'init'] }, registry: { type: 'string' }, dev: { type: 'boolean' }, timeoutMs: { type: 'number' } }), run: wsNpm },
  { name: 'workspace_shell', description: '在会话工作区运行 shell（cwd 固定为工作区）。timeoutMs 默认 30s、最长 120s。background=true 时立即返回 id，再用 workspace_job_output 读取、workspace_job_kill 结束（后台最长约 10 分钟）。不会把 WDH_LLM_API_KEY 等密钥传给子进程。安全模式下需用户在界面确认，不要自行传 confirm。', schema: S({ cmd: { type: 'string' }, timeoutMs: { type: 'number' }, background: { type: 'boolean' } }, ['cmd']), run: (a, ctx) => shellWorkspace(ctx.projectDir, a, ctx.signal) },
  { name: 'workspace_job_output', description: '读取 workspace_shell 后台任务的输出。id 为启动时返回的任务 id，offset 可增量读取。', schema: S({ id: { type: 'string' }, offset: { type: 'number' } }, ['id']), run: (a, ctx) => jobOutput(ctx.projectDir, a) },
  { name: 'workspace_job_kill', description: '结束 workspace_shell 启动的后台任务。安全模式下与 shell 一样需要用户确认。', schema: S({ id: { type: 'string' } }, ['id']), run: (a, ctx) => jobKill(ctx.projectDir, a) },
];
