// 抓包：每个页面一个独立 CDP 会话，用 Network 域完整记录请求/响应头、时序、大小与响应体。
// 响应体在 loadingFinished 时用 Network.getResponseBody 取回并落盘（单个与总量均有上限），列表只保留摘要。
import fs from 'node:fs';
import path from 'node:path';
import { detectSig } from './sig.mjs';

const BODY_CAP = 5 * 1024 * 1024;        // 单个响应体上限
const TOTAL_CAP = 300 * 1024 * 1024;     // 每个会话落盘总量上限
const PREVIEW = 16000;                   // 内存内文本预览（兼容旧工具）
const SKIP_BODY = new Set(['media', 'websocket', 'eventsource']);
const MAX_RECORDS = 4000;

export class NetCapture {
  constructor(browser) {
    this.b = browser; this.paused = false; this.bytes = 0; this.dir = null;
    this.extraReq = new Map(); this.extraRes = new Map();
  }
  setDir(projectDir) {
    this.dir = path.join(projectDir, '.capture', String(Date.now()));
    fs.mkdirSync(this.dir, { recursive: true }); this.bytes = 0;
  }
  async attach(page, context) {
    let cdp;
    try { cdp = await context.newCDPSession(page); } catch { return; }
    const live = new Map(); // requestId -> record
    const b = this.b;
    const tsBase = { mono: null, wall: null };
    cdp.on('Network.requestWillBeSent', e => {
      const prev = live.get(e.requestId);
      if (prev && e.redirectResponse) { this._applyResponse(prev, e.redirectResponse); prev.redirectURL = e.request.url; this._finish(prev, e.timestamp); }
      if (this.paused) { live.delete(e.requestId); return; }
      if (tsBase.mono == null) { tsBase.mono = e.timestamp; tsBase.wall = e.wallTime; }
      const r = {
        id: 'r' + (++b.reqSeq), rid: e.requestId, url: e.request.url + (e.request.urlFragment || ''), method: e.request.method,
        type: String(e.type || 'other').toLowerCase(), headers: flatHeaders(e.request.headers), postData: e.request.postData ?? null, hasPostData: !!e.request.hasPostData,
        status: 'pending', statusText: '', time: Math.round((e.wallTime || Date.now() / 1000) * 1000), t0: e.timestamp,
        initiator: summarizeInitiator(e.initiator), pageUrl: e.documentURL, sig: [],
      };
      const ex = this.extraReq.get(e.requestId); if (ex) { Object.assign(r.headers, ex); this.extraReq.delete(e.requestId); }
      live.set(e.requestId, r);
      b._push(r);
      if (r.hasPostData && r.postData == null) cdp.send('Network.getRequestPostData', { requestId: e.requestId }).then(x => { r.postData = x.postData; r.sig = detectSig(r); b._changed(r); }).catch(() => {});
      r.sig = detectSig(r);
      b._changed(r);
    });
    cdp.on('Network.requestWillBeSentExtraInfo', e => {
      const r = live.get(e.requestId); const h = flatHeaders(e.headers);
      if (r) { Object.assign(r.headers, h); r.sig = detectSig(r); b._changed(r); } else this.extraReq.set(e.requestId, h);
    });
    cdp.on('Network.responseReceived', e => { const r = live.get(e.requestId); if (!r) return; this._applyResponse(r, e.response); const ex = this.extraRes.get(e.requestId); if (ex) { r.respHeaders = { ...r.respHeaders, ...ex }; this.extraRes.delete(e.requestId); } b._changed(r); });
    cdp.on('Network.responseReceivedExtraInfo', e => {
      const r = live.get(e.requestId); const h = flatHeaders(e.headers);
      if (r && r.respHeaders) { r.respHeaders = { ...r.respHeaders, ...h }; if (e.statusCode) r.status = e.statusCode; b._changed(r); } else this.extraRes.set(e.requestId, h);
      if (r && e.headersText) r.respHeadersText = e.headersText.slice(0, 20000);
    });
    cdp.on('Network.loadingFinished', async e => {
      const r = live.get(e.requestId); if (!r) return; live.delete(e.requestId);
      r.encodedSize = e.encodedDataLength;
      this._finish(r, e.timestamp);
      await this._body(cdp, e.requestId, r);
      b._changed(r);
    });
    cdp.on('Network.loadingFailed', e => {
      const r = live.get(e.requestId); if (!r) return; live.delete(e.requestId);
      r.status = 'failed'; r.failure = e.canceled ? 'canceled' : (e.blockedReason ? 'blocked:' + e.blockedReason : e.errorText);
      this._finish(r, e.timestamp); b._changed(r);
    });
    try { await cdp.send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024, maxPostDataSize: 256 * 1024 }); } catch {}
    page.once('close', () => cdp.detach().catch(() => {}));
  }
  _applyResponse(r, res) {
    r.status = res.status; r.statusText = res.statusText || ''; r.respHeaders = flatHeaders(res.headers);
    r.mime = res.mimeType || r.respHeaders['content-type'] || ''; r.protocol = res.protocol || '';
    r.remoteIP = res.remoteIPAddress ? res.remoteIPAddress + (res.remotePort ? ':' + res.remotePort : '') : '';
    r.fromCache = !!(res.fromDiskCache || res.fromServiceWorker || res.fromPrefetchCache);
    if (res.requestHeaders) Object.assign(r.headers, flatHeaders(res.requestHeaders));
    if (res.timing) r.timing = res.timing;
    if (res.encodedDataLength != null) r.encodedSize = res.encodedDataLength;
  }
  _finish(r, ts) {
    r.duration = Math.max(0, Math.round((ts - r.t0) * 1000));
    if (r.timing) r.timing.endMs = (ts - r.timing.requestTime) * 1000;
  }
  async _body(cdp, requestId, r) {
    if (SKIP_BODY.has(r.type) || r.status === 204 || (r.status >= 300 && r.status < 400) || r.method === 'OPTIONS') { r.bodyState = 'none'; return; }
    if (!this.dir) { r.bodyState = 'none'; return; }
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId });
      const buf = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
      r.size = buf.length;
      if (buf.length > BODY_CAP || this.bytes + Math.min(buf.length, BODY_CAP) > TOTAL_CAP) { r.bodyState = 'too-large'; return; }
      const file = path.join(this.dir, r.id + '.body');
      fs.writeFileSync(file, buf); this.bytes += buf.length;
      r.bodyFile = file; r.bodyBinary = !!base64Encoded && !isTextMime(r.mime); r.bodyState = 'ok';
      if (!r.bodyBinary && ['xhr', 'fetch', 'document'].includes(r.type)) r.respBody = buf.toString('utf8').slice(0, PREVIEW);
    } catch (e) { r.bodyState = 'error'; r.bodyError = String(e.message || e).replace(/^.*?:\s*/, '').slice(0, 120); }
  }
}

export function isTextMime(m) { return /^text\/|json|javascript|xml|x-www-form-urlencoded|svg|graphql|ecmascript/i.test(m || ''); }
function flatHeaders(h) { const o = {}; for (const [k, v] of Object.entries(h || {})) o[k.toLowerCase()] = String(v); return o; }
function summarizeInitiator(i) {
  if (!i) return null;
  const fr = i.stack?.callFrames?.[0] || (i.stack?.parent?.callFrames?.[0]);
  return { type: i.type, url: fr ? fr.url : i.url || '', line: fr ? fr.lineNumber + 1 : i.lineNumber, fn: fr?.functionName || '' };
}
export { MAX_RECORDS };
