// 抓包数据工具：让 Agent 直接读取应用捕获的完整请求/响应（含响应体、时序），导出/加载 HAR
import fs from 'node:fs';
import path from 'node:path';
import { summary, detail, readBody, toHar, fromHar } from './har.mjs';

function pool(ctx, source) { const b = ctx.browser; return source === 'har' ? b.imported : source === 'all' ? [...b.requests, ...b.imported] : b.requests; }
function match(r, f) {
  if (f.url) { let ok; try { ok = new RegExp(f.url, 'i').test(r.url); } catch { ok = r.url.toLowerCase().includes(String(f.url).toLowerCase()); } if (!ok) return false; }
  if (f.types?.length && !f.types.includes(r.type)) return false;
  if (f.method && r.method !== String(f.method).toUpperCase()) return false;
  if (f.status != null && String(r.status) !== String(f.status)) return false;
  if (f.hasSig && !(r.sig || []).length) return false;
  if (f.param) { const p = String(f.param).toLowerCase(); const inUrl = new RegExp('[?&]' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=', 'i').test(r.url); const inH = Object.keys(r.headers || {}).includes(p); const inB = (r.postData || '').toLowerCase().includes(p); if (!inUrl && !inH && !inB) return false; }
  return true;
}
const fmtSize = n => n == null ? '-' : n > 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B';
function safeOut(ctx, file, def) { const p = path.resolve(ctx.projectDir, file || def); if (!p.startsWith(path.resolve(ctx.projectDir))) throw new Error('只能写入项目目录'); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; }

async function netList(a, ctx) {
  const list = pool(ctx, a.source).filter(r => match(r, a));
  const lim = Math.min(a.limit || 40, 200); const rows = list.slice(-lim);
  if (!rows.length) return { text: `没有匹配的请求（共捕获 ${ctx.browser.requests.length} 条${ctx.browser.imported.length ? '，HAR 导入 ' + ctx.browser.imported.length + ' 条' : ''}）。可放宽过滤或先在页面触发请求。` };
  return { text: `匹配 ${list.length} 条，显示最近 ${rows.length} 条（id 可用于 net_get）：\n` + rows.map(r => { const s = summary(r); return `${s.id} ${s.method} ${s.status} ${s.type} ${fmtSize(s.size)} ${s.duration ?? '-'}ms ${s.url.slice(0, 200)}${s.sig.length ? '  [疑似签名: ' + s.sig.join(',') + ']' : ''}${s.bodyState && s.bodyState !== 'ok' ? '  [响应体:' + s.bodyState + ']' : ''}`; }).join('\n') };
}

async function netGet(a, ctx) {
  const r = ctx.browser.findRequest(a.id); if (!r) return { text: '未找到请求 ' + a.id + '，先用 net_list 列出', isError: true };
  const d = detail(r, a.maxBody || 6000); const parts = a.parts?.length ? a.parts : ['request', 'response', 'body', 'timing'];
  const out = [`${d.id} ${d.method} ${d.url}`, `状态 ${d.status} ${d.statusText || ''} · ${d.type} · ${d.mime || ''} · ${fmtSize(d.size)} · ${d.duration ?? '-'}ms${d.remoteIP ? ' · ' + d.remoteIP : ''}`];
  if (d.sig?.length) out.push('疑似签名参数：' + d.sig.map(s => `${s.where}.${s.name}=${s.value}`).join('  '));
  if (parts.includes('request')) { out.push('\n[请求头]', ...Object.entries(d.headers || {}).map(([k, v]) => `${k}: ${v}`)); if (d.query.length) out.push('\n[查询参数]', ...d.query.map(q => `${q.name} = ${q.value}`)); if (d.postData != null) out.push('\n[请求体]', String(d.postData).slice(0, a.maxBody || 6000)); }
  if (parts.includes('response')) out.push('\n[响应头]', ...Object.entries(d.respHeaders || {}).map(([k, v]) => `${k}: ${v}`));
  if (parts.includes('body')) out.push('\n[响应体]' + (d.body ? (d.body.encoding ? `（二进制，base64，${d.body.size} 字节）` : `（${d.body.size} 字节${d.body.truncated ? '，已截断，用 maxBody 调大或 net_save_body 落盘' : ''}）`) + '\n' + d.body.text : '（无：' + (d.bodyState || '未捕获') + (d.bodyError ? ' ' + d.bodyError : '') + '）'));
  if (parts.includes('timing') && d.initiator) out.push('\n[发起者]', `${d.initiator.type} ${d.initiator.fn || ''} ${d.initiator.url || ''}:${d.initiator.line ?? ''}`);
  if (parts.includes('timing') && d.timing) { const t = d.timing; out.push('\n[时序 ms]', `dns ${fix(t.dnsEnd - t.dnsStart)} · connect ${fix(t.connectEnd - t.connectStart)} · ssl ${fix(t.sslEnd - t.sslStart)} · send ${fix(t.sendEnd - t.sendStart)} · wait(TTFB) ${fix(t.receiveHeadersEnd - t.sendEnd)} · receive ${fix((t.endMs ?? t.receiveHeadersEnd) - t.receiveHeadersEnd)}`); }
  return { text: out.join('\n') };
}
const fix = v => (v >= 0 ? Math.round(v * 10) / 10 : '-');

async function netSearch(a, ctx) {
  let re; try { re = new RegExp(a.pattern, a.caseSensitive ? 'g' : 'gi'); } catch { re = new RegExp(String(a.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }
  const where = a.in?.length ? a.in : ['url', 'reqHeaders', 'reqBody', 'respHeaders', 'respBody'];
  const hits = [];
  for (const r of pool(ctx, a.source)) {
    if (hits.length >= (a.maxResults || 30)) break;
    const fields = { url: r.url, reqHeaders: JSON.stringify(r.headers || {}), reqBody: r.postData || '', respHeaders: JSON.stringify(r.respHeaders || {}), respBody: where.includes('respBody') ? (readBody(r, 3_000_000)?.encoding ? '' : readBody(r, 3_000_000)?.text || '') : '' };
    for (const w of where) { const s = fields[w] || ''; re.lastIndex = 0; const m = re.exec(s); if (m) { const i = m.index; hits.push(`${r.id} ${r.method} ${r.url.slice(0, 120)}\n   在 ${w} @${i}: …${s.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ')}…`); break; } }
  }
  return { text: hits.length ? `命中 ${hits.length} 条：\n` + hits.join('\n') : '没有命中' };
}

async function netExportHar(a, ctx) {
  const recs = pool(ctx, 'live').filter(r => (a.ids?.length ? a.ids.includes(r.id) : match(r, a)));
  const out = safeOut(ctx, a.file, 'capture-' + Date.now() + '.har');
  const har = toHar(recs); fs.writeFileSync(out, JSON.stringify(har, null, 1));
  return { text: `已导出 HAR 1.2：${path.relative(ctx.projectDir, out)}（${har.log.entries.length} 条，${fmtSize(fs.statSync(out).size)}）` };
}

async function netSaveBody(a, ctx) {
  const r = ctx.browser.findRequest(a.id); if (!r) return { text: '未找到请求', isError: true };
  const b = readBody(r); if (!b) return { text: '该请求没有已捕获的响应体：' + (r.bodyState || '未知'), isError: true };
  const out = safeOut(ctx, a.file, `body-${r.id}${b.encoding ? '.bin' : /json/.test(r.mime) ? '.json' : '.txt'}`);
  fs.writeFileSync(out, b.encoding ? Buffer.from(b.text, 'base64') : b.text);
  return { text: `已保存响应体：${path.relative(ctx.projectDir, out)}（${b.size} 字节），可用 grep_file / read_file_slice 检索` };
}

async function netLoadHar(a, ctx) {
  const p = path.resolve(ctx.projectDir, a.file); if (!p.startsWith(path.resolve(ctx.projectDir))) throw new Error('只允许读取项目目录内的 HAR 文件');
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  const recs = fromHar(json, ctx.browser.imported.length); ctx.browser.imported.push(...recs);
  const hosts = {}; for (const r of recs) { try { const h = new URL(r.url).host; hosts[h] = (hosts[h] || 0) + 1; } catch {} }
  const sig = recs.filter(r => r.sig.length);
  return { text: `已加载 ${recs.length} 条（id ${recs[0]?.id}…${recs.at(-1)?.id}，用 net_list source="har" / net_get 查看）。\n主机：${Object.entries(hosts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([h, n]) => h + '×' + n).join(', ')}\n带疑似签名的请求 ${sig.length} 条：\n` + sig.slice(0, 15).map(r => `${r.id} ${r.method} ${r.status} ${r.url.slice(0, 120)} [${r.sig.map(s => s.name).join(',')}]`).join('\n') };
}

const S = (props, req) => ({ type: 'object', properties: props, ...(req ? { required: req } : {}) });
const FILTER = { url: { type: 'string', description: 'URL 子串或正则' }, types: { type: 'array', items: { type: 'string' }, description: 'xhr/fetch/script/document/image/stylesheet/other…' }, method: { type: 'string' }, status: { type: 'string' }, hasSig: { type: 'boolean', description: '只看带疑似签名参数的请求' }, param: { type: 'string', description: '只看携带该参数（查询/请求头/请求体）的请求，如 w_rid' } };
export const NET_TOOLS = [
  { name: 'net_list', description: '【抓包首选】列出应用已捕获的网络请求（从浏览器启动起全量记录，含响应体），支持 URL/类型/方法/状态/参数名/疑似签名过滤。返回 id、方法、状态、类型、大小、耗时、URL、疑似签名参数。source=live(默认)/har/all。', schema: S({ ...FILTER, source: { type: 'string', enum: ['live', 'har', 'all'] }, limit: { type: 'number' } }), run: netList },
  { name: 'net_get', description: '按 id 读取一条请求的完整内容：请求头、查询参数、请求体、响应头、响应体（文本，二进制为 base64）、时序与发起者。parts 可选 request/response/body/timing；maxBody 控制响应体字符数（默认 6000）。', schema: S({ id: { type: 'string' }, parts: { type: 'array', items: { type: 'string' } }, maxBody: { type: 'number' } }, ['id']), run: netGet },
  { name: 'net_search', description: '在已捕获请求的 URL、请求头、请求体、响应头、响应体中搜索关键字/正则（如密钥、token、某个签名值出现在哪个响应里）。in 限定范围：url/reqHeaders/reqBody/respHeaders/respBody。', schema: S({ pattern: { type: 'string' }, in: { type: 'array', items: { type: 'string' } }, source: { type: 'string' }, maxResults: { type: 'number' }, caseSensitive: { type: 'boolean' } }, ['pattern']), run: netSearch },
  { name: 'net_save_body', description: '把某条请求的完整响应体保存到项目目录（大 JSON/HTML/二进制），之后可 grep_file/read_file_slice/run_node 读取。', schema: S({ id: { type: 'string' }, file: { type: 'string' } }, ['id']), run: netSaveBody },
  { name: 'net_export_har', description: '把已捕获请求导出为 HAR 1.2 文件（含响应体，二进制 base64）保存到项目目录。可按 ids 或过滤条件导出。', schema: S({ ...FILTER, ids: { type: 'array', items: { type: 'string' } }, file: { type: 'string' } }), run: netExportHar },
  { name: 'net_load_har', description: '加载项目目录内的 HAR 文件（用户提供或之前导出的），导入后用 net_list source="har" / net_get / net_search 分析，并给出主机分布与疑似签名请求概览。', schema: S({ file: { type: 'string' } }, ['file']), run: netLoadHar },
];
