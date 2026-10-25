// 抓包记录 <-> HAR 1.2，及列表摘要 / 详情 / 响应体读取
import fs from 'node:fs';
import { parseQuery, parseBody, detectSig } from './sig.mjs';
import { isTextMime } from './netcap.mjs';

// data: URL（base64 图片等）动辄几 KB，若原样进列表/进模型上下文，token 会被瞬间吃光。
// 列表只需要知道「这是张 2.9KB 的图」，具体内容要看就用 net_save_body 落盘。
const MAX_URL = 2048;
export function shortUrl(u) {
  const s = String(u || '');
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    const head = comma >= 0 ? s.slice(0, comma + 1) : s.slice(0, 40);
    return `${head}…[data URL 共 ${(s.length / 1024).toFixed(1)}KB，已省略]`;
  }
  return s.length > MAX_URL ? `${s.slice(0, MAX_URL)}…[共 ${s.length} 字符]` : s;
}

export function summary(r) {
  return {
    id: r.id, url: shortUrl(r.url), method: r.method, type: r.type, status: r.status, statusText: r.statusText || '', mime: r.mime || '',
    size: r.size ?? null, encodedSize: r.encodedSize ?? null, time: r.time, duration: r.duration ?? null,
    sig: (r.sig || []).map(s => s.name), sigLevel: (r.sig || []).some(s => s.level === 'strong') ? 'strong' : (r.sig || []).length ? 'weak' : null,
    bodyState: r.bodyState || null, failure: r.failure || null, fromCache: !!r.fromCache, imported: !!r.imported,
  };
}

export function readBody(r, max = Infinity) {
  if (r.inlineBody != null) {
    const enc = r.inlineEnc === 'base64' ? 'base64' : null;
    return { text: r.inlineBody.slice(0, max), encoding: enc, size: r.size ?? r.inlineBody.length, truncated: r.inlineBody.length > max };
  }
  if (!r.bodyFile) return null;
  let buf; try { buf = fs.readFileSync(r.bodyFile); } catch { return null; }
  if (r.bodyBinary) { const t = buf.toString('base64'); return { text: t.slice(0, max), encoding: 'base64', size: buf.length, truncated: t.length > max }; }
  const t = buf.toString('utf8'); return { text: t.slice(0, max), encoding: null, size: buf.length, truncated: t.length > max };
}

export function detail(r, maxBody = 2 * 1024 * 1024) {
  const { bodyFile, respBody, inlineBody, ...rest } = r;
  return { ...rest, sig: r.sig || detectSig(r), query: parseQuery(r.url), body: readBody(r, maxBody) };
}

const kv = o => Object.entries(o || {}).filter(([k]) => !k.startsWith(':')).flatMap(([name, v]) => String(v).split('\n').map(value => ({ name, value })));
function cookiesFromHeader(h) { return String(h || '').split(/;\s*/).filter(Boolean).map(p => { const i = p.indexOf('='); return { name: i < 0 ? p : p.slice(0, i), value: i < 0 ? '' : p.slice(i + 1) }; }); }
function setCookies(h) { return String(h || '').split('\n').filter(Boolean).map(line => { const [nv] = line.split(';'); const i = nv.indexOf('='); return { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim() }; }); }
const ms = v => (v == null || v < 0 ? -1 : Math.round(v * 1000) / 1000);

function timings(r) {
  const t = r.timing; const total = r.duration ?? 0;
  if (!t) return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: Math.max(0, total), receive: 0 };
  const span = (a, b) => (a >= 0 && b >= 0 ? b - a : -1);
  const blocked = t.dnsStart >= 0 ? t.dnsStart : (t.connectStart >= 0 ? t.connectStart : t.sendStart);
  const dns = span(t.dnsStart, t.dnsEnd), connect = span(t.connectStart, t.connectEnd), ssl = span(t.sslStart, t.sslEnd);
  const send = Math.max(0, t.sendEnd - t.sendStart), wait = Math.max(0, t.receiveHeadersEnd - t.sendEnd);
  const receive = Math.max(0, (t.endMs ?? t.receiveHeadersEnd) - t.receiveHeadersEnd);
  return { blocked: ms(blocked), dns: ms(dns), connect: ms(connect), ssl: ms(ssl), send: ms(send), wait: ms(wait), receive: ms(receive) };
}

