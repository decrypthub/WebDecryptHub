// 按 pid 结束进程树。Windows 用 taskkill /PID /T /F，只动这一棵树，不按映像名全局结束。
import { spawnSync } from 'node:child_process';

export function killTreeArgs(pid, platform = process.platform) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (platform === 'win32') return { file: 'taskkill', args: ['/PID', String(n), '/T', '/F'] };
  return { signalGroup: true, pid: n };
}

export function killPidTree(pid, platform = process.platform) {
  const spec = killTreeArgs(pid, platform);
  if (!spec) return;
  if (spec.signalGroup) {
    try { process.kill(-spec.pid, 'SIGKILL'); }
    catch { try { process.kill(spec.pid, 'SIGKILL'); } catch {} }
    return;
  }
  try { spawnSync(spec.file, spec.args, { windowsHide: true, timeout: 8000 }); } catch {}
}
