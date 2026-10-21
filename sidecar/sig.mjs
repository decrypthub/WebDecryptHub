// 疑似签名参数识别（sidecar 与 UI 共用，纯函数，无 Node 依赖）
const STRONG = /^(w_rid|wts|sign|signature|_signature|sig|x-zse-96|x-zse-93|x-zst-81|x-s|x-t|x-s-common|x-b3-traceid|a_bogus|x-bogus|x_bogus|mstoken|h5st|mtgsig|anti_content|x-sign|x-signature|x-ca-signature|x-argus|x-ladon|x-gorgon|x-khronos|x-tt-params|x-secsdk-csrf-token|x-mssdk-info|_rticket|x-apm-token|nonce|x-nonce|sign_?str|authkey|x-hmac.*)$/i;
const WEAK = /sign|sig[_-]|token|bogus|nonce|hmac|zse|mtgsig|h5st|_rid$|encrypt|cipher/i;
const IGNORE = /^(content-type|accept|user-agent|referer|origin|cookie|accept-language|accept-encoding|sec-.*|cache-control|pragma|connection|host|content-length|priority|upgrade-insecure-requests|dnt|te|if-none-match|if-modified-since|x-requested-with)$/i;

export function parseQuery(url) { try { return [...new URL(url).searchParams].map(([name, value]) => ({ name, value })); } catch { return []; } }

export function parseBody(postData, contentType = '') {
  if (postData == null || postData === '') return { kind: 'none', fields: [] };
  const s = String(postData);
  if (/json/i.test(contentType) || /^\s*[\[{]/.test(s)) {
    try { const j = JSON.parse(s); return { kind: 'json', json: j, fields: j && typeof j === 'object' && !Array.isArray(j) ? Object.entries(j).map(([name, v]) => ({ name, value: typeof v === 'string' ? v : JSON.stringify(v) })) : [] }; } catch {}
  }
  if (/x-www-form-urlencoded/i.test(contentType) || /^[\w%.\-\[\]]+=[^&]*(&[\w%.\-\[\]]+=[^&]*)*$/.test(s.trim())) {
    try { return { kind: 'form', fields: [...new URLSearchParams(s)].map(([name, value]) => ({ name, value })) }; } catch {}
  }
  if (/multipart\/form-data/i.test(contentType)) return { kind: 'multipart', fields: [] };
  return { kind: 'raw', fields: [] };
}

function score(name, value) {
  const v = String(value ?? '');
  if (STRONG.test(name)) return 'strong';
  if (WEAK.test(name) && v.length >= 8) return 'weak';
  if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(v) && !/^(id|uid|uuid|.*_id|session.*|trace.*|request.?id)$/i.test(name)) return 'hash';
  return null;
}

// 返回 [{where:'query'|'header'|'body', name, value, level}]
export function detectSig(r) {
  const out = [];
  for (const { name, value } of parseQuery(r.url)) { const l = score(name, value); if (l) out.push({ where: 'query', name, value: String(value).slice(0, 120), level: l }); }
  for (const [name, value] of Object.entries(r.headers || {})) { if (name.startsWith(':') || IGNORE.test(name)) continue; const l = score(name, value); if (l) out.push({ where: 'header', name, value: String(value).slice(0, 120), level: l }); }
  const ct = (r.headers || {})['content-type'] || '';
  for (const { name, value } of parseBody(r.postData, ct).fields) { const l = score(name, value); if (l) out.push({ where: 'body', name, value: String(value).slice(0, 120), level: l }); }
  return out;
}
