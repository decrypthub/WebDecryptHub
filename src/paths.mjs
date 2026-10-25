// 路径约束的唯一实现。
//
// 以前每个工具各写一遍「解析到项目目录内」：有的用 startsWith 不带分隔符
// （C:\proj 会接受 C:\proj2），有的干脆接受绝对路径（等于没有约束）。
// 这里收成一个函数，所有碰文件的工具都走它。
import fs from 'node:fs';
import path from 'node:path';

export const pathKey = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
export function containsPath(root, target) {
  const rel = path.relative(pathKey(root), pathKey(target));
  return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Windows 路径大小写不敏感：统一小写再比，避免「大小写不同 → 被误判越界」。
// 这只会让判断更宽松到正确的程度，不会让真正越界的路径通过。
const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * 把 rel 解析到 root 之内；越界抛错（错误信息直接回给模型看）。
 * 绝对路径也接受——只要它确实落在 root 里。
 * @param {string} root 允许访问的根目录
 * @param {string} rel  相对路径（或落在 root 内的绝对路径）
 * @param {{label?:string}} [opts]
 */
export function resolveIn(root, rel, { label = '项目目录' } = {}) {
  if (!root) throw new Error('未设置工作目录');
  const raw = String(rel ?? '.');
  if (raw.includes('\0') || /^(?:\\\\[?.]\\|\/\/\?\/)/.test(raw)) throw new Error('不支持的设备路径');
  if (process.platform === 'win32' && /:/.test(raw.replace(/^[a-z]:/i, ''))) throw new Error('不支持 NTFS 数据流路径');
  const base = path.resolve(String(root));
  const target = path.resolve(base, String(rel ?? '.'));
  const nb = norm(base), nt = norm(target);
  if (nt !== nb && !nt.startsWith(nb + path.sep)) {
    throw new Error(`路径越界：只能访问${label}内的文件（收到 ${rel}）。请用相对路径。`);
  }
  let cursor = base;
  for (const part of ['', ...path.relative(base, target).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    let st; try { st = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) throw new Error(`路径包含符号链接或目录联接，已拒绝：${cursor}`);
  }
  return target;
}

/** 不抛错的版本，越界返回 null（用于「存在才读」的场景） */
export function tryResolveIn(root, rel, opts) {
  try { return resolveIn(root, rel, opts); } catch { return null; }
}

export function isSensitivePath(file) {
  return String(file).replace(/\\/g, '/').split('/').some(n => /^(?:\.ssh|\.aws|\.azure|\.gnupg|\.wdh|\.agent-state\.json|\.agent-history\.json|\.npmrc|\.pypirc|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(n)
    || (/^\.env(?:\.|$)/i.test(n) && !/^\.env\.(?:example|sample|template)$/i.test(n)) || /\.(?:pem|p12|pfx|key)$/i.test(n));
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp', fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
