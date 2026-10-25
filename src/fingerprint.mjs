// 指纹采集点追踪：Hook Canvas/WebGL/WebRTC/Audio/Navigator/Screen/Crypto/字体等，带调用栈与返回值
import fs from 'node:fs';
import path from 'node:path';

const INSTALL = `(() => {
  if (window.__jsra_fp) return 'already';
  const F = { hits: [], by: {}, enabled: true, max: 800 };
  const stack = () => { try { return (new Error()).stack.split('\\n').slice(2, 8).map(s => s.trim()).join(' ← '); } catch { return ''; } };
  const rec = (cat, api, ret, extra) => {
    if (!F.enabled) return;
    const h = { t: Date.now(), cat, api, ret: ret != null ? String(ret).slice(0, 300) : '', stack: stack(), ...extra };
    F.hits.push(h); if (F.hits.length > F.max) F.hits.shift();
    F.by[cat] = (F.by[cat] || 0) + 1;
  };
  const wrap = (obj, key, cat, fmt) => {
    if (!obj) return;
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && d.get) {
      try {
        Object.defineProperty(obj, key, { ...d, get() { const v = d.get.call(this); rec(cat, key, fmt ? fmt(v) : v); return v; } });
      } catch {}
      return;
    }
    if (typeof obj[key] === 'function') {
      const orig = obj[key];
      try {
        obj[key] = function(...a) { const v = orig.apply(this, a); rec(cat, key, fmt ? fmt(v) : (typeof v === 'string' ? v.slice(0, 120) : typeof v), { args: a.slice(0, 2).map(x => typeof x) }); return v; };
      } catch {}
    }
  };
  // Navigator / Screen
  for (const k of ['userAgent','platform','language','languages','hardwareConcurrency','deviceMemory','vendor','appVersion','maxTouchPoints','webdriver','plugins','mimeTypes']) wrap(Navigator.prototype, k, 'navigator');
  for (const k of ['width','height','availWidth','availHeight','colorDepth','pixelDepth']) wrap(Screen.prototype, k, 'screen');
  wrap(window, 'devicePixelRatio', 'screen');
  // Timezone
  try { const _ro = Intl.DateTimeFormat.prototype.resolvedOptions; Intl.DateTimeFormat.prototype.resolvedOptions = function() { const v = _ro.apply(this, arguments); rec('timezone', 'resolvedOptions', v.timeZone); return v; }; } catch {}
  // Canvas
  try {
    const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...a) { const v = _toDataURL.apply(this, a); rec('canvas', 'toDataURL', v.slice(0, 64) + '…', { w: this.width, h: this.height }); return v; };
    const _getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...a) { const v = _getImageData.apply(this, a); rec('canvas', 'getImageData', a.join(','), { w: v.width, h: v.height }); return v; };
  } catch {}
  // WebGL
  try {
    for (const Proto of [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)) {
      const _gp = Proto.getParameter;
      Proto.getParameter = function(p) { const v = _gp.call(this, p); rec('webgl', 'getParameter', v, { p }); return v; };
      const _ex = Proto.getExtension;
      Proto.getExtension = function(n) { const v = _ex.call(this, n); rec('webgl', 'getExtension', n); return v; };
      const _du = Proto.getSupportedExtensions;
      if (_du) Proto.getSupportedExtensions = function() { const v = _du.call(this); rec('webgl', 'getSupportedExtensions', (v||[]).length + ' exts'); return v; };
    }
  } catch {}
  // Audio
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const _create = AC.prototype.createAnalyser;
      if (_create) AC.prototype.createAnalyser = function() { rec('audio', 'createAnalyser'); return _create.apply(this, arguments); };
      const _createOsc = AC.prototype.createOscillator;
      if (_createOsc) AC.prototype.createOscillator = function() { rec('audio', 'createOscillator'); return _createOsc.apply(this, arguments); };
    }
  } catch {}
  // WebRTC
  try {
    const _pc = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (_pc) {
      window.RTCPeerConnection = function(...a) { rec('webrtc', 'RTCPeerConnection', JSON.stringify(a[0]||{}).slice(0, 100)); return new _pc(...a); };
      window.RTCPeerConnection.prototype = _pc.prototype;
    }
  } catch {}
  // Crypto
  try {
    if (crypto?.subtle) {
      for (const k of ['digest','encrypt','decrypt','sign','verify','generateKey','importKey','exportKey']) {
        if (crypto.subtle[k]) {
          const orig = crypto.subtle[k].bind(crypto.subtle);
          crypto.subtle[k] = function(...a) { rec('crypto', 'subtle.'+k, typeof a[0]==='string'?a[0]:a[0]?.name||''); return orig(...a); };
        }
      }
    }
    const _gr = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = function(a) { rec('crypto', 'getRandomValues', a?.length); return _gr(a); };
  } catch {}
  // Fonts (measureText probe)
  try {
    const _mt = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function(t) { const v = _mt.call(this, t); if (t && t.length <= 3) rec('fonts', 'measureText', t + '→' + v.width); return v; };
  } catch {}
  window.__jsra_fp = F;
  return 'armed';
})()`;

