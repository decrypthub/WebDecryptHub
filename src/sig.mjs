// 疑似「机器生成的值」识别（sidecar 与 UI 共用，纯函数，无 Node 依赖）。
//
// 关键设计：**完全不看参数名**。通用工具不该认识任何站点的约定——
// 写死 x-zse-96 / a_bogus / h5st 这类名单，等于「只有我见过的站点才识别得出来」，
// 换个站点就哑了。签名、校验码、防重放 token 在各站点名字千变万化，
// 但它们的**产物形态**是同一类东西：一段由脚本算出来、人读不懂、高熵的短串
// （定长十六进制摘要、base64/自定义字母表、混排的 uuid-like token）。
//
// 所以这里只统计值的形态：长度、字符集、信息熵。命中只代表「值得看一眼」，
// 真正的判定要靠行为证据（同接口两次请求哪些参数变了 / 篡改后被服务端拒绝），
// 那是 diff_requests、page_call 和「服务端验收」要做的事。
//
// 返回 [{where:'query'|'header'|'body', name, value, level:'strong'|'weak'}]

const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;
const DIGEST_LEN = new Set([16, 24, 32, 40, 48, 56, 64, 96, 128]);

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

/** 香农熵（bit/字符）：自然语言约 3~4，随机 base64 约 4.5~6，十六进制约 3.5~4 */
export function entropy(s) {
  const str = String(s ?? '');
  if (!str.length) return 0;
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) || 0) + 1);
  let e = 0;
  for (const c of counts.values()) { const p = c / str.length; e -= p * Math.log2(p); }
  return e;
}

/**
 * 只按「值」判断它像不像脚本生成的。
 * @returns {'strong'|'weak'|null}
 */
export function scoreValue(value) {
  const s = String(value ?? '');
  const n = s.length;
  if (n < 8 || n > 4096) return null;
  if (/\s/.test(s)) return null;
  // 明确的「不是」：普通数字/时间戳/日期/UUID/URL/路径/邮箱/JSON 片段
  if (NUM.test(s) || DATE.test(s) || UUID.test(s)) return null;
  if (/^(https?:\/\/|\/|\.{1,2}\/)/.test(s)) return null;
  if (/^[\[{]/.test(s)) return null;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return null;
  // 只考虑「纯 token 字符集」：含点号、逗号、括号、中文的一律不算
  if (!B64.test(s)) return null;

  const e = entropy(s);
  const hex = /^[0-9a-f]+$/i.test(s);
  // 定长十六进制摘要（md5/sha1/sha256/hmac…）：形态最确定
  if (hex && DIGEST_LEN.has(n) && e >= 2.5) return 'strong';
  // 高熵混排短串（base64 / urlsafe / 自定义字母表）
  if (n >= 20 && e >= 4.0) return 'strong';
  if (n >= 16 && e >= 3.5) return 'weak';
  // 大小写+数字混排、长度偏短（例如 12~15 位的 token）
  if (n >= 12 && /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s) && e >= 3.0) return 'weak';
  return null;
}

/** 扫一个请求的 query / header / body，返回形态可疑的字段 */
export function detectSig(r) {
  const out = [];
  const push = (where, name, value) => {
    const level = scoreValue(value);
    if (!level) return;
    out.push({ where, name, value: String(value).slice(0, 120), level });
  };
  for (const { name, value } of parseQuery(r.url)) push('query', name, value);
  for (const [name, value] of Object.entries(r.headers || {})) {
    if (name.startsWith(':')) continue;
    push('header', name, value);
  }
  const ct = (r.headers || {})['content-type'] || '';
  for (const { name, value } of parseBody(r.postData, ct).fields) push('body', name, value);
  return out;
}
