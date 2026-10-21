// 自绘标题栏：拖拽区 + 会话标签 + 窗口按钮（最小化 / 最大化·还原 / 关闭）
import React, { useEffect, useState } from 'react';
import { Icon, LogoMark } from './components.jsx';

let win = null;
async function getWin() {
  if (win) return win;
  if (!(window.__TAURI_INTERNALS__ || window.__JSRA_NATIVE)) return null;
  try { const m = await import('@tauri-apps/api/window'); win = m.getCurrentWindow(); return win; } catch { return null; }
}

export function TitleBar({ sessions, onFocus, onNew, onClose, onRename, theme, onTheme }) {
  const [max, setMax] = useState(false);
  const [native, setNative] = useState(false);
  const [edit, setEdit] = useState(null);
  useEffect(() => {
    let un;
    getWin().then(async w => {
      if (!w) return; setNative(true);
      setMax(await w.isMaximized().catch(() => false));
      un = await w.onResized(async () => setMax(await w.isMaximized().catch(() => false))).catch(() => null);
    });
    return () => { un && un(); };
  }, []);
  const act = async a => { const w = await getWin(); if (!w) return; if (a === 'min') w.minimize(); if (a === 'max') w.toggleMaximize(); if (a === 'close') w.close(); };
  const list = sessions?.sessions || [];
  return <div className="titlebar" data-tauri-drag-region onDoubleClick={e => { if (e.target.hasAttribute('data-tauri-drag-region')) act('max'); }}>
    <div className="tb-brand" data-tauri-drag-region><LogoMark size={20} /><span className="wm" data-tauri-drag-region>WebDecrypt<span className="hub">Hub</span></span></div>
    {sessions && <div className="stabs" data-tauri-drag-region>
      {list.map(s => <div key={s.id} className={'stab ' + (s.id === sessions.focused ? 'on' : '')} onMouseDown={e => { if (e.button === 1) { e.preventDefault(); onClose(s.id); } }} onClick={() => onFocus(s.id)} onDoubleClick={() => setEdit(s.id)} title={s.url || s.title}>
        <span className={'sdot ' + (s.agentRunning ? 'busy' : s.running ? 'on' : '')} />
        {edit === s.id
          ? <input autoFocus defaultValue={s.title} onBlur={e => { onRename(s.id, e.target.value); setEdit(null); }} onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEdit(null); }} onClick={e => e.stopPropagation()} />
          : <span className="stitle">{label(s)}</span>}
        {(list.length > 1 || s.running) && <button className="sclose" onClick={e => { e.stopPropagation(); onClose(s.id); }} title="关闭会话"><Icon n="x" size={11} /></button>}
      </div>)}
      <button className="snew" onClick={onNew} title="新建会话（Ctrl+T）：并行分析另一个站点"><Icon n="plus" size={14} /></button>
    </div>}
    <div className="tb-fill" data-tauri-drag-region />
    {onTheme && <button className="tb-btn" onClick={onTheme} title="切换主题"><Icon n={theme === 'dark' ? 'sun' : 'moon'} size={14} /></button>}
    {<div className="winctl">
      <button className="wbtn" onClick={() => act('min')} title="最小化"><Icon n="minus" size={14} /></button>
      <button className="wbtn" onClick={() => act('max')} title={max ? '还原' : '最大化'}><Icon n={max ? 'restore' : 'square'} size={12} /></button>
      <button className="wbtn close" onClick={() => act('close')} title="关闭"><Icon n="x" size={14} /></button>
    </div>}
  </div>;
}
function label(s) { try { if (s.url && /^https?:/.test(s.url)) { const h = new URL(s.url).hostname.replace(/^www\./, ''); if (/^会话 \d+$/.test(s.title)) return h; } } catch {} return s.title; }
