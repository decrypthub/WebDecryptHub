// AI 工作区：每个会话独立目录，可写脚本、用捆绑 Node 运行、npm install（带镜像回退）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import https from 'node:https';
import http from 'node:http';

const MAX_OUT = 80000;
const DEFAULT_TIMEOUT = 60000;

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
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env, npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

const S = (props, req) => ({ type: 'object', properties: props, ...(req ? { required: req } : {}) });
export const WORKSPACE_TOOLS = [
  { name: 'workspace_list', description: '列出当前会话 AI 工作区（project/workspace/）下的文件树。脚本、npm 包、运行产物都在这里。', schema: S({ path: { type: 'string' }, depth: { type: 'number' }, includeModules: { type: 'boolean' } }), run: wsList },
  { name: 'workspace_write', description: '写入/覆盖工作区内的文件（自动创建目录）。用于保存复现脚本、测试用例、package.json 等。', schema: S({ path: { type: 'string' }, file: { type: 'string' }, content: { type: 'string' } }, ['content']), run: wsWrite },
  { name: 'workspace_read', description: '读取工作区文件内容。', schema: S({ path: { type: 'string' }, file: { type: 'string' }, max: { type: 'number' }, binary: { type: 'boolean' } }), run: wsRead },
  { name: 'workspace_run', description: '用捆绑/系统 Node 在工作区目录运行脚本（file）或表达式（eval）。有超时（默认 60s）与输出截断；cwd 固定为工作区，无法访问工作区外路径。', schema: S({ file: { type: 'string' }, path: { type: 'string' }, eval: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }), run: wsRun },
  { name: 'workspace_npm', description: '在工作区执行 npm install（或 init）。自动尝试配置的 registry → npmmirror 镜像 → npmjs。packages 为包名数组。', schema: S({ packages: { type: 'array', items: { type: 'string' } }, package: { type: 'string' }, command: { type: 'string', enum: ['install', 'init'] }, registry: { type: 'string' }, dev: { type: 'boolean' }, timeoutMs: { type: 'number' } }), run: wsNpm },
];
