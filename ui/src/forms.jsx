import React, { useEffect, useState } from 'react';
import { Icon, LogoMark, askConfirm } from './components.jsx';
import { native } from './transport.js';
import { checkForUpdate, installAndRelaunch } from './updater.js';

function deepUp(setS) {
  return (p, v) => setS(prev => { const c = JSON.parse(JSON.stringify(prev)); const ks = p.split('.'); let o = c; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; return c; });
}

// 上下文窗口：快捷档位 + 自定义；空值 = 按模型名推断
export const WINDOW_PRESETS = [[128000, '128K'], [256000, '256K'], [300000, '300K'], [500000, '500K'], [1000000, '1M']];
export function WindowChips({ value, onChange, inferredLimit }) {
  const preset = WINDOW_PRESETS.some(([v]) => v === value);
  const [custom, setCustom] = useState(!preset && value ? String(Math.round(value / 1000)) : '');
  useEffect(() => { if (!preset && value) setCustom(String(Math.round(value / 1000))); }, [value, preset]);
  const commit = t => { const k = parseFloat(t); if (k >= 4) onChange(Math.round(k * 1000)); };
  return <div className="wchips">
    <button className={!value ? 'on' : ''} onClick={() => { setCustom(''); onChange(0); }} title={inferredLimit ? `按模型名推断：${Math.round(inferredLimit / 1000)}K` : '按模型名推断'}>自动</button>
    {WINDOW_PRESETS.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => { setCustom(''); onChange(v); }}>{l}</button>)}
    <span className={'wcustom ' + (value && !preset ? 'on' : '')}><input value={custom} placeholder="自定义" inputMode="numeric" onChange={e => setCustom(e.target.value.replace(/[^\d.]/g, ''))} onBlur={e => commit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); commit(e.target.value); e.target.blur(); } }} />K</span>
  </div>;
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
    if (r.ok) { if (!chromes?.length) up && up('kernel', 'bundled'); toast?.(`浏览器已就绪（${r.version}，来源：${r.source}）`, 'ok'); refresh(); }
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

