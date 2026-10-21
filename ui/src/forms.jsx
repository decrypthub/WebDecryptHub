import React, { useEffect, useState } from 'react';
import { Icon, LogoMark } from './components.jsx';
import { native } from './transport.js';
import { checkForUpdate, installAndRelaunch } from './updater.js';

function deepUp(setS) {
  return (p, v) => setS(prev => { const c = JSON.parse(JSON.stringify(prev)); const ks = p.split('.'); let o = c; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; return c; });
}

function ProviderFields({ s, up }) {
  const c = s.provider === 'anthropic' ? 'anthropic' : 'openai';
  return <>
    <div className="field">
      <label>接口类型</label>
      <div className="seg-ctl">{[['openai', 'OpenAI 兼容'], ['anthropic', 'Claude 原生']].map(([k, l]) => <button key={k} className={c === k ? 'on' : ''} onClick={() => up('provider', k)}>{l}</button>)}</div>
    </div>
    <div className="field"><label>Base URL</label><input value={s[c].baseUrl} onChange={e => up(c + '.baseUrl', e.target.value.trim())} placeholder={c === 'openai' ? 'https://api.example.com/v1' : 'https://api.anthropic.com'} spellCheck={false} /></div>
    <div className="field"><label>API Key</label><input type="password" value={s[c].apiKey} onChange={e => up(c + '.apiKey', e.target.value.trim())} placeholder="sk-…" autoComplete="off" /><div className="hint">保存在系统凭据库（{/win/i.test(navigator.userAgent) ? 'Windows 凭据管理器' : /mac/i.test(navigator.userAgent) ? 'macOS 钥匙串' : '系统密钥环'}），不写入明文文件。</div></div>
    <div className="field"><label>模型</label><input value={s[c].model} onChange={e => up(c + '.model', e.target.value.trim())} placeholder="模型名称" spellCheck={false} /></div>
  </>;
}

function TestButton({ s }) {
  const [state, setState] = useState(null);
  const run = async () => {
    setState('running');
    try { setState(await window.api.invoke('test-connection', { provider: s.provider, openai: s.openai, anthropic: s.anthropic })); }
    catch (e) { setState({ ok: false, message: e.message }); }
  };
  return <div className="testrow">
    <button className="btn btn-sm" onClick={run} disabled={state === 'running'}>{state === 'running' ? <><span className="spinner sm" />测试中</> : <><Icon n="check" size={12} />测试连接</>}</button>
    {state && state !== 'running' && <span className={'testmsg ' + (state.ok ? 'ok' : 'err')}>{state.message}</span>}
  </div>;
}

function ChromeBlock({ s, up, toast, compact }) {
  const [chromes, setChromes] = useState(null);
  const [dl, setDl] = useState(null); // null | {phase, got, total, source}
  const [err, setErr] = useState('');
  const refresh = () => window.api.invoke('find-chrome').then(setChromes).catch(() => setChromes([]));
  useEffect(() => { refresh(); return window.api.on('download-progress', p => setDl(p)); }, []);
  async function download() {
    setErr(''); setDl({ phase: 'download', got: 0, total: 0 });
    const r = await window.api.invoke('download-chrome').catch(e => ({ ok: false, error: e.message }));
    setDl(null);
    if (r.ok) { up && up('chromePath', r.path); toast?.(`浏览器已就绪（${r.version}，来源：${r.source}）`, 'ok'); refresh(); }
    else setErr(r.error);
  }
  const pct = dl && dl.total ? Math.round(dl.got / dl.total * 100) : null;
  return <div className="chromeblk">
    {chromes === null ? <div className="hint">检测中…</div>
      : chromes.length ? <div className="okline"><Icon n="check" size={13} />已检测到：{chromes[0].source} · <span className="mono">{chromes[0].path}</span></div>
      : <div className="warnline"><Icon n="info" size={13} />未检测到 Chrome / Edge，需要下载浏览器（约 170MB）。</div>}
    {dl ? <div className="progress"><div className="bar"><div style={{ width: (pct ?? 8) + '%' }} className={pct == null ? 'indet' : ''} /></div>
      <span>{dl.phase === 'extract' ? '解压中…' : `${dl.source || ''} ${(dl.got / 1e6).toFixed(0)}${dl.total ? '/' + (dl.total / 1e6).toFixed(0) : ''} MB`}</span></div>
      : (!compact || !chromes?.length) && <button className={chromes?.length ? 'btn btn-sm' : 'btn-primary btn-sm'} onClick={download}><Icon n="download" size={12} />{chromes?.length ? '下载独立的 Chrome for Testing' : '下载浏览器'}</button>}
    {err && <div className="testmsg err">{err}</div>}
  </div>;
}