async function fpInstall(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  const inj = ctx.browser.injector;
  inj.register('fingerprint', INSTALL);
  const arm = await inj.armAll().catch(e => ({ ok: false, error: e.message }));
  const r = await page.evaluate(INSTALL).catch(e => 'inject-fail: ' + e.message);
  const st = await inj.status(page);
  return { text: `指纹追踪已安装（当前页 ${r}；armAll pages=${arm.pages||0}；registered=${JSON.stringify(st.registered||st.registeredHere)}）。覆盖 Canvas/WebGL/WebRTC/Audio/Navigator/Screen/Crypto/字体/时区。导航后仍在；用 fingerprint_report / inject_status 复查。` };
}
async function fpReport(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  const data = await page.evaluate(() => window.__jsra_fp ? { by: window.__jsra_fp.by, hits: window.__jsra_fp.hits.slice(-200), n: window.__jsra_fp.hits.length } : null);
  if (!data) return { text: '未安装，先 fingerprint_install', isError: true };
  // 生成 env-patch 骨架
  const nav = data.hits.filter(h => h.cat === 'navigator');
  const skeleton = [
    '// capture_page_env / run_node 补环境清单（根据指纹追踪自动生成）',
    'const envPatch = {',
    ...['userAgent','platform','language','hardwareConcurrency'].map(k => {
      const h = nav.find(x => x.api === k); return h ? `  ${k}: ${JSON.stringify(h.ret)},` : null;
    }).filter(Boolean),
    '  // canvas / webgl / audio 建议用 capture_page_env 采集真实值，勿硬编码随机指纹',
    '};',
  ].join('\n');
  let saved = '';
  let wrote = [];
  if (a.file || a.save !== false) {
    const f = path.join(ctx.projectDir, a.file || `fingerprint-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
    const sk = path.join(ctx.projectDir, 'env-patch-skeleton.js');
    fs.writeFileSync(sk, skeleton + '\n');
    wrote = [f, sk];
    saved = ` 已保存 ${path.relative(ctx.projectDir, f)} 与 env-patch-skeleton.js`;
  }
  const lines = Object.entries(data.by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`);
  const recent = data.hits.slice(-12).map(h => `  [${h.cat}] ${h.api} → ${h.ret.slice(0, 60)}`).join('\n');
  return { text: `指纹采集点 ${data.n} 次：\n${lines.join('\n')}${saved}\n最近：\n${recent}\n\n补环境骨架：\n\`\`\`js\n${skeleton}\n\`\`\``, wrote };
}

export const FINGERPRINT_TOOLS = [
  { name: 'fingerprint_install', description: '安装指纹采集点追踪：Hook Canvas/WebGL/WebRTC/Audio/Navigator/Screen/Crypto/字体/时区，记录调用栈与返回值。用于识别站点读了哪些指纹、为 Node 补环境列清单。', schema: { type: 'object', properties: {} }, run: fpInstall },
  { name: 'fingerprint_report', description: '按类别汇总指纹采集命中，导出 JSON，并生成 env-patch-skeleton.js 补环境骨架。', schema: { type: 'object', properties: { file: { type: 'string' }, save: { type: 'boolean' } } }, run: fpReport },
];
