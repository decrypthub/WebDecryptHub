import React, { useEffect, useRef, useState, useCallback, useReducer } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Icon, EmptyState, useToasts, Markdown, LogoMark } from './components.jsx';
import { SettingsPane, FirstRun } from './forms.jsx';
import { onConnState, native } from './transport.js';
import { TitleBar } from './titlebar.jsx';
import { NetworkPane } from './network.jsx';
import { scheduleStartupCheck } from './updater.js';

const api = window.api;
const mod = e => e.ctrlKey || e.metaKey;
const blank = () => ({ status: { running: false, pages: [] }, requests: [], scripts: [], events: [], logs: [], usage: null, agentRunning: false, thinking: false, toolCount: 0, url: 'https://' });

// 每个会话的 UI 状态（事件按 sid 路由，互不干扰）
function reducer(st, a) {
  const cur = st[a.sid] || blank();
  const set = patch => ({ ...st, [a.sid]: { ...cur, ...patch } });
  switch (a.t) {
    case 'drop': { const c = { ...st }; delete c[a.sid]; return c; }
    case 'patch': return set(a.patch);
    case 'status': return set({ status: a.v, url: (a.v.pages || []).find(p => p.active)?.url || cur.url });
    case 'requests': { const idx = new Map(cur.requests.map((r, i) => [r.id, i])); const c = cur.requests.slice(); for (const v of a.v) { const i = idx.get(v.id); if (i != null) c[i] = v; else { idx.set(v.id, c.length); c.push(v); } } return set({ requests: c.length > 3000 ? c.slice(-2500) : c }); }
    case 'request': { const p = cur.requests; const i = p.findIndex(x => x.id === a.v.id); if (i >= 0) { const c = p.slice(); c[i] = a.v; return set({ requests: c }); } return set({ requests: [...p.slice(-799), a.v] }); }
    case 'script': return set({ scripts: [...cur.scripts, a.v] });
    case 'log': return set({ logs: [...cur.logs.slice(-300), a.v] });
    case 'ev': return set({ events: [...cur.events, a.v] });
    case 'delta': { const c = cur.events.slice(); for (let i = c.length - 1; i >= 0; i--) if (c[i].type === 'assistant') { c[i] = { ...c[i], content: c[i].content + a.v }; break; } return set({ events: c, thinking: false }); }
    // 模型返回的 tool_call id 可能跨步骤重复（如 call_0），只更新最近一个尚未结束的同 id 工具
    case 'tool-end': { const c = cur.events.slice(); for (let i = c.length - 1; i >= 0; i--) { const e = c[i]; if (e.type === 'tool' && e.id === a.v.id && e.ms == null && e.result == null) { c[i] = { ...e, result: a.v.text, isError: a.v.isError, ms: a.v.ms }; break; } } return set({ events: c }); }
    default: return st;
  }
}