export function SettingsPane({ initial, onSave, toast }) {
  const [s, setS] = useState(initial);
  const up = deepUp(setS);
  const [info, setInfo] = useState(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  useEffect(() => { native.appInfo().then(setInfo); }, []);
  return <div className="settings">
    <section><h3>AI 模型</h3><ProviderFields s={s} up={up} /><TestButton s={s} /></section>
    <section><h3>浏览器</h3>
      <div className="field"><label>Chrome / Edge 路径</label><input value={s.chromePath || ''} onChange={e => up('chromePath', e.target.value)} placeholder="留空自动检测" spellCheck={false} /></div>
      <ChromeBlock s={s} up={up} toast={toast} />
      <div className="row2">
        <div className="field"><label>主会话登录态</label><div className="seg-ctl sm"><button className={!s.isolated ? 'on' : ''} onClick={() => up('isolated', false)}>保留</button><button className={s.isolated ? 'on' : ''} onClick={() => up('isolated', true)}>每次全新</button></div></div>
        <div className="field"><label>显示模式</label><div className="seg-ctl sm"><button className={!s.headless ? 'on' : ''} onClick={() => up('headless', false)}>有头（推荐）</button><button className={s.headless ? 'on' : ''} onClick={() => up('headless', true)}>无头</button></div></div>
        {!s.headless && <div className="field"><label>浏览器嵌入</label><div className="seg-ctl sm">{[['auto', '自动'], ['embedded', '原生嵌入'], ['screencast', '画面串流']].map(([k, t]) => <button key={k} className={(s.embedMode || 'auto') === k ? 'on' : ''} onClick={() => up('embedMode', k)}>{t}</button>)}</div><div className="hint">原生嵌入：真实 Chrome 窗口直接嵌在左侧（Windows / Linux X11）；失败时自动回落画面串流。重新打开浏览器后生效</div></div>}
        <div className="field"><label>反调试绕过</label><div className="seg-ctl sm"><button className={!s.antiDebug ? 'on' : ''} onClick={() => up('antiDebug', false)}>关闭</button><button className={s.antiDebug ? 'on' : ''} onClick={() => up('antiDebug', true)}>默认开启</button></div>
          <div className="hint">开启后每次启动浏览器自动注入：中和 debugger 死循环、DevTools 检测、toString / console 时序 / outerWidth 检测。</div></div>
      </div>
      <div className="field"><label>代理</label><input value={s.proxy || ''} onChange={e => up('proxy', e.target.value.trim())} placeholder="可选，如 http://127.0.0.1:7890" spellCheck={false} /></div>
    </section>
    <section><h3>分析</h3>
      <div className="row2">
        <div className="field"><label>最大步数</label><input type="number" min="5" max="200" value={s.maxSteps} onChange={e => up('maxSteps', +e.target.value)} /></div>
        <div className="field"><label>温度</label><input type="number" step="0.1" min="0" max="1" value={s.temperature} onChange={e => up('temperature', +e.target.value)} /></div>
      </div>
    </section>
    <UpdateSection toast={toast} info={info} />
    <section><h3>关于</h3>
      <div className="about-line"><LogoMark size={28} /><div><b>WebDecryptHub</b> {info?.version || ''}<div className="hint">{info ? `${info.os} / ${info.arch} · 密钥：${info.keyringBackend}` : ''}</div></div></div>
      <button className="btn btn-sm" onClick={async () => { const r = await window.api.invoke('export-diagnostics').catch(e => ({ ok: false, error: e.message })); r.ok ? toast('诊断信息已导出：' + r.path, 'ok', 7000) : toast('导出失败：' + r.error, 'err'); }}><Icon n="file" size={12} />导出诊断信息</button>
      <div className="hint" style={{ marginTop: 10 }}>仅限授权的安全研究与调试用途。内置 js-reverse-core（Apache-2.0）、Patchright、webcrack。</div>
    </section>
    <div className={'savebar ' + (dirty ? 'show' : '')}><span>有未保存的更改</span><button className="btn-ghost btn-sm" onClick={() => setS(initial)}>还原</button><button className="btn-primary btn-sm" onClick={() => onSave(s)}><Icon n="check" size={12} />保存</button></div>
  </div>;
}


function UpdateSection({ toast, info }) {
  const [st, setSt] = useState({ phase: 'idle' }); // idle|checking|available|none|downloading|error
  const [upd, setUpd] = useState(null);
  const [prog, setProg] = useState(null);
  const check = async () => {
    setSt({ phase: 'checking' }); setUpd(null); setProg(null);
    const r = await checkForUpdate();
    if (r.error) { setSt({ phase: 'error', error: r.error }); toast?.('检查更新失败：' + r.error, 'err'); return; }
    if (!r.available) { setSt({ phase: 'none' }); toast?.('已是最新版本', 'ok'); return; }
    setUpd(r); setSt({ phase: 'available' });
  };
  const install = async () => {
    if (!upd?.raw) return;
    setSt({ phase: 'downloading' });
    try {
      await installAndRelaunch(upd.raw, (p) => setProg(p));
    } catch (e) {
      setSt({ phase: 'error', error: String(e?.message || e) });
      toast?.('更新安装失败：' + (e?.message || e), 'err');
    }
  };
  const pct = prog?.contentLength ? Math.min(100, Math.round(100 * (prog.downloaded || 0) / prog.contentLength)) : null;
  return <section><h3>软件更新</h3>
    <div className="hint">当前版本 {info?.version || '—'} · 通过 GitHub Releases 检查更新</div>
    <div className="row2" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
      <button className="btn btn-sm" disabled={st.phase === 'checking' || st.phase === 'downloading'} onClick={check}>
        {st.phase === 'checking' ? '检查中…' : '检查更新'}
      </button>
      {st.phase === 'available' && <button className="btn-primary btn-sm" onClick={install}>下载并安装 {upd?.version}</button>}
      {st.phase === 'downloading' && <span className="hint">下载中{pct != null ? ` ${pct}%` : '…'}，完成后将自动重启</span>}
      {st.phase === 'none' && <span className="hint">已是最新</span>}
      {st.phase === 'error' && <span className="hint" style={{ color: 'var(--danger, #e07a5f)' }}>{st.error}</span>}
    </div>
    {st.phase === 'available' && upd && (
      <div className="card" style={{ marginTop: 10, padding: 10 }}>
        <b>v{upd.version}</b>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 160, overflow: 'auto', margin: '6px 0 0' }}>{upd.notes || '（无更新说明）'}</pre>
      </div>
    )}
  </section>;
}

