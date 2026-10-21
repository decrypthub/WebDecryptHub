// 按 pid 结束进程树。Windows 用 taskkill /PID /T /F，只动这一棵树，不按映像名全局结束。
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

function normalizeExe(p, platform) {
  let s = String(p || '').replace(/\0/g, '').trim().replace(/^"+|"+$/g, '').replace(/ \(deleted\)$/, '');
  if (platform === 'win32') s = s.replace(/\//g, '\\').replace(/^\\\\\?\\/, '');
  if (!s) return '';
  try { s = fs.realpathSync(s); } catch {}
  if (platform === 'win32') s = s.replace(/\//g, '\\').replace(/^\\\\\?\\/, '').toLowerCase();
  return s;
}

/** 进程映像是不是这次启动时交给 Patchright 的那个 Chrome。空路径、别的 chrome.exe、node 都不算。 */
export function sameExecutable(imagePath, expectedExe, platform = process.platform) {
  const image = normalizeExe(imagePath, platform);
  const expected = normalizeExe(expectedExe, platform);
  return !!image && !!expected && image === expected;
}

function commandMentionsDir(commandLine, dir, platform) {
  if (!commandLine || !dir) return false;
  const norm = (s) => {
    let v = String(s).replace(/\0/g, ' ');
    if (platform === 'win32') v = v.replace(/\//g, '\\').toLowerCase();
    return v;
  };
  const folder = norm(dir).replace(/[\\/]+$/, '');
  return folder.length > 2 && norm(commandLine).includes(folder);
}

/**
 * 关闭超时后仍要结束进程时的确认：映像必须是本次启动的 Chrome，
 * 命令行还必须带这次的用户数据目录，避免 PID 被用户自己的 Chrome 或 node 复用。
 */
export function isLaunchedChrome(identity, { exe, profileDir, platform = process.platform } = {}) {
  if (!identity || !sameExecutable(identity.image, exe, platform)) return false;
  return commandMentionsDir(identity.commandLine, profileDir, platform);
}

/** 读取 pid 的映像路径和命令行。读不到就返回空，调用方不得据此结束进程。 */
export function readProcessIdentity(pid, platform = process.platform) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { image: '', commandLine: '' };
  try {
    if (platform === 'linux') {
      const image = fs.readlinkSync(`/proc/${n}/exe`);
      const commandLine = fs.readFileSync(`/proc/${n}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
      return { image, commandLine };
    }
    if (platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if ($p) { @{ ExecutablePath = $p.ExecutablePath; CommandLine = $p.CommandLine } | ConvertTo-Json -Compress }`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      const parsed = JSON.parse(String(out || '').trim() || '{}');
      return { image: parsed.ExecutablePath || '', commandLine: parsed.CommandLine || '' };
    }
  } catch {}
  return { image: '', commandLine: '' };
}

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
