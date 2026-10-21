import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderMd, highlightHtml } from './md.js';

export function Icon({ n, size = 16, className }) {
  const p = ICONS[n] || ICONS.dot;
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;
}
const ICONS = {
  play: <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  reload: <><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></>,
  go: <path d="M5 12h14M12 5l7 7-7 7" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></>,
  sun: <><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></>,
  moon: <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />,
  sparkles: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" fill="currentColor" stroke="none" />,
  globe: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></>,
  code: <polyline points="16 18 22 12 16 6 8 18 2 12 8 6" />,
  network: <><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /><path d="M7 17L17 7" /></>,
  file: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></>,
  terminal: <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>,
  tool: <path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  check: <path d="M20 6L9 17l-5-5" />,
  download: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
  report: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></>,
  info: <><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>,
  broom: <path d="M19 3l-6 6M13 9l-7 7a3 3 0 004 4l7-7" />,
  minus: <line x1="5" y1="12" x2="19" y2="12" />,
  square: <rect x="5" y="5" width="14" height="14" rx="1.5" />,
  restore: <><rect x="4" y="8" width="12" height="12" rx="1.5" /><path d="M8 8V5.5A1.5 1.5 0 019.5 4H18.5A1.5 1.5 0 0120 5.5V14.5A1.5 1.5 0 0118.5 16H16" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chat: <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>,
  folder: <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />,
  flag: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></>,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3L21 2M17 6l3 3M14.5 8.5l2.5 2.5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  layers: <><path d="M12 3 3 8l9 5 9-5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  chevup: <path d="m6 15 6-6 6 6" />,
  chevdown: <path d="M6 9l6 6 6-6" />,
  chevright: <path d="M9 6l6 6-6 6" />,
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />,
};

export function EmptyState({ icon = 'sparkles', title, desc, children }) {
  return <div className="empty"><Icon n={icon} size={48} className="ico" /><div className="title">{title}</div>{desc && <div className="desc">{desc}</div>}{children}</div>;
}

export function Modal({ title, onClose, children, footer, width }) {
  useEffect(() => { const h = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return <div className="overlay" onMouseDown={onClose}><div className="modal" style={width ? { width } : null} onMouseDown={e => e.stopPropagation()}>
    <div className="modal-h"><div className="title">{title}</div><button className="btn-ghost btn-icon" onClick={onClose}><Icon n="x" /></button></div>
    <div className="modal-body">{children}</div>
    {footer && <div className="modal-f">{footer}</div>}
  </div></div>;
}

let toastId = 0;
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = (msg, kind = 'info', ms = 3600) => { const id = ++toastId; setToasts(t => [...t, { id, msg, kind }]); setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ms); };
  const node = <div className="toasts">{toasts.map(t => <div key={t.id} className={'toast ' + t.kind}><Icon n={t.kind === 'ok' ? 'check' : t.kind === 'err' ? 'x' : 'info'} size={15} /><div>{t.msg}</div></div>)}</div>;
  return [node, push];
}

export function Markdown({ text }) {
  const ref = useRef();
  useEffect(() => { if (ref.current) highlightHtml(ref.current); }, [text]);
  return <div className="bubble-md" ref={ref} dangerouslySetInnerHTML={{ __html: renderMd(text) }} />;
}

// WebDecryptHub 品牌标（取自 ios.decrypthub.com 的渡鸦图标）
export function LogoMark({ size = 26, className = 'mark' }) {
  return <img className={className} src="./logo.svg" width={size} height={size} alt="WebDecryptHub" draggable={false} />;
}

// 应用内确认框：WebKitGTK/WebView2 下 window.confirm 不可靠（Linux 上不阻塞、直接返回 true），统一用 Promise 版本
export function askConfirm(message, { ok = '确定', danger = false, always = null } = {}) {
  return new Promise(resolve => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    const done = v => { root.unmount(); el.remove(); resolve(v); };
    function Dlg() {
      useEffect(() => { const h = e => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
      return <div className="overlay confirm-ov" onMouseDown={e => { if (e.target === e.currentTarget) done(false); }}>
        <div className="modal confirm"><div className="confirm-b">{message}</div>
          <div className="confirm-f">
            <button className="btn btn-sm" onClick={() => done(false)}>取消</button>
            {always && <button className="btn btn-sm" onClick={() => done('always')}>{always}</button>}
            <button className={(danger ? 'btn-danger' : 'btn-primary') + ' btn-sm'} autoFocus onClick={() => done(true)}>{ok}</button>
          </div></div>
      </div>;
    }
    root.render(<Dlg />);
  });
}

export function CtxMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const place = () => { const el = ref.current; if (!el) return; const w = el.offsetWidth, h = el.offsetHeight; el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px'; el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px'; };
    place();
    const key = e => { if (e.key === 'Escape') onClose(); };
    const down = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', down);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', down); };
  }, [x, y, onClose]);
  return <div className="ctxmenu" ref={ref} style={{ left: x, top: y }} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
    {items.map(it => <button key={it.label} disabled={it.disabled} onClick={() => { it.onClick(); onClose(); }}>{it.label}</button>)}
  </div>;
}