export default function App() {
  const [settings, setSettings] = useState(null);
  const [firstRun, setFirstRun] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('jsra_theme') || 'dark');
  const [conn, setConn] = useState('connecting');
  const [toastNode, toast] = useToasts();
  const [sessions, setSessions] = useState({ focused: null, sessions: [] });
  const [S, dispatch] = useReducer(reducer, {});
  const [rtab, setRtab] = useState('chat');
  const [launching, setLaunching] = useState({});
  const [input, setInput] = useState('');
  const sid = sessions.focused;
  const cur = (sid && S[sid]) || blank();
  const sidRef = useRef(sid); sidRef.current = sid;
  const viewRef = useRef();
  const canvasRef = useRef(); const urlRef = useRef(); const inputRef = useRef(); const chatRef = useRef();

  // 画面区尺寸变化（拖动分隔条/窗口缩放/切换会话）→ 通知 sidecar 调整无头视口，防抖 250ms
  const runningNow = !!(typeof cur !== 'undefined' && cur?.status?.running);
  useEffect(() => {
    const el = viewRef.current; if (!el) return;
    let t; const push = () => { clearTimeout(t); t = setTimeout(() => { const r = el.getBoundingClientRect(); if (r.width > 50 && r.height > 50) api.invoke('browser-viewport', { sessionId: sidRef.current, width: r.width, height: r.height }).catch(() => {}); }, 250); };
    const ro = new ResizeObserver(push); ro.observe(el); push();
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [sid, runningNow]);
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('jsra_theme', theme); }, [theme]);
  useEffect(() => onConnState(setConn), []);
  useEffect(() => {
    if (!settings) return;
    return scheduleStartupCheck((r) => {
      toast(`发现新版本 v${r.version}，可在「设置 → 软件更新」中安装`, 'ok', 8000);
    });
  }, [settings]);
  const [, dbgTick] = useState(0); useEffect(() => { if (!window.__JSRA_DEBUG) return; const t = setInterval(() => dbgTick(x => x + 1), 500); return () => clearInterval(t); }, []);

  useEffect(() => { (async () => {
    try {
      const s = await api.invoke('get-settings');
      const key = await native.secretGet();
      if (key) { if (s.provider === 'anthropic') s.anthropic.apiKey = key; else s.openai.apiKey = key; await api.invoke('save-settings', s); }
      setSettings(s);
      setSessions(await api.invoke('session-list'));
      const doc = await api.invoke('doctor');
      const keyMissing = !(s.provider === 'anthropic' ? s.anthropic.apiKey : s.openai.apiKey);
      if ((!doc.chromeOk || keyMissing || doc.runtime?.error) && !window.__JSRA_SKIP_ONBOARD) setFirstRun(true);
      const shot = window.__JSRA_SHOT; if (shot && ['chat', 'evidence', 'code', 'settings'].includes(shot)) setRtab(shot);
    } catch { setTimeout(() => location.reload(), 1500); }
  })(); }, []);

  // 事件订阅：所有会话的事件都进 reducer；画面帧只画当前会话
  useEffect(() => {
    const on = (ch, fn) => api.on(ch, fn);
    const offs = [
      on('sessions', v => setSessions(v)),
      on('browser-status', (v, s) => dispatch({ t: 'status', sid: s, v })),
      on('requests', (v, s) => dispatch({ t: 'requests', sid: s, v })),
      on('requests-cleared', (v, s) => dispatch({ t: 'patch', sid: s, patch: { requests: [] } })),
      on('script', (v, s) => dispatch({ t: 'script', sid: s, v })),
      on('log', (v, s) => s && dispatch({ t: 'log', sid: s, v: String(v) })),
      on('frame', (f, s) => { if (s === sidRef.current) drawFrame(f); }),
      on('agent-user', (c, s) => dispatch({ t: 'ev', sid: s, v: { type: 'user', content: c } })),
      on('agent-assistant-start', (v, s) => dispatch({ t: 'ev', sid: s, v: { type: 'assistant', content: '' } })),
      on('agent-delta', (d, s) => dispatch({ t: 'delta', sid: s, v: d })),
      on('agent-reasoning', (v, s) => dispatch({ t: 'patch', sid: s, patch: { thinking: true } })),
      on('agent-assistant-end', (v, s) => dispatch({ t: 'patch', sid: s, patch: { thinking: false } })),
      on('agent-usage', (u, s) => dispatch({ t: 'patch', sid: s, patch: { usage: u } })),
      on('agent-tool-start', (t, s) => dispatch({ t: 'ev', sid: s, v: { type: 'tool', id: t.id, name: t.name, args: t.args } })),
      on('agent-tool-end', (t, s) => dispatch({ t: 'tool-end', sid: s, v: t })),
      on('agent-error', (e, s) => dispatch({ t: 'ev', sid: s, v: { type: 'error', content: e } })),
      on('agent-done', (d, s) => { dispatch({ t: 'patch', sid: s, patch: { agentRunning: false, thinking: false } }); if (d?.stop === 'max-steps') dispatch({ t: 'ev', sid: s, v: { type: 'note', content: '已达步数上限，已输出阶段性总结。可继续对话让它接着分析。' } }); }),
    ];
    return () => offs.forEach(f => f && f());
  }, []);
  // 会话列表变化时同步运行态
  useEffect(() => { for (const s of sessions.sessions) dispatch({ t: 'patch', sid: s.id, patch: { agentRunning: s.agentRunning } }); }, [sessions]);
  // 会话恢复：首次见到某会话时载入其网址、对话记录与已捕获请求
  const seen = useRef(new Set());
  useEffect(() => { for (const s of sessions.sessions) { if (seen.current.has(s.id)) continue; seen.current.add(s.id);
    const patch = {}; if (s.url && /^https?:/.test(s.url)) patch.url = s.url;
    try { const ev = JSON.parse(localStorage.getItem('wdh_ev_' + s.id) || 'null'); if (Array.isArray(ev) && ev.length) patch.events = ev; } catch {}
    dispatch({ t: 'patch', sid: s.id, patch });
    api.invoke('get-requests', { sessionId: s.id }).then(r => r?.list?.length && dispatch({ t: 'requests', sid: s.id, v: r.list })).catch(() => {});
  } }, [sessions]);
  // 对话记录持久化（截断工具输出，避免占满存储）
  useEffect(() => { const t = setTimeout(() => { for (const [id, st] of Object.entries(S)) { if (st.agentRunning) continue; try { if (!st.events.length) localStorage.removeItem('wdh_ev_' + id); else localStorage.setItem('wdh_ev_' + id, JSON.stringify(st.events.slice(-300).map(e => e.result ? { ...e, result: String(e.result).slice(0, 3000) } : e))); } catch {} } }, 800); return () => clearTimeout(t); }, [S]);
  useEffect(() => { const el = chatRef.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight; }, [cur.events]);

  const drawFrame = useCallback(f => { const cv = canvasRef.current; if (!cv) return; const img = new Image(); img.onload = () => { if (cv.width !== img.width) cv.width = img.width; if (cv.height !== img.height) cv.height = img.height; cv.getContext('2d').drawImage(img, 0, 0); }; img.src = 'data:image/jpeg;base64,' + f.data; }, []);

  useEffect(() => {
    const h = e => {
      if (mod(e) && e.key === 'Enter') { e.preventDefault(); send(false); }
      else if (mod(e) && e.key.toLowerCase() === 'l') { e.preventDefault(); urlRef.current?.focus(); urlRef.current?.select(); }
      else if (mod(e) && e.key.toLowerCase() === 't') { e.preventDefault(); newSession(); }
      else if (mod(e) && e.key === ',') { e.preventDefault(); setRtab('settings'); }
      else if (mod(e) && /^[1-4]$/.test(e.key) && e.altKey) { e.preventDefault(); setRtab(['chat', 'evidence', 'code', 'settings'][+e.key - 1]); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const inv = (ch, a = {}) => api.invoke(ch, { sessionId: sid, ...a });
  async function launch(target = sid) {
    setLaunching(l => ({ ...l, [target]: true }));
    try {
      const r = await api.invoke('browser-launch', { sessionId: target });
      if (!r.ok) { if (r.needChrome) setFirstRun(true); toast(r.error, 'err', 6000); return false; }
      dispatch({ t: 'patch', sid: target, patch: { toolCount: r.toolCount } });
      return true;
    } catch (e) { toast('启动失败：' + e.message, 'err'); return false; } finally { setLaunching(l => ({ ...l, [target]: false })); }
  }
  async function go(u) {
    let url = (u ?? cur.url).trim(); if (!url || url === 'https://') return;
    if (!/^[a-z]+:/i.test(url)) url = 'https://' + url;
    dispatch({ t: 'patch', sid, patch: { url } });
    if (!cur.status.running && !(await launch())) return;
    inv('navigate', { url }).catch(e => toast(e.message, 'err'));
  }
  async function newSession() {
    try { const s = await api.invoke('session-create', {}); await api.invoke('session-focus', { sessionId: s.id }); setRtab('chat'); setTimeout(() => urlRef.current?.focus(), 50); }
    catch (e) { toast(e.message, 'warn'); }
  }
  async function closeSession(id) {
    const s = sessions.sessions.find(x => x.id === id);
    if (s?.agentRunning && !window.confirm(`「${s.title}」的 AI 正在分析，关闭将中断并关闭其浏览器。继续？`)) return;
    await api.invoke('session-close', { sessionId: id }); dispatch({ t: 'drop', sid: id }); localStorage.removeItem('wdh_ev_' + id); seen.current.delete(id);
  }
  function sendInput(e, kind, extra = {}) {
    if (!cur.status.running) return; const cv = canvasRef.current; if (!cv) return; const rect = cv.getBoundingClientRect();
    // canvas 使用 object-fit: contain，换算到实际画面坐标
    const sc = Math.min(rect.width / cv.width, rect.height / cv.height); const ox = (rect.width - cv.width * sc) / 2, oy = (rect.height - cv.height * sc) / 2;
    const x = (e.clientX - rect.left - ox) / sc, y = (e.clientY - rect.top - oy) / sc;
    if (x < 0 || y < 0 || x > cv.width || y > cv.height) return;
    api.sendInput({ kind, w: cv.width, x, y, ...extra });
  }
  async function send(auto) {
    if (cur.agentRunning) return;
    const text = auto ? '' : input.trim(); if (!auto && !text) return;
    if (!cur.status.running) { toast('请先在左侧打开目标网址', 'warn'); return; }
    const r = await inv('agent-send', { text, auto });
    if (!r?.ok) { toast(r?.error || '发送失败', 'warn'); if (/API Key/.test(r?.error || '')) setRtab('settings'); return; }
    dispatch({ t: 'patch', sid, patch: { agentRunning: true } }); if (!auto) { setInput(''); if (inputRef.current) inputRef.current.style.height = ''; }
    setRtab('chat');
  }
  async function cleanRetry(e) {
    const fresh = !!e?.shiftKey;
    if (!window.confirm(fresh ? '以全新隔离 Profile 重启该会话的浏览器并重新分析？' : '清除当前站点 Cookie/存储与已捕获请求，刷新后重新分析？（Shift+点击：全新隔离 Profile）')) return;
    try {
      if (cur.agentRunning) await inv('agent-interrupt');
      if (fresh) await inv('restart-fresh', { url: cur.url }); else await inv('reset-session', { scope: 'site', reload: true });
      await inv('agent-reset'); dispatch({ t: 'patch', sid, patch: { requests: [], events: [] } });
      toast(fresh ? '已用全新 Profile 重启' : '已清空站点数据并刷新', 'ok');
      setTimeout(() => send(true), 2500);
    } catch (err) { toast('干净重试失败：' + (err?.message || err), 'err'); }
  }
  async function saveSettings(s, quiet) {
    const key = s.provider === 'anthropic' ? s.anthropic.apiKey : s.openai.apiKey;
    await native.secretSet(key || ''); await api.invoke('save-settings', s); setSettings(s);
    if (!quiet) toast('设置已保存', 'ok');
  }

  if (!settings) return <><TitleBar /><div className="empty"><div className="spinner" /><div className="desc">正在连接逆向引擎…</div></div></>;
  const model = settings.provider === 'anthropic' ? settings.anthropic.model : settings.openai.model;
  const hasKey = !!(settings.provider === 'anthropic' ? settings.anthropic.apiKey : settings.openai.apiKey);

  return <>
    <TitleBar sessions={sessions} onFocus={id => api.invoke('session-focus', { sessionId: id })} onNew={newSession} onClose={closeSession}
      onRename={(id, title) => api.invoke('session-rename', { sessionId: id, title })} theme={theme} onTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} />
    <div className="workspace">
      <PanelGroup direction="horizontal" autoSaveId="wdh-main">
        <Panel defaultSize={56} minSize={30}>
          <div className="panel browser-pane">
            <div className="navbar">
              <button className="icon-btn" onClick={() => inv('go-back')} disabled={!cur.status.running} title="后退"><Icon n="back" size={15} /></button>
              <button className="icon-btn" onClick={() => inv('reload')} disabled={!cur.status.running} title="刷新"><Icon n="reload" size={15} /></button>
              <div className="urlbar">
                <span className={'sdot ' + (cur.status.running ? 'on' : '')} />
                <input ref={urlRef} value={cur.url} onChange={e => dispatch({ t: 'patch', sid, patch: { url: e.target.value } })} onKeyDown={e => e.key === 'Enter' && go()} onFocus={e => e.target.select()} placeholder="输入目标网址，回车打开（Ctrl+L）" spellCheck={false} />
              </div>
              {cur.status.running
                ? <button className="icon-btn danger" onClick={() => inv('browser-close')} title="关闭此会话的浏览器"><Icon n="stop" size={13} /></button>
                : <button className="btn-primary btn-sm" onClick={() => go()} disabled={launching[sid] || conn !== 'connected'}>{launching[sid] ? <><span className="spinner sm" />启动中</> : <><Icon n="play" size={11} />打开</>}</button>}
            </div>
            {cur.status.pages.length > 1 && <div className="pagetabs">
              {cur.status.pages.map(p => <button key={p.index} className={'ptab ' + (p.active ? 'on' : '')} onClick={() => inv('select-page', { index: p.index })} title={p.url}>{hostOf(p.url) || '空白页'}</button>)}
            </div>}
            <div className="view" ref={viewRef}>
              {cur.status.running
                ? <canvas ref={canvasRef} className="screencast" tabIndex={0}
                    onMouseDown={e => { e.currentTarget.focus(); sendInput(e, 'mouse', { type: 'mousePressed', clickCount: e.detail || 1 }); }}
                    onMouseUp={e => sendInput(e, 'mouse', { type: 'mouseReleased', clickCount: e.detail || 1 })}
                    onMouseMove={e => sendInput(e, 'mouse', { type: 'mouseMoved' })}
                    onWheel={e => sendInput(e, 'wheel', { dx: e.deltaX, dy: e.deltaY })}
                    onKeyDown={e => { if (mod(e) && ['l', 't', ','].includes(e.key.toLowerCase())) return; e.preventDefault(); api.sendInput({ kind: 'key', type: 'keyDown', key: e.key, code: e.code, text: e.key.length === 1 ? e.key : undefined }); }} />
                : <div className="launch-hero">
                    <LogoMark size={56} className="mark-lg" />
                    <div className="lh-title">输入目标网址开始分析</div>
                    {/^https?:\/\/[^/]+/.test(cur.url) && <button className="btn-primary btn-sm" onClick={() => go()} disabled={launching[sid] || conn !== 'connected'}><Icon n="play" size={11} />继续上次：{hostOf(cur.url)}</button>}
                    <div className="lh-row">
                      {['www.zhihu.com', 'www.douyin.com', 'www.xiaohongshu.com', 'www.jd.com'].map(h => <button key={h} className="btn btn-sm" onClick={() => go('https://' + h)}>{h}</button>)}
                    </div>
                  </div>}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={44} minSize={28}>
          <div className="panel right-pane">
            <div className="rtabs">
              {[['chat', 'chat', '对话'], ['evidence', 'network', '请求/证据'], ['code', 'code', '代码导出'], ['settings', 'settings', '设置']].map(([k, ic, l]) =>
                <button key={k} className={'rtab ' + (rtab === k ? 'on' : '')} onClick={() => setRtab(k)}><Icon n={ic} size={13} />{l}
                  {k === 'evidence' && cur.requests.length > 0 && <span className="badge">{cur.requests.filter(isApi).length}</span>}
                  {k === 'chat' && cur.agentRunning && <span className="live" />}
                </button>)}
            </div>
            <div className="rbody">
              {rtab === 'chat' && <ChatPane clear={() => { inv('agent-reset'); dispatch({ t: 'patch', sid, patch: { events: [], usage: null } }); }} cur={cur} chatRef={chatRef} input={input} setInput={setInput} inputRef={inputRef} send={send} cleanRetry={cleanRetry} inv={inv} hasKey={hasKey} goSettings={() => setRtab('settings')} />}
              {rtab === 'evidence' && <NetworkPane key={sid} cur={cur} inv={inv} toast={toast} />}
              {rtab === 'code' && <CodePane key={sid} sid={sid} inv={inv} toast={toast} events={cur.events} />}
              {rtab === 'settings' && <SettingsPane initial={settings} onSave={saveSettings} toast={toast} />}
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
    <div className="statusbar">
      <span className="seg"><span className={'sdot ' + (conn === 'connected' ? 'on' : 'warn')} />{conn === 'connected' ? '引擎已连接' : '正在重连引擎…'}{window.__JSRA_DEBUG ? ' ' + (window.__JSRA_DBGTXT || '') : ''}</span>
      <span className="seg">{sessions.sessions.filter(s => s.running).length}/{sessions.sessions.length} 会话运行</span>
      {cur.agentRunning && <span className="seg accent">{cur.thinking ? '模型思考中' : 'AI 分析中'}{cur.usage ? ` · 第 ${cur.usage.step} 步` : ''}</span>}
      {cur.usage && <span className="seg">{Math.round((cur.usage.total.prompt + cur.usage.total.completion) / 1000)}k tokens</span>}
      <span className="seg grow">{hasKey ? (model || '未配置模型') : '未配置 API Key'}</span>
    </div>
    {firstRun && <FirstRun settings={settings} onSave={s => saveSettings(s, true)} onDone={() => setFirstRun(false)} />}
    {toastNode}
  </>;
}

const isApi = r => r.type === 'xhr' || r.type === 'fetch';
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
function shortUrl(u) { try { const x = new URL(u); return x.host + x.pathname; } catch { return (u || '').slice(0, 60); } }

function ChatPane({ clear, cur, chatRef, input, setInput, inputRef, send, cleanRetry, inv, hasKey, goSettings }) {
  return <div className="chat">
    <div className="chat-scroll" ref={chatRef}>
      {!hasKey && <div className="callout warn"><Icon n="info" size={14} />尚未配置模型 API Key。<button className="linkbtn" onClick={goSettings}>去设置</button></div>}
      {cur.events.length === 0
        ? <EmptyState icon="sparkles" title="让 AI 分析当前站点" desc={cur.status.running ? '点击「自动分析」，或直接描述要逆向的参数。' : '先在左侧打开目标网址。'} />
        : cur.events.map((e, i) => <EventView key={i} e={e} />)}
      {cur.agentRunning && <div className="typing"><span /><span /><span />{cur.thinking ? '思考中' : '执行中'}</div>}
    </div>
    <div className="composer">
      <textarea ref={inputRef} value={input} rows={1} onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'; }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(false); } }}
        placeholder={cur.agentRunning ? 'AI 正在分析…' : '描述要分析的参数（Enter 发送，Shift+Enter 换行）'} disabled={cur.agentRunning} />
      <div className="composer-bar">
        {cur.agentRunning ? <>
          <button className="btn btn-sm" onClick={() => inv('agent-wrapup')} title="不再调用工具，立即总结"><Icon n="flag" size={12} />收尾总结</button>
          <button className="btn-danger btn-sm" onClick={() => inv('agent-interrupt')}><Icon n="stop" size={11} />中断</button>
        </> : <>
          <button className="btn btn-sm" onClick={() => send(true)} disabled={!cur.status.running}><Icon n="sparkles" size={12} />自动分析</button>
          <button className="btn-ghost btn-sm" onClick={cleanRetry} disabled={!cur.status.running} title="清站点数据后重新分析（Shift：全新 Profile）"><Icon n="broom" size={12} />干净重试</button>
          <button className="btn-ghost btn-sm" onClick={clear} disabled={!cur.events.length} title="清空对话上下文"><Icon n="x" size={12} />清空</button>
        </>}
        <span className="grow" />
        <button className="btn-primary btn-icon send" onClick={() => send(false)} disabled={cur.agentRunning || !input.trim() || !cur.status.running} title="发送"><Icon n="send" size={14} /></button>
      </div>
    </div>
  </div>;
}

function EventView({ e }) {
  const [open, setOpen] = useState(false);
  if (e.type === 'user') return <div className="msg user"><div className="bubble">{e.content || '一键自动分析'}</div></div>;
  if (e.type === 'assistant') return e.content ? <div className="msg assistant"><div className="bubble"><Markdown text={e.content} /></div></div> : null;
  if (e.type === 'error') return <div className="callout err"><Icon n="info" size={14} />{e.content}</div>;
  if (e.type === 'note') return <div className="callout"><Icon n="info" size={14} />{e.content}</div>;
  if (e.type === 'tool') {
    const st = e.result === undefined ? 'run' : e.isError ? 'err' : 'ok';
    const brief = argBrief(e.args);
    return <div className={'tcall ' + st}>
      <div className="h" onClick={() => setOpen(o => !o)}>
        <span className={'tdot ' + st} /><span className="tname">{e.name}</span><span className="targ">{brief}</span>
        <span className="tstatus">{st === 'run' ? '…' : e.ms != null ? (e.ms / 1000).toFixed(1) + 's' : ''}</span>
      </div>
      {open && <div className="b">{JSON.stringify(e.args || {}, null, 1) + '\n\n' + (e.result ?? '(执行中…)')}</div>}
    </div>;
  }
  return null;
}
function argBrief(a) { if (!a) return ''; const v = a.url || a.names || a.expression || a.pattern || a.query || a.file || a.urlPattern || a.code || a.ids || ''; return String(Array.isArray(v) ? v.join(',') : v).replace(/\s+/g, ' ').slice(0, 60); }

function CodePane({ sid, inv, toast, events }) {
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(null);
  const [content, setContent] = useState('');
  const refresh = useCallback(async () => { try { const f = await inv('list-files'); setFiles(f.filter(x => !x.name.startsWith('scripts/') && !x.name.startsWith('.capture/'))); } catch {} }, [sid]);
  useEffect(() => { refresh(); }, [refresh, events.length]);
  useEffect(() => { if (!sel && files.length) open(files.find(f => /^(signature|report|findings)/.test(f.name)) || files[0]); }, [files]);
  async function open(f) { setSel(f.name); setContent(await inv('read-file', { file: f.name })); }
  return <div className="code-pane">
    <div className="files">
      <div className="files-h">项目 / 工作区 <button className="icon-btn" onClick={refresh} title="刷新"><Icon n="reload" size={12} /></button></div>
      <div className="hint" style={{ padding: '4px 12px' }}>含 AI 工作区 workspace/（脚本与 npm 包）</div>
      {files.length === 0 ? <div className="hint" style={{ padding: 12 }}>AI 导出的复现代码、笔记与报告会出现在这里。</div>
        : files.map(f => <div key={f.name} className={'fitem ' + (sel === f.name ? 'sel' : '')} onClick={() => open(f)} title={f.name}><Icon n={/\.md$/.test(f.name) ? 'report' : 'file'} size={12} /><span className="u">{f.name}</span><span className="st">{f.size > 1024 ? (f.size / 1024).toFixed(0) + 'k' : f.size + 'B'}</span></div>)}
    </div>
    <div className="file-view">
      {sel ? <>
        <div className="fv-h"><span>{sel}</span><button className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(content); toast('已复制', 'ok'); }}><Icon n="copy" size={12} />复制</button></div>
        {/\.md$/.test(sel) ? <div className="report-md"><Markdown text={content} /></div> : <pre className="codearea"><code>{content}</code></pre>}
      </> : <EmptyState icon="code" title="暂无导出" />}
    </div>
  </div>;
}
