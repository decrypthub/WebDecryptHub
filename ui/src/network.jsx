// 请求/证据：DevTools 风格抓包面板（列表 + 详情子页签）
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Icon, EmptyState, CtxMenu } from './components.jsx';
import { native } from './transport.js';
import { parseQuery, parseBody } from '../../sidecar/sig.mjs';

const TYPES = [['all', '全部'], ['api', 'XHR/Fetch'], ['js', 'JS'], ['doc', 'Doc'], ['other', '其他']];
const typeGroup = t => (t === 'xhr' || t === 'fetch') ? 'api' : t === 'script' ? 'js' : t === 'document' ? 'doc' : 'other';
export const fmtSize = n => n == null ? '–' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB';
const fmtMs = n => n == null ? '–' : n < 1000 ? n + ' ms' : (n / 1000).toFixed(2) + ' s';
const stClass = s => s === 'pending' ? 'pend' : s === 'failed' || s === 0 ? 'bad' : s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'redir' : 'ok';
function splitUrl(u) { try { const x = new URL(u); const name = x.pathname.split('/').filter(Boolean).pop() || x.host; return { name: name + (x.search ? '?' + x.search.slice(1, 40) : ''), host: x.host, path: x.pathname }; } catch { return { name: u.slice(0, 60), host: '', path: '' }; } }

