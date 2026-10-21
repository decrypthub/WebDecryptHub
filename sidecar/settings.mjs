import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  provider: 'openai',
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-sonnet-4-5' },
  temperature: 0.2, maxSteps: 40, maxTokens: 4096,
  antiDebug: false, headless: false, chromePath: '', isolated: false, proxy: '',
  // 浏览器显示方式：auto = Windows 有头时嵌入真实 Chrome 窗口，其它平台/无头用 screencast；embedded / screencast 强制
  embedMode: 'auto',
  kernel: 'system', // system = 系统 Chrome/Edge；bundled = 按需下载到应用数据目录的 Chromium (Chrome for Testing)
  contextWindow: 0, // 模型上下文上限 tokens；0 = 按模型名推断
};

export function userDataDir() {
  const base = process.platform === 'win32' ? (process.env.APPDATA || os.homedir())
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  const d = path.join(base, 'WebDecryptHub');
  const legacy = path.join(base, 'JSReverseAgent');
  try { if (!fs.existsSync(d) && fs.existsSync(legacy)) fs.renameSync(legacy, d); } catch {}
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function file() { return path.join(userDataDir(), 'settings.json'); }
function enc(s) { return s ? 'b64:' + Buffer.from(s).toString('base64') : ''; }
function dec(s) { if (!s) return ''; return s.startsWith('b64:') ? Buffer.from(s.slice(4), 'base64').toString() : s; }

export function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  const s = { ...DEFAULTS, ...raw, openai: { ...DEFAULTS.openai, ...(raw.openai || {}) }, anthropic: { ...DEFAULTS.anthropic, ...(raw.anthropic || {}) } };
  s.openai.apiKey = dec(s.openai.apiKey); s.anthropic.apiKey = dec(s.anthropic.apiKey);
  if (process.env.JSRA_OPENAI_BASE) { s.provider = 'openai'; s.openai.baseUrl = process.env.JSRA_OPENAI_BASE; if (process.env.JSRA_OPENAI_KEY) s.openai.apiKey = process.env.JSRA_OPENAI_KEY; if (process.env.JSRA_OPENAI_MODEL) s.openai.model = process.env.JSRA_OPENAI_MODEL; }
  if (s.provider !== 'openai' && s.provider !== 'anthropic') s.provider = 'openai'; // 旧版 mock 设置迁移
  if (s.openai.model === 'mock') s.openai.model = '';
  if (process.env.JSRA_HEADLESS) s.headless = process.env.JSRA_HEADLESS === '1';
  if (!['auto', 'embedded', 'screencast'].includes(s.embedMode)) s.embedMode = 'auto';
  if (!['system', 'bundled'].includes(s.kernel)) s.kernel = 'system';
  if (process.env.JSRA_KERNEL) s.kernel = process.env.JSRA_KERNEL;
  if (process.env.JSRA_EMBED_MODE) s.embedMode = process.env.JSRA_EMBED_MODE;
  return s;
}
// 是否以原生子窗口嵌入（仅 Windows + 有头）。纯函数，便于单元测试
export function wantEmbed(s, platform = process.platform, env = process.env) {
  if (s.headless || s.embedMode === 'screencast') return false;
  if (platform === 'win32') return true;
  // Linux 需要 X11（Wayland 会话下 Chrome 以 --ozone-platform=x11 跑在 XWayland 上）
  if (platform === 'linux') return !!env.DISPLAY && !env.JSRA_NO_EMBED;
  return false; // macOS 等：清晰 screencast
}
export function save(s) {
  const c = JSON.parse(JSON.stringify(s));
  // 密钥不落盘，由 OS keyring/DPAPI 管理（前端注入到内存）
  c.openai.apiKey = ''; c.anthropic.apiKey = '';
  fs.writeFileSync(file(), JSON.stringify(c, null, 2), { mode: 0o600 });
}
export { DEFAULTS };