// 浏览器内核：系统 Chrome（默认）/ 按需下载的内置 Chromium（Chrome for Testing）
function KernelBlock({ s, up, toast }) {
  const [info, setInfo] = useState(null);
  const [dl, setDl] = useState(null);
  const [err, setErr] = useState('');
  const refresh = () => window.api.invoke('kernel-info').then(setInfo).catch(() => setInfo({}));
  useEffect(() => { refresh(); return window.api.on('download-progress', p => setDl(p.phase === 'done' ? null : p)); }, []);
  const k = s.kernel || 'system', b = info?.bundled;
  async function download() {
    setErr(''); setDl({ phase: 'download', got: 0, total: 0 });
    const r = await window.api.invoke('download-chrome').catch(e => ({ ok: false, error: e.message }));
    setDl(null); refresh();
    if (r.ok) { up('kernel', 'bundled'); toast?.(`内置 Chromium ${r.version} 已就绪`, 'ok'); } else setErr(r.error);
  }
  async function del() {
    if (!await askConfirm('删除已下载的内置 Chromium？使用它的浏览器会被关闭。', { ok: '删除', danger: true })) return;
    await window.api.invoke('kernel-delete'); if (k === 'bundled') up('kernel', 'system'); refresh();
  }
  const pct = dl && dl.total ? Math.round(dl.got / dl.total * 100) : null;
  return <>
    <div className="field"><label>浏览器内核</label>
      <div className="seg-ctl sm"><button className={k === 'system' ? 'on' : ''} onClick={() => up('kernel', 'system')}>系统 Chrome</button><button className={k === 'bundled' ? 'on' : ''} onClick={() => up('kernel', 'bundled')}>内置 Chromium</button></div>
    </div>
    {k === 'system' ? <>
      <div className="field"><label>Chrome / Edge 路径</label><input value={s.chromePath || ''} onChange={e => up('chromePath', e.target.value)} placeholder="留空自动检测" spellCheck={false} /></div>
      <div className="chromeblk">{info === null ? <div className="hint">检测中…</div> : info.system ? <div className="okline"><Icon n="check" size={13} />{info.system.source} · <span className="mono">{info.system.path}</span></div> : <div className="warnline"><Icon n="info" size={13} />未检测到系统 Chrome / Edge</div>}</div>
    </> : <div className="chromeblk">
      {b ? <div className="okline kline"><Icon n="check" size={13} /><span>Chrome for Testing {b.version || ''} · {(b.diskBytes / 1e6).toFixed(0)} MB{b.sha256 ? <> · <span className="mono" title={b.sha256}>sha256 {b.sha256.slice(0, 12)}</span></> : ''}{b.md5Verified ? ' · MD5 已校验' : ''}</span><span className="grow" /><button className="btn-ghost btn-sm" onClick={del} disabled={!!dl}><Icon n="x" size={11} />删除</button></div>
        : !dl && <div className="warnline"><Icon n="info" size={13} />未下载（约 170 MB，存放于应用数据目录）</div>}
      {dl ? <div className="progress"><div className="bar"><div style={{ width: (pct ?? 8) + '%' }} className={pct == null ? 'indet' : ''} /></div>
        <span>{dl.phase === 'extract' ? '解压中…' : `${pct != null ? pct + '% · ' : ''}${(dl.got / 1e6).toFixed(0)}${dl.total ? '/' + (dl.total / 1e6).toFixed(0) : ''} MB`}</span></div>
        : !b && <button className="btn-primary btn-sm" onClick={download}><Icon n="download" size={12} />下载内置 Chromium</button>}
      {b && !dl && <button className="btn btn-sm" onClick={download}><Icon n="reload" size={12} />重新下载 / 更新</button>}
      {err && <div className="testmsg err">{err}</div>}
    </div>}
  </>;
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
      <KernelBlock s={s} up={up} toast={toast} />
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
      <div className="field"><label>上下文窗口<span className="lbl-sub">{(s.provider === 'anthropic' ? s.anthropic.model : s.openai.model) || '当前模型'}</span></label>
        <WindowChips value={(s.provider === 'anthropic' ? s.anthropic : s.openai).contextWindow || 0} onChange={v => up((s.provider === 'anthropic' ? 'anthropic' : 'openai') + '.contextWindow', v)} /></div>
      <div className="field"><label>自动压缩</label><div className="seg-ctl sm">{[[0.8, '80%'], [0.85, '85%'], [0.9, '90%']].map(([v, l]) => <button key={v} className={(s.compactAt || 0.85) === v ? 'on' : ''} onClick={() => up('compactAt', v)}>{l}</button>)}</div>
        <div className="hint">先收起旧工具结果，仍超出再由模型生成结构化摘要；最近的对话原样保留</div></div>
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
      await installAndRelaunch(upd.raw, (p) => {
        if (p.event === 'Installing') setSt({ phase: 'installing' });
        setProg(p);
      });
    } catch (e) {
      setSt({ phase: 'error', error: String(e?.message || e) });
      toast?.('更新安装失败：' + (e?.message || e), 'err');
    }
  };
  const busy = st.phase === 'checking' || st.phase === 'downloading' || st.phase === 'installing';
  const pct = prog?.contentLength ? Math.min(100, Math.round(100 * (prog.downloaded || 0) / prog.contentLength)) : null;
  return <section><h3>软件更新</h3>
    <div className="hint">当前版本 {info?.version || '—'} · 通过 GitHub Releases 检查更新</div>
    <div className="row2" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
      <button className="btn btn-sm" disabled={busy} onClick={check}>
        {st.phase === 'checking' ? '检查中…' : '检查更新'}
      </button>
      {st.phase === 'available' && <button className="btn-primary btn-sm" onClick={install}>下载并安装 {upd?.version}</button>}
      {st.phase === 'downloading' && <span className="hint">下载中{pct != null ? ` ${pct}%` : '…'}</span>}
      {st.phase === 'installing' && <span className="hint">正在安装</span>}
      {st.phase === 'none' && <span className="hint">已是最新</span>}
      {st.phase === 'error' && <span className="hint" style={{ color: 'var(--danger, #e07a5f)' }}>{st.error}</span>}
    </div>
    {(st.phase === 'downloading' || st.phase === 'installing') && (
      <div className="progress" style={{ marginTop: 8 }}>
        <div className="bar"><div className={pct == null || st.phase === 'installing' ? 'indet' : ''} style={{ width: st.phase === 'installing' ? '45%' : ((pct ?? 8) + '%') }} /></div>
        <span>{st.phase === 'installing' ? '正在安装' : (pct != null ? pct + '%' : '…')}</span>
      </div>
    )}
    {st.phase === 'installing' && <div className="hint">正在关闭侧车、捆绑 Node 和本应用打开的浏览器，随后安装并自动重新打开。</div>}
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