export async function copyText(text, toast, what = '内容') {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast?.(`已复制${what}`, 'ok');
}
const shq = s => "'" + String(s).replace(/'/g, `'\\''`) + "'";
function toCurl(d) {
  const h = Object.entries(d.headers || {}).filter(([k]) => !k.startsWith(':') && k !== 'content-length');
  return ['curl ' + shq(d.url), d.method !== 'GET' ? `  -X ${d.method}` : null, ...h.map(([k, v]) => `  -H ${shq(k + ': ' + v)}`), d.postData != null ? `  --data-raw ${shq(d.postData)}` : null, '  --compressed'].filter(Boolean).join(' \\\n');
}
function toPython(d) {
  const h = Object.fromEntries(Object.entries(d.headers || {}).filter(([k]) => !k.startsWith(':') && !['content-length', 'cookie', 'accept-encoding'].includes(k)));
  const cookies = Object.fromEntries(String(d.headers?.cookie || '').split(/;\s*/).filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  let base = d.url, params = null; try { const u = new URL(d.url); if ([...u.searchParams].length) { params = Object.fromEntries(u.searchParams); base = u.origin + u.pathname; } } catch {}
  const py = v => JSON.stringify(v, null, 4).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None');
  const ct = d.headers?.['content-type'] || ''; const pb = parseBody(d.postData, ct);
  const lines = ['import requests', '', `url = ${JSON.stringify(base)}`, `headers = ${py(h)}`];
  if (Object.keys(cookies).length) lines.push(`cookies = ${py(cookies)}`);
  if (params) lines.push(`params = ${py(params)}`);
  if (pb.kind === 'json') lines.push(`json_data = ${py(pb.json)}`); else if (d.postData != null) lines.push(`data = ${JSON.stringify(d.postData)}`);
  const args = ['url', params && 'params=params', 'headers=headers', Object.keys(cookies).length && 'cookies=cookies', pb.kind === 'json' ? 'json=json_data' : d.postData != null ? 'data=data' : null].filter(Boolean);
  lines.push('', `resp = requests.request(${JSON.stringify(d.method)}, ${args.join(', ')})`, 'print(resp.status_code)', 'print(resp.text[:2000])');
  return lines.join('\n');
}

export function NetworkPane({ cur, inv, toast, onAttach, onPrompt }) {
  const [q, setQ] = useState('');
  const [tg, setTg] = useState('api');
  const [onlySig, setOnlySig] = useState(false);
  const [sel, setSel] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState('req');
  const [script, setScript] = useState(null);
  const [menu, setMenu] = useState(false);
  const [ctx, setCtx] = useState(null);
  const listRef = useRef(); const stick = useRef(true);
  const all = cur.requests;
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return all.filter(r => (tg === 'all' || typeGroup(r.type) === tg) && (!onlySig || r.sig?.length) && (!ql || r.url.toLowerCase().includes(ql) || (r.sig || []).some(s => s.toLowerCase().includes(ql))));
  }, [all, q, tg, onlySig]);
  const counts = useMemo(() => { const c = { all: all.length, api: 0, js: 0, doc: 0, other: 0 }; for (const r of all) c[typeGroup(r.type)]++; return c; }, [all]);
  // 只有停在底部且未选中行时才自动跟随新请求；选中后列表保持不动（不跳行）
  useEffect(() => { const el = listRef.current; if (el && stick.current && !sel) el.scrollTop = el.scrollHeight; }, [list.length]);
  const selSum = sel ? all.find(r => r.id === sel) : null;

  function attachRequest(r, intent) {
    if (!r) return;
    const label = intent === 'analyze-sig' ? `签名 ${r.id}` : intent === 'reproduce' ? `复现 ${r.id}` : `${r.id} ${r.method || ''} ${shortPath(r.url)}`;
    onAttach?.({ key: 'r:' + r.id + (intent ? ':' + intent : ''), kind: 'request', id: r.id, intent, label });
    if (intent === 'analyze-sig') onPrompt?.('分析这个请求里的签名参数，定位生成代码。');
    else if (intent === 'reproduce') onPrompt?.('在本地复现这个请求，并和浏览器结果对比。');
  }
  async function sendStack() {
    toast?.('正在读取断点调用栈…', 'info', 1600);
    try {
      const r = await inv('debug-paused');
      if (!r?.paused) { toast?.(String(r?.text || '当前没有暂停的断点').replace(/\s+/g, ' ').slice(0, 180), 'warn', 5000); return; }
      onAttach?.({ key: 'stack:' + Date.now(), kind: 'snippet', intent: 'stack', label: '断点调用栈', text: r.text });
      onPrompt?.('根据断点调用栈和作用域，定位签名函数并说明下一步。');
    } catch (e) { toast?.('读取调用栈失败：' + (e.message || e), 'err'); }
  }
  async function doExport(kind) {
    setMenu(false);
    const ids = kind === 'all' ? null : kind === 'filtered' ? list.map(r => r.id) : [...(checked.size ? checked : sel ? [sel] : [])];
    if (ids && !ids.length) { toast('没有可导出的请求', 'warn'); return; }
    let host = 'capture'; try { host = new URL(cur.url).host.replace(/^www\./, '') || host; } catch {}
    const name = `${host}-${kind === 'all' ? 'all' : kind === 'filtered' ? 'filtered' : 'selected'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.har`;
    const path = await native.pickSavePath(name).catch(e => { toast('无法打开保存对话框：' + e, 'err'); return null; });
    if (!path) return;
    try { const r = await inv('har-export', { ids, path: /\.har$/i.test(path) ? path : path + '.har' }); toast(`已导出 ${r.entries} 条 · ${fmtSize(r.bytes)}`, 'ok', 5000); }
    catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  const toolbar = <div className="nw-tools">
    <div className="seg-ctl sm">{[['req', `请求 ${all.length}`], ['js', `脚本 ${cur.scripts.length}`]].map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}</div>
    <div className="nw-search"><Icon n="search" size={12} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={mode === 'req' ? '过滤 URL / 参数名' : '过滤脚本 URL'} spellCheck={false} />{q && <button className="icon-btn xs" onClick={() => setQ('')}><Icon n="x" size={11} /></button>}</div>
    <button className="btn btn-sm" onClick={sendStack} title="把当前断点的调用栈和作用域发给 AI"><Icon n="layers" size={12} />调用栈</button>
    {mode === 'req' && <>
      <button className={'chip-btn ' + (onlySig ? 'on' : '')} onClick={() => setOnlySig(v => !v)} title="只看携带疑似签名参数的请求"><Icon n="key" size={12} />签名</button>
      <button className={'icon-btn ' + (paused ? 'warn' : '')} onClick={async () => setPaused(await inv('net-pause', { paused: !paused }))} title={paused ? '继续抓包' : '暂停抓包'}><Icon n={paused ? 'play' : 'pause'} size={12} /></button>
      <button className="icon-btn" onClick={() => { inv('clear-requests'); setSel(null); setChecked(new Set()); }} title="清空"><Icon n="broom" size={13} /></button>
      <button className="btn btn-sm" disabled={!checked.size && !sel} onClick={() => { const ids = checked.size ? [...checked] : [sel]; onAttach?.(ids.map(id => { const r = all.find(x => x.id === id); return { key: 'r:' + id, kind: 'request', id, label: `${id} ${r?.method || ''} ${shortPath(r?.url)}` }; })); }} title="把选中请求加入 AI 对话上下文"><Icon n="sparkles" size={12} />发给 AI{checked.size > 1 ? ' ' + checked.size : ''}</button>
      <div className="menu-wrap">
        <button className="btn btn-sm" onClick={() => setMenu(m => !m)}><Icon n="download" size={12} />HAR<Icon n="chevdown" size={11} /></button>
        {menu && <div className="menu" onMouseLeave={() => setMenu(false)}>
          <button onClick={() => doExport('all')}>导出全部<span>{all.length}</span></button>
          <button onClick={() => doExport('filtered')}>导出筛选结果<span>{list.length}</span></button>
          <button onClick={() => doExport('selected')} disabled={!checked.size && !sel}>导出选中<span>{checked.size || (sel ? 1 : 0)}</span></button>
        </div>}
      </div>
    </>}
  </div>;

  if (mode === 'js') return <div className="nw">{toolbar}<ScriptList cur={cur} q={q} inv={inv} script={script} setScript={setScript} onAttach={onAttach} onPrompt={onPrompt} onStack={sendStack} /></div>;

  return <div className="nw">
    {toolbar}
    <div className="nw-chips">
      {TYPES.map(([k, l]) => <button key={k} className={'tchip ' + (tg === k ? 'on' : '')} onClick={() => setTg(k)}>{l}<span>{counts[k]}</span></button>)}
      <span className="grow" />
      {paused && <span className="paused-tag">已暂停</span>}
      <span className="hint">{list.length} / {all.length}</span>
    </div>
    <PanelGroup direction="vertical" autoSaveId="wdh-net2">
      <Panel defaultSize={sel ? 42 : 100} minSize={18} id="nl" order={1}>
        <div className="nw-head"><span /><span>方法</span><span>状态</span><span>名称</span><span>类型</span><span className="r">大小</span><span className="r">时间</span></div>
        <div className="nw-list" ref={listRef} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
          {list.length === 0 ? <EmptyState icon="network" title={all.length ? '没有匹配的请求' : '暂无请求'} desc={all.length ? '调整过滤条件' : '在左侧打开网址后自动抓包'} />
            : list.slice(-1500).map(r => { const u = splitUrl(r.url); return <div key={r.id} className={'nw-row ' + (sel === r.id ? 'sel ' : '') + (r.status === 'failed' ? 'failed' : '')} onClick={() => setSel(r.id === sel ? null : r.id)} onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, req: r }); }} title={r.url}>
              <span onClick={e => e.stopPropagation()}><input type="checkbox" checked={checked.has(r.id)} onChange={e => { const n = new Set(checked); e.target.checked ? n.add(r.id) : n.delete(r.id); setChecked(n); }} /></span>
              <span className={'m ' + r.method}>{r.method}</span>
              <span className={'stc ' + stClass(r.status)}>{r.status === 'pending' ? '…' : r.status === 'failed' ? '失败' : r.status}</span>
              <span className="nm"><b>{u.name}</b><i>{r.sig?.length > 0 && <em className={r.sigLevel}><Icon n="key" size={9} />{r.sig.slice(0, 3).join(' ')}</em>}{r.status === 'failed' && r.failure ? <u>{r.failure}</u> : null}{u.host}</i></span>
              <span className="ty">{r.type}</span>
              <span className="r">{fmtSize(r.size ?? r.encodedSize)}</span>
              <span className="r">{fmtMs(r.duration)}</span>
            </div>; })}
        </div>
      </Panel>
      {sel && <><PanelResizeHandle className="resize-handle h" />
        <Panel minSize={25} defaultSize={58} id="nd" order={2}><RequestDetail id={sel} sum={selSum} inv={inv} toast={toast} onClose={() => setSel(null)} onSend={intent => attachRequest(selSum, intent)} /></Panel></>}
    </PanelGroup>
    {ctx && <CtxMenu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={[
      { label: '分析此签名', onClick: () => attachRequest(ctx.req, 'analyze-sig') },
      { label: '复现此请求', onClick: () => attachRequest(ctx.req, 'reproduce') },
      { label: '发给 AI', onClick: () => attachRequest(ctx.req) },
    ]} />}
  </div>;
}

function shortPath(u) { try { const x = new URL(u); return (x.pathname.split('/').filter(Boolean).pop() || x.host).slice(0, 28); } catch { return ''; } }
function ScriptList({ cur, q, inv, script, setScript, onAttach, onPrompt, onStack }) {
  const list = cur.scripts.filter(s => !q || s.url.toLowerCase().includes(q.toLowerCase()));
  const [menu, setMenu] = useState(null);
  const selText = useRef('');
  function sendSelection(text) {
    if (!script) return;
    if (text) {
      onAttach?.({ key: 'snip:' + script.id + ':' + text.length + ':' + text.slice(0, 24), kind: 'snippet', intent: 'selection', label: `选区 ${script.id}`, text: `脚本 ${script.id} ${script.url}\n选区:\n${text}` });
      onPrompt?.('解释这段选中源码在签名流程中的作用。');
    } else onAttach?.({ key: 's:' + script.id, kind: 'script', id: script.id, label: script.id + ' ' + splitUrl(script.url).name });
  }
  return <PanelGroup direction="vertical" autoSaveId="wdh-js">
    <Panel defaultSize={40} minSize={15}><div className="nw-list">{list.length ? list.slice().reverse().map(s => <div key={s.id} className={'nw-row js ' + (script?.id === s.id ? 'sel' : '')} onClick={async () => { setScript({ ...s, content: '加载中…' }); setScript({ ...s, content: await inv('read-file', { file: s.file }) }); }}><span className="tag-badge">{s.id}</span><span className="nm"><b>{splitUrl(s.url).name}</b><i>{splitUrl(s.url).host}</i></span><span className="r">{fmtSize(s.size)}</span></div>) : <EmptyState icon="code" title="暂无脚本" />}</div></Panel>
    <PanelResizeHandle className="resize-handle h" />
    <Panel minSize={20}>{script ? <div className="js-view"><div className="fv-h"><span>{splitUrl(script.url).name}</span><button className="btn btn-sm" onClick={() => sendSelection(String(window.getSelection?.() || '').trim() || selText.current)} title="选中文字则发送片段，否则发送整个脚本"><Icon n="sparkles" size={12} />发给 AI</button><button className="btn btn-sm" onClick={onStack} title="把当前断点调用栈发给 AI"><Icon n="layers" size={12} />调用栈</button></div>
      <pre className="codearea" onMouseUp={() => { selText.current = String(window.getSelection?.() || '').trim(); }} onContextMenu={e => { const t = String(window.getSelection?.() || '').trim() || selText.current; if (!t) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, text: t }); }}>{String(script.content).slice(0, 200000)}</pre>
      {menu && <CtxMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[{ label: '把选区发给 AI', onClick: () => sendSelection(menu.text) }]} />}
    </div> : <EmptyState icon="code" title="选择脚本查看源码" />}</Panel>
  </PanelGroup>;
}

const DTABS = [['ov', '概览'], ['hd', '请求头'], ['pl', '载荷'], ['rs', '响应'], ['tm', '时序']];
function RequestDetail({ id, sum, inv, toast, onClose, onSend }) {
  const [d, setD] = useState(null);
  const [tab, setTab] = useState(() => localStorage.getItem('wdh_dtab') || 'ov');
  const [copyMenu, setCopyMenu] = useState(false);
  useEffect(() => { localStorage.setItem('wdh_dtab', tab); }, [tab]);
  const ver = sum ? `${sum.status}|${sum.bodyState}|${sum.duration}` : '';
  useEffect(() => { let live = true; inv('net-detail', { id }).then(x => live && setD(x)).catch(() => {}); return () => { live = false; }; }, [id, ver]);
  if (!d) return <div className="nd"><EmptyState icon="network" title={sum ? '加载中…' : '该请求已被清除'} /></div>;
  const sigNames = new Set((d.sig || []).map(s => s.name.toLowerCase()));
  const cp = (t, w) => copyText(t, toast, w);
  return <div className="nd">
    <div className="nd-h">
      <span className={'m ' + d.method}>{d.method}</span><span className={'stc ' + stClass(d.status)}>{d.status === 'failed' ? '失败' : d.status}</span>
      <span className="nd-url" title={d.url}>{d.url}</span>
      <button className="btn btn-sm" onClick={() => onSend?.('analyze-sig')} title="把这条请求和发起者发给 AI，分析签名"><Icon n="key" size={12} />分析签名</button>
      <button className="btn btn-sm" onClick={() => onSend?.('reproduce')} title="把这条请求发给 AI，做本地复现"><Icon n="sparkles" size={12} />复现</button>
      <div className="menu-wrap">
        <button className="btn btn-sm" onClick={() => setCopyMenu(m => !m)}><Icon n="copy" size={12} />复制<Icon n="chevdown" size={11} /></button>
        {copyMenu && <div className="menu right" onMouseLeave={() => setCopyMenu(false)} onClick={() => setCopyMenu(false)}>
          <button onClick={() => cp(d.url, ' URL')}>复制 URL</button>
          <button onClick={() => cp(toCurl(d), ' cURL')}>复制为 cURL (bash)</button>
          <button onClick={() => cp(toPython(d), ' Python requests')}>复制为 Python requests</button>
          {d.body && <button onClick={() => cp(d.body.text, '响应体')}>复制响应体</button>}
        </div>}
      </div>
      <button className="icon-btn" onClick={onClose} title="关闭详情"><Icon n="x" size={13} /></button>
    </div>
    <div className="nd-tabs">{DTABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'pl' && d.sig?.length > 0 && <span className="sigdot" />}</button>)}</div>
    <div className="nd-body">
      {tab === 'ov' && <Overview d={d} cp={cp} />}
      {tab === 'hd' && <>
        <Section title="请求头" count={Object.keys(d.headers || {}).length} copy={() => cp(hdrText(d.headers), '请求头')}><KVTable o={d.headers} hi={sigNames} /></Section>
        <Section title="响应头" count={Object.keys(d.respHeaders || {}).length} copy={() => cp(d.respHeadersText || hdrText(d.respHeaders), '响应头')}><KVTable o={d.respHeaders} /></Section>
      </>}
      {tab === 'pl' && <Payload d={d} hi={sigNames} cp={cp} />}
      {tab === 'rs' && <ResponseView d={d} cp={cp} />}
      {tab === 'tm' && <Timing d={d} />}
    </div>
  </div>;
}
const hdrText = o => Object.entries(o || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

function Section({ title, count, copy, extra, children, open: o0 = true }) {
  const [open, setOpen] = useState(o0);
  return <div className="sec">
    <div className="sec-h" onClick={() => setOpen(v => !v)}><Icon n={open ? 'chevdown' : 'chevright'} size={12} /><span>{title}</span>{count != null && <span className="cnt">{count}</span>}<span className="grow" />{extra}{copy && <button className="icon-btn xs" onClick={e => { e.stopPropagation(); copy(); }} title="复制本节"><Icon n="copy" size={11} /></button>}</div>
    {open && <div className="sec-b">{children}</div>}
  </div>;
}

function KVTable({ o, rows, hi }) {
  const list = rows || Object.entries(o || {}).filter(([k]) => !k.startsWith(':')).map(([name, value]) => ({ name, value }));
  if (!list.length) return <div className="hint pad">（无）</div>;
  return <div className="kvt">{list.map((r, i) => { const h = hi?.has(String(r.name).toLowerCase()); return <div key={i} className={'kvr ' + (h ? 'hi' : '')}><span className="k">{h && <Icon n="key" size={10} />}{r.name}</span><span className="v">{String(r.value)}</span></div>; })}</div>;
}

function Overview({ d, cp }) {
  const rows = [['URL', d.url], ['方法', d.method], ['状态', `${d.status} ${d.statusText || ''}`], ['类型', d.type], ['MIME', d.mime || '–'], ['远端地址', d.remoteIP || '–'], ['协议', d.protocol || '–'],
    ['大小', `${fmtSize(d.size)}（传输 ${fmtSize(d.encodedSize)}）${d.fromCache ? ' · 缓存' : ''}`], ['耗时', fmtMs(d.duration)], ['开始时间', new Date(d.time).toLocaleString('zh-CN', { hour12: false })],
    ['发起者', d.initiator ? `${d.initiator.type}${d.initiator.fn ? ' · ' + d.initiator.fn : ''}${d.initiator.url ? ' · ' + d.initiator.url + ':' + d.initiator.line : ''}` : '–'], ['响应体', d.body ? (d.body.encoding ? 'base64 二进制' : '文本') + ' · ' + fmtSize(d.body.size) : (d.bodyState || '–') + (d.bodyError ? ' · ' + d.bodyError : '')]];
  if (d.failure) rows.splice(3, 0, ['失败原因', d.failure]);
  return <>
    {d.sig?.length > 0 && <div className="sigbox"><div className="sigbox-h"><Icon n="key" size={12} />疑似签名参数 {d.sig.length}</div>{d.sig.map((s, i) => <div key={i} className={'sigrow ' + s.level}><span className="w">{({ query: '查询', header: '请求头', body: '请求体' })[s.where]}</span><b>{s.name}</b><code onClick={() => cp(s.value, ' ' + s.name)} title="点击复制">{s.value}</code></div>)}</div>}
    <Section title="常规" copy={() => cp(rows.map(r => r.join(': ')).join('\n'), '概览')}><KVTable rows={rows.map(([name, value]) => ({ name, value }))} /></Section>
  </>;
}

function Payload({ d, hi, cp }) {
  const [view, setView] = useState('parsed');
  const qs = d.query || [];
  const ct = d.headers?.['content-type'] || ''; const pb = parseBody(d.postData, ct);
  return <>
    <Section title="查询参数" count={qs.length} copy={() => cp(qs.map(x => `${x.name}=${x.value}`).join('\n'), '查询参数')} extra={<span className="hint">已解码</span>}><KVTable rows={qs} hi={hi} /></Section>
    {d.postData != null ? <Section title={'请求体 · ' + ({ json: 'JSON', form: '表单', multipart: 'multipart', raw: '原始' })[pb.kind]} copy={() => cp(d.postData, '请求体')}
      extra={pb.kind !== 'raw' && <div className="seg-ctl xs" onClick={e => e.stopPropagation()}>{[['parsed', pb.kind === 'json' ? '格式化' : '表格'], ['raw', '原始']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>}>
      {view === 'raw' || pb.kind === 'raw' || pb.kind === 'multipart' ? <pre className="raw">{d.postData}</pre> : pb.kind === 'json' ? <JsonView value={pb.json} hi={hi} /> : <KVTable rows={pb.fields} hi={hi} />}
    </Section> : <div className="hint pad">无请求体</div>}
  </>;
}

function ResponseView({ d, cp }) {
  const [view, setView] = useState('pretty');
  const b = d.body;
  if (!b) return <EmptyState icon="file" title="没有响应体" desc={({ none: '该请求无响应体或类型不保存', 'too-large': '超过 5 MB 未保存', error: '浏览器未保留响应体' + (d.bodyError ? '：' + d.bodyError : '') })[d.bodyState] || '尚未完成'} />;
  let json = null; if (!b.encoding && /json|^\s*[\[{]/.test(d.mime + b.text.slice(0, 2))) { try { json = JSON.parse(b.text); } catch {} }
  const img = b.encoding && /^image\//.test(d.mime);
  return <Section title={`响应体 · ${d.mime || '未知类型'} · ${fmtSize(b.size)}${b.truncated ? '（显示已截断）' : ''}`} copy={() => cp(b.text, '响应体')}
    extra={!img && <div className="seg-ctl xs" onClick={e => e.stopPropagation()}>{[['pretty', json ? 'JSON' : '格式化'], ['raw', '原始']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>}>
    {img ? <div className="imgprev"><img src={`data:${d.mime};base64,${b.text}`} /></div>
      : b.encoding ? <pre className="raw">{'(二进制，base64)\n' + b.text.slice(0, 20000)}</pre>
      : view === 'pretty' && json != null ? <JsonView value={json} />
      : <pre className="raw">{view === 'pretty' && /html|xml/.test(d.mime) ? b.text : b.text}</pre>}
  </Section>;
}

// 轻量 JSON 树：可折叠，语法着色，签名键高亮
function JsonView({ value, hi }) { return <div className="json"><JNode v={value} depth={0} hi={hi} /></div>; }
function JNode({ k, v, depth, hi, last = true }) {
  const [open, setOpen] = useState(depth < 2);
  const key = k != null ? <span className={'jk ' + (hi?.has(String(k).toLowerCase()) ? 'hi' : '')}>{typeof k === 'number' ? k : JSON.stringify(k)}: </span> : null;
  const comma = last ? '' : ',';
  if (v && typeof v === 'object') {
    const arr = Array.isArray(v); const ents = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
    if (!ents.length) return <div className="jl">{key}<span className="jp">{arr ? '[]' : '{}'}</span>{comma}</div>;
    return <div className="jl"><span className="jt" onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'}</span>{key}<span className="jp">{arr ? '[' : '{'}</span>
      {open ? <div className="jc">{ents.slice(0, 500).map(([kk, vv], i) => <JNode key={kk} k={kk} v={vv} depth={depth + 1} hi={hi} last={i === Math.min(ents.length, 500) - 1} />)}{ents.length > 500 && <div className="hint">… 另 {ents.length - 500} 项</div>}</div>
        : <span className="jsum" onClick={() => setOpen(true)}>{arr ? ` ${ents.length} 项 ` : ` ${ents.length} 键 `}</span>}
      <span className="jp">{arr ? ']' : '}'}</span>{comma}</div>;
  }
  const cls = typeof v === 'string' ? 'js' : typeof v === 'number' ? 'jn' : 'jb';
  return <div className="jl">{key}<span className={cls}>{JSON.stringify(v)}</span>{comma}</div>;
}

function Timing({ d }) {
  const t = d.timing;
  if (!t) return <EmptyState icon="info" title="无时序数据" desc={d.fromCache ? '来自缓存' : '请求未完成或为导入数据'} />;
  const seg = (a, b) => (a >= 0 && b >= 0 && b >= a ? b - a : null);
  const end = t.endMs ?? t.receiveHeadersEnd;
  const rows = [['排队/阻塞', 0, t.dnsStart >= 0 ? t.dnsStart : t.connectStart >= 0 ? t.connectStart : t.sendStart, 'q'], ['DNS 查询', t.dnsStart, t.dnsEnd, 'dns'], ['建立连接', t.connectStart, t.connectEnd, 'con'], ['TLS 握手', t.sslStart, t.sslEnd, 'ssl'],
    ['发送请求', t.sendStart, t.sendEnd, 'send'], ['等待响应 (TTFB)', t.sendEnd, t.receiveHeadersEnd, 'wait'], ['下载内容', t.receiveHeadersEnd, end, 'recv']].map(([l, a, b, c]) => ({ l, a, b, c, v: seg(a, b) }));
  const total = Math.max(end, 1);
  return <div className="timing">
    {rows.map(r => <div key={r.l} className="tm-row"><span className="l">{r.l}</span><span className="bar"><i className={r.c} style={r.v != null ? { left: (r.a / total * 100) + '%', width: Math.max(0.6, r.v / total * 100) + '%' } : { display: 'none' }} /></span><span className="v">{r.v != null ? r.v.toFixed(1) + ' ms' : '–'}</span></div>)}
    <div className="tm-row total"><span className="l">总计</span><span className="bar" /><span className="v">{end.toFixed(1)} ms</span></div>
    <div className="hint pad">{d.protocol ? d.protocol + ' · ' : ''}{d.remoteIP || ''}{d.timing.connectStart < 0 ? ' · 复用连接' : ''}</div>
  </div>;
}
