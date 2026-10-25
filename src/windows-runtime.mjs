// Windows executable integrity is independent of the user's token/DACL.
// Only trusted build outputs and verified browser distributions are provisioned.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveIn, containsPath } from './paths.mjs';
const exec = promisify(execFile);
const systemTool = name => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
const processOptions = { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 };
function helperEnv(extra = {}) { return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|ProgramFiles(?:\(x86\))?)$/i.test(key))), ...extra }; }
let hostPromise;
export async function hostIntegrity({ fresh = false } = {}) {
  if (process.platform !== 'win32') return { level: 'native', rid: null, normal: true };
  if (!hostPromise || fresh) hostPromise = exec(systemTool('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { ...processOptions, env: helperEnv() }).then(({ stdout }) => {
    const match = stdout.match(/S-1-16-(\d+)/); if (!match) throw new Error('无法读取当前进程的 Windows 完整性级别');
    const rid = Number(match[1]); return { rid, normal: rid >= 8192, level: rid < 4096 ? 'untrusted' : rid < 8192 ? 'low' : rid < 12288 ? 'medium' : 'high' };
  });
  return hostPromise;
}
const READ_LABEL = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class WdhFileIntegrity {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string path,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern bool GetAce(IntPtr acl,int index,out IntPtr ace);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static int Read(string file) { IntPtr o,g,d,s,sd; uint code=GetNamedSecurityInfo(file,1,0x10,out o,out g,out d,out s,out sd); if(code!=0)throw new Exception("File integrity read failed: "+code); try {
  if(s!=IntPtr.Zero) for(int i=0;i<Marshal.ReadInt16(s,4);i++){IntPtr ace;if(GetAce(s,i,out ace)&&Marshal.ReadByte(ace)==0x11){var sid=new System.Security.Principal.SecurityIdentifier(ace+8).Value;return Int32.Parse(sid.Substring(sid.LastIndexOf('-')+1));}}
  return 8192;
 } finally { LocalFree(sd); } }
}
'@
[Console]::Write([WdhFileIntegrity]::Read($env:WDH_RUNTIME_FILE))
`;
export async function fileIntegrity(file) {
  if (process.platform !== 'win32') return { rid: null, normal: true };
  const encoded = Buffer.from(READ_LABEL, 'utf16le').toString('base64');
  const { stdout } = await exec(systemTool('WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { ...processOptions, env: helperEnv({ WDH_RUNTIME_FILE: file }) }).catch(error => {
    const code = error.killed ? 'TIMEOUT' : error.code || 'UNKNOWN';
    throw new Error('Windows 程序完整性检查失败（' + code + '）：' + path.basename(file) + '。请重试；持续失败时检查系统 PowerShell 是否可正常运行。');
  });
  const rid = Number(stdout.trim()); if (!Number.isFinite(rid)) throw new Error('无法读取程序文件完整性标签'); return { rid, normal: rid >= 8192 };
}
export async function requireNormalHost() {
  const status = await hostIntegrity();
  if (!status.normal) { const error = new Error('桌面程序当前以 Windows 低完整性运行，无法正常启动浏览器。请关闭旧窗口，在普通终端重新运行 npm run dev:desktop；请勿使用“重启侧车”，它会继承旧进程权限。'); error.code = 'LOW_INTEGRITY_HOST'; throw error; }
  return status;
}
export async function requireNormalExecutable(file) {
  await requireNormalHost(); const label = await fileIntegrity(file);
  if (!label.normal) { const error = new Error('浏览器程序继承了 Windows 低完整性标签，请在浏览器设置中修复已安装内核。自定义程序请使用它的正常安装版本。'); error.code = 'LOW_INTEGRITY_EXECUTABLE'; throw error; }
}
export async function prepareBuildExecutable(file, allowedRoot) {
  if (process.platform !== 'win32') return { changed: false };
  await requireNormalHost(); const absolute = path.resolve(file), root = path.resolve(allowedRoot);
  if (!containsPath(root, absolute)) throw new Error('构建程序超出指定产物目录'); resolveIn(root, path.relative(root, absolute));
  if (!fs.statSync(absolute).isFile() || path.extname(absolute).toLowerCase() !== '.exe') throw new Error('只处理生成的 EXE 文件');
  const label = await fileIntegrity(absolute); if (label.normal) return { changed: false, rid: label.rid };
  await exec(systemTool('icacls.exe'), [absolute, '/setintegritylevel', 'M'], { ...processOptions, env: helperEnv() });
  const after = await fileIntegrity(absolute); if (!after.normal) throw new Error('构建程序完整性修复未生效'); return { changed: true, rid: after.rid };
}
export async function prepareBrowserDistribution(directory, allowedRoot) {
  if (process.platform !== 'win32') return { prepared: false };
  await requireNormalHost(); const root = path.resolve(allowedRoot), target = path.resolve(directory);
  if (!containsPath(root, target) || target === root) throw new Error('只处理浏览器安装目录的子目录'); resolveIn(root, path.relative(root, target));
  if (!fs.statSync(target).isDirectory()) throw new Error('浏览器代码目录不存在');
  if ((await fileIntegrity(target)).rid > 8192) throw new Error('安装目录具有更高完整性，不会自动降低');
  const pending = [target]; let count = 0;
  while (pending.length) for (const entry of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
    if (++count > 100000) throw new Error('浏览器目录文件数超过限制');
    const file = path.join(entry.parentPath, entry.name); resolveIn(root, path.relative(root, file)); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('拒绝修复包含链接的浏览器目录');
    if (stat.isDirectory()) pending.push(file);
  }
  // This directory is created by the verified archive installer and contains no profile data.
  // Preserve Chromium's sandbox: its child processes need read/execute on the code files.
  await exec(systemTool('icacls.exe'), [target, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '*S-1-15-2-2:(OI)(CI)(RX)', '/Q'], { ...processOptions, env: helperEnv() });
  await exec(systemTool('icacls.exe'), [target, '/setintegritylevel', '(OI)(CI)M', '/T', '/Q'], { ...processOptions, env: helperEnv(), timeout: 60000 });
  return { prepared: true };
}
