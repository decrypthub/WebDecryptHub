// 运行时资源定位与自修复：sidecar 是 bun 单文件 exe，不能依赖构建机路径。
// patchright-core 在运行时需要其 package 目录（lib/ 下的少量资源）。查找顺序：
//   1. JSRA_RES_DIR 环境变量  2. <exe 目录>/resources/patchright-core  3. <exe 目录>/patchright-core
//   4. <用户数据>/runtime/patchright-core-<ver>（若都不存在，从 exe 内嵌的压缩包自动解压到这里 = 首次运行自修复）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PW_VER = globalThis.__JSRA_PW_VERSION || 'dev';
export const exeDir = path.dirname(process.execPath);
const isCompiled = !/^(bun|node)(\.exe)?$/i.test(path.basename(process.execPath));

function valid(dir) { try { return fs.statSync(path.join(dir, 'package.json')).isFile() && fs.statSync(path.join(dir, 'lib')).isDirectory(); } catch { return false; } }

function dataDir() {
  const base = process.platform === 'win32' ? (process.env.APPDATA || os.homedir()) : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'WebDecryptHub');
}

export const runtimeInfo = { pwDir: null, source: null, repaired: false, error: null, compiled: isCompiled };

export async function ensurePatchrightResources() {
  if (!isCompiled) { runtimeInfo.source = 'dev(node_modules)'; return runtimeInfo; }
  const cands = [process.env.JSRA_RES_DIR && path.join(process.env.JSRA_RES_DIR, 'patchright-core'), path.join(exeDir, 'resources', 'patchright-core'), path.join(exeDir, 'patchright-core')].filter(Boolean);
  for (const c of cands) if (valid(c)) { set(c, '安装目录'); return runtimeInfo; }
  const target = path.join(dataDir(), 'runtime', 'patchright-core-' + PW_VER);
  if (valid(target)) { set(target, '用户数据目录'); return runtimeInfo; }
  try {
    const emb = globalThis.__JSRA_PW_ZIP;
    if (!emb) throw new Error('exe 内未嵌入资源包');
    const tmp = path.join(os.tmpdir(), 'jsra-pw-' + process.pid + '.zip');
    fs.writeFileSync(tmp, Buffer.from(await Bun.file(emb).arrayBuffer()));
    const part = target + '.part';
    fs.rmSync(part, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true });
    const extract = (await import('extract-zip')).default;
    await extract(tmp, { dir: part });
    fs.rmSync(tmp, { force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(part, target);
    runtimeInfo.repaired = true; set(target, '自动修复(内嵌资源)');
  } catch (e) {
    runtimeInfo.error = '运行资源缺失且自动修复失败：' + e.message;
    // 仍设置一个目录，避免回落到构建机路径；package.json/browsers.json 已在构建时内联，常规启动 Chrome 不受影响
    set(path.join(exeDir, 'resources', 'patchright-core'), '缺失');
  }
  return runtimeInfo;
}
function set(dir, source) { runtimeInfo.pwDir = dir; runtimeInfo.source = source; globalThis.__JSRA_PW_LIB = path.join(dir, 'lib', '_'); }
