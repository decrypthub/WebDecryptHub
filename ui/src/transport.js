// 传输层：WebSocket(与 sidecar 通信) + 原生桥(Tauri 命令：keyring/app_info/restart)
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const isNative = () => !!(window.__JSRA_NATIVE || window.__TAURI_INTERNALS__ || window.__TAURI__);

// ---------- 原生命令 ----------
export const native = {
  isNative,
  async appInfo() {
    if (isNative()) { try { return await tauriInvoke('app_info'); } catch {} }
    return { name: 'WebDecryptHub', version: '1.2.2 (web)', os: 'web', arch: '-', keyringBackend: '浏览器本地存储(开发)' };
  },
  async secretGet() {
    // 系统凭据库不可用（如 Linux 无 Secret Service）时回落到本地存储，避免重启后丢失密钥
    if (isNative()) { try { const v = await tauriInvoke('secret_get'); if (v) return v; } catch {} }
    return localStorage.getItem('jsra_key') || '';
  },
  async secretSet(v) {
    if (isNative()) { try { await tauriInvoke('secret_set', { value: v }); localStorage.removeItem('jsra_key'); return; } catch {} }
    localStorage.setItem('jsra_key', v || '');
  },
  async secretClear() {
    if (isNative()) { try { await tauriInvoke('secret_clear'); } catch {} }
    localStorage.removeItem('jsra_key');
  },
  async restartSidecar() { if (isNative()) { try { await tauriInvoke('restart_sidecar'); } catch {} } },
  // 原生保存对话框；返回绝对路径或 null（用户取消）
  async pickSavePath(defaultName, filterName = 'HAR', ext = 'har') {
    if (isNative()) return await tauriInvoke('pick_save_path', { defaultName, filterName, ext });
    const p = window.prompt('保存到（绝对路径）', '/tmp/' + defaultName); return p || null;
  },
  // 原生嵌入 Chrome 子窗口（Windows / Linux X11）
  async embedSupported() { if (!isNative()) return false; try { return await tauriInvoke('embed_supported'); } catch { return false; } },
  embedShow(a) { return tauriInvoke('embed_show', a); },
  async embedHide() { if (isNative()) { try { await tauriInvoke('embed_hide'); } catch {} } },
  async embedRelease(sessionId) { if (isNative()) { try { await tauriInvoke('embed_release', { sessionId }); } catch {} } },
  async wsPort() { if (isNative()) { try { return await tauriInvoke('get_ws_port'); } catch {} } return null; },
};

// ---------- WebSocket ----------
const listeners = new Map();
const pending = new Map();
let seq = 0, ws = null, ready, queue = [];
let connState = 'connecting';
const stateCbs = new Set();
function setState(s) { connState = s; stateCbs.forEach(cb => cb(s)); }
export const onConnState = cb => { stateCbs.add(cb); cb(connState); return () => stateCbs.delete(cb); };
export const getConnState = () => connState;

async function resolvePort() {
  // 原生模式：端口由 sidecar 动态分配，每次（重）连接都向 Rust 查询最新端口
  if (isNative()) { for (let i = 0; i < 40; i++) { const np = await Promise.race([native.wsPort(), new Promise(r => setTimeout(() => r(null), 2000))]); if (window.__JSRA_DEBUG) window.__JSRA_DBGTXT = 'dbg port=' + np + ' i=' + i; if (np) return np; await new Promise(r => setTimeout(r, 250)); } }
  if (window.__JSRA_WS_PORT) return window.__JSRA_WS_PORT;
  const q = new URLSearchParams(location.search).get('port');
  return q ? Number(q) : 8777;
}

function connect() {
  ready = new Promise(resolve => {
    (async () => {
      let resolved = false;
      async function open() {
        setState('connecting');
        const port = await resolvePort();
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.onopen = () => { setState('connected'); if (!resolved) { resolved = true; resolve(); } queue.forEach(m => ws.send(m)); queue = []; };
        ws.onclose = () => { setState('reconnecting'); if (window.__JSRA_DEBUG) window.__JSRA_DBGTXT = 'dbg closed'; setTimeout(() => open().catch(e => { window.__JSRA_DBGTXT = 'dbg err ' + e; setTimeout(open, 2000); }), 1000); };
        ws.onerror = () => {};
        ws.onmessage = ev => {
          const m = JSON.parse(ev.data);
          if (m.type === 'reply') { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error)) : p.res(m.result); } }
          else if (m.type === 'event') { (listeners.get(m.channel) || []).forEach(cb => { try { cb(m.payload, m.sid); } catch (e) { console.error(e); } }); }
        };
      }
      open();
    })();
  });
}
connect();

function sendRaw(msg) { ready.then(() => { ws && ws.readyState === 1 ? ws.send(msg) : queue.push(msg); }); }

window.api = {
  invoke(channel, ...args) {
    const id = ++seq;
    const msg = JSON.stringify({ type: 'invoke', id, channel, args: args.length <= 1 ? args[0] : args });
    return new Promise((res, rej) => { pending.set(id, { res, rej }); sendRaw(msg); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('请求超时，逻辑进程可能繁忙或已退出')); } }, 130000); });
  },
  sendInput(ev) { sendRaw(JSON.stringify({ type: 'input', payload: ev })); },
  on(channel, cb) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(cb); return () => listeners.get(channel)?.delete(cb); },
};