export function toHarEntry(r) {
  const req = r.headers || {}, res = r.respHeaders || {};
  const http = (r.protocol || 'http/1.1').toUpperCase().replace(/^H2$/, 'HTTP/2').replace(/^H3$/, 'HTTP/3');
  const ct = req['content-type'] || '';
  const entry = {
    startedDateTime: new Date(r.time).toISOString(),
    time: 0,
    request: {
      method: r.method, url: r.url, httpVersion: http, cookies: cookiesFromHeader(req.cookie), headers: kv(req),
      queryString: parseQuery(r.url), headersSize: -1, bodySize: r.postData != null ? Buffer.byteLength(r.postData) : 0,
    },
    response: {
      status: typeof r.status === 'number' ? r.status : 0, statusText: typeof r.status === 'number' ? (r.statusText || '') : (r.failure || r.status || ''),
      httpVersion: http, cookies: setCookies(res['set-cookie']), headers: kv(res),
      content: { size: r.size ?? 0, mimeType: r.mime || 'x-unknown' }, redirectURL: r.redirectURL || res.location || '',
      headersSize: -1, bodySize: r.encodedSize ?? -1,
    },
    cache: {}, timings: timings(r),
  };
  if (r.postData != null) {
    const pb = parseBody(r.postData, ct);
    entry.request.postData = { mimeType: ct || 'application/octet-stream', text: r.postData };
    if (pb.kind === 'form') entry.request.postData.params = pb.fields;
  }
  const b = readBody(r);
  if (b) { entry.response.content.text = b.text; if (b.encoding) entry.response.content.encoding = 'base64'; entry.response.content.size = b.size; }
  else if (r.bodyState && r.bodyState !== 'ok') entry.response.content.comment = '响应体未保存：' + r.bodyState;
  const tm = entry.timings; entry.time = ['blocked', 'dns', 'connect', 'send', 'wait', 'receive'].reduce((s, k) => s + (tm[k] > 0 ? tm[k] : 0), 0);
  if (r.remoteIP) entry.serverIPAddress = r.remoteIP.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  entry._resourceType = r.type; if (r.initiator) entry._initiator = r.initiator; entry._id = r.id;
  return entry;
}

export function toHar(records, { version = '' } = {}) {
  return { log: { version: '1.2', creator: { name: 'WebDecryptHub', version: version || '1.1.1' }, entries: records.filter(r => r.status !== 'pending').map(toHarEntry) } };
}

export function fromHar(json, seqStart = 0) {
  const entries = json?.log?.entries; if (!Array.isArray(entries)) throw new Error('不是有效的 HAR：缺少 log.entries');
  return entries.map((e, i) => {
    const h = arr => Object.fromEntries((arr || []).map(x => [String(x.name).toLowerCase(), x.value]));
    const c = e.response?.content || {};
    const r = {
      id: 'h' + (seqStart + i + 1), imported: true, url: e.request?.url || '', method: e.request?.method || 'GET', type: e._resourceType || guessType(c.mimeType, e.request?.url),
      headers: h(e.request?.headers), postData: e.request?.postData?.text ?? null, status: e.response?.status || 0, statusText: e.response?.statusText || '',
      respHeaders: h(e.response?.headers), mime: c.mimeType || '', size: c.size ?? null, encodedSize: e.response?.bodySize ?? null,
      time: Date.parse(e.startedDateTime) || 0, duration: Math.round(e.time || 0), inlineBody: c.text ?? null, inlineEnc: c.encoding || null,
      bodyState: c.text != null ? 'ok' : 'none', harTimings: e.timings,
    };
    r.sig = detectSig(r);
    return r;
  });
}
function guessType(m = '', u = '') { if (/html/.test(m)) return 'document'; if (/javascript/.test(m)) return 'script'; if (/json/.test(m)) return 'xhr'; if (/image/.test(m)) return 'image'; if (/css/.test(m)) return 'stylesheet'; return /\.js(\?|$)/.test(u) ? 'script' : 'other'; }
export { isTextMime };