// 首次运行 / 自修复向导：运行资源 → 浏览器（可下载，带进度与镜像回退）→ 模型
export function FirstRun({ settings, onSave, onDone }) {
  const [doc, setDoc] = useState(null);
  const [s, setS] = useState(settings);
  const up = deepUp(setS);
  const refresh = () => window.api.invoke('doctor').then(setDoc).catch(() => {});
  useEffect(() => { refresh(); const off = window.api.on('download-progress', p => { if (p.phase === 'done') setTimeout(refresh, 500); }); return off; }, []);
  const c = s.provider === 'anthropic' ? 'anthropic' : 'openai';
  const keyOk = !!s[c].apiKey && !!s[c].baseUrl && !!s[c].model;
  const ready = doc?.chromeOk && keyOk;
  return <div className="overlay"><div className="modal firstrun">
    <div className="fr-head"><LogoMark size={40} className="mark-lg" /><div><h2>准备就绪检查</h2><div className="hint">首次运行或环境缺失时自动出现，完成后即可开始。</div></div></div>
    <div className="fr-step"><div className={'fr-ic ' + (doc ? (doc.runtime?.error ? 'err' : 'ok') : '')}>{doc ? (doc.runtime?.error ? '!' : '✓') : '…'}</div>
      <div className="fr-b"><b>运行组件</b><div className="hint">{doc ? (doc.runtime?.error || (doc.runtime?.repaired ? '已自动修复缺失的运行组件' : '完整')) : '检查中…'}</div></div></div>
    <div className="fr-step"><div className={'fr-ic ' + (doc?.chromeOk ? 'ok' : '')}>{doc?.chromeOk ? '✓' : '2'}</div>
      <div className="fr-b"><b>浏览器</b><ChromeBlock compact toast={null} up={null} /></div></div>
    <div className="fr-step"><div className={'fr-ic ' + (keyOk ? 'ok' : '')}>{keyOk ? '✓' : '3'}</div>
      <div className="fr-b"><b>AI 模型</b><ProviderFields s={s} up={up} /><TestButton s={s} /></div></div>
    <div className="modal-f">
      <button className="btn-ghost" onClick={onDone}>稍后</button>
      <button className="btn-primary" disabled={!ready} onClick={async () => { await onSave(s); onDone(); }}><Icon n="check" size={13} />开始使用</button>
    </div>
  </div></div>;
}
