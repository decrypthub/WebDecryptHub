// 补环境引导脚本：在 vm 上下文内部执行（函数/对象都属于沙箱 realm，原型链与真实浏览器更一致）。
// 设计目标：通过常见反调试/反自动化探针（toString 标签、native code、canvas、history/screen、自动化特征变量），
// 并允许注入从真实页面采集的环境（capture_page_env 产出的 JSON：navigator/location/cookie/screen/window 变量如 __ZH__）。
export const ENV_BOOT = String.raw`(function (H) {
  var G = globalThis, CAP = H.env || {}, missing = H.missing;
  var natives = new WeakSet();
  var fts = Function.prototype.toString;
  var patchedTs = function toString() { if (natives.has(this)) return 'function ' + (this.name || '') + '() { [native code] }'; return fts.call(this); };
  Object.defineProperty(Function.prototype, 'toString', { value: patchedTs, writable: true, configurable: true }); natives.add(patchedTs);
  function nat(f, name) { try { Object.defineProperty(f, 'name', { value: name, configurable: true }); } catch (e) {} natives.add(f); return f; }
  function tag(o, n) { Object.defineProperty(o, Symbol.toStringTag, { value: n, configurable: true }); return o; }
  function cls(name, proto) { var C = nat(function () { throw new TypeError('Illegal constructor'); }, name); C.prototype = proto || {}; Object.defineProperty(C.prototype, 'constructor', { value: C, configurable: true, writable: true }); tag(C.prototype, name); G[name] = C; return C; }
  function inst(C, props) { var o = Object.create(C.prototype); if (props) for (var k in props) o[k] = props[k]; return o; }
  function track(name, obj) {
    return new Proxy(obj, { get: function (t, k, r) { if (typeof k === 'string' && !(k in t) && k !== 'then' && k !== 'toJSON') missing(name + '.' + k); return Reflect.get(t, k, r); } });
  }
  function fns(o, names, impl) { names.forEach(function (n) { o[n] = nat(impl && impl[n] || function () {}, n); }); return o; }
  var href = CAP.href || H.url || 'https://example.com/';
  var u = new URL(href);
  // ---- navigator ----
  var Navigator = cls('Navigator');
  var navP = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'], appName: 'Netscape', appCodeName: 'Mozilla', product: 'Gecko', productSub: '20030107', vendor: 'Google Inc.', vendorSub: '', webdriver: false, hardwareConcurrency: 8, maxTouchPoints: 0, cookieEnabled: true, onLine: true, deviceMemory: 8, doNotTrack: null };
  Object.assign(navP, CAP.navigator || {}); if (CAP.ua) navP.userAgent = CAP.ua;
  navP.appVersion = navP.appVersion || navP.userAgent.replace(/^Mozilla\//, '');
  navP.plugins = tag(Object.assign([], { refresh: nat(function () {}, 'refresh') }), 'PluginArray'); navP.mimeTypes = tag([], 'MimeTypeArray');
  fns(navP, ['javaEnabled', 'sendBeacon', 'vibrate', 'getBattery']);
  var navigator = track('navigator', inst(Navigator, navP));
  // ---- location ----
  var Location = cls('Location');
  var loc = inst(Location, { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin, ancestorOrigins: tag({ length: 0 }, 'DOMStringList') });
  loc.toString = nat(function () { return u.href; }, 'toString'); fns(loc, ['assign', 'reload', 'replace']);
  var location = track('location', loc);
  // ---- screen / history ----
  var Screen = cls('Screen'); var screen = track('screen', inst(Screen, Object.assign({ width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, availLeft: 0, availTop: 0, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } }, CAP.screen || {})));
  var History = cls('History'); var history = track('history', fns(inst(History, { length: CAP.historyLength || 2, state: null, scrollRestoration: 'auto' }), ['back', 'forward', 'go', 'pushState', 'replaceState']));
  // ---- storage ----
  var Storage = cls('Storage');
  function mkStorage(init) { var d = Object.assign({}, init || {}); var s = inst(Storage); fns(s, ['getItem', 'setItem', 'removeItem', 'clear', 'key'], { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; }, clear: function () { for (var k in d) delete d[k]; }, key: function (i) { return Object.keys(d)[i] || null; } }); Object.defineProperty(s, 'length', { get: function () { return Object.keys(d).length; } }); return s; }
  // ---- DOM ----
  var EventTarget = cls('EventTarget'); var Node = cls('Node', Object.create(EventTarget.prototype)); var Element = cls('Element', Object.create(Node.prototype)); var HTMLElement = cls('HTMLElement', Object.create(Element.prototype));
  var CanvasRenderingContext2D = cls('CanvasRenderingContext2D'); var WebGLRenderingContext = cls('WebGLRenderingContext');
  var HTMLCanvasElement = cls('HTMLCanvasElement', Object.create(HTMLElement.prototype)); var HTMLDocument = cls('HTMLDocument', Object.create(Node.prototype)); G.Document = HTMLDocument;
  function ctx2d() { var c = inst(CanvasRenderingContext2D, { fillStyle: '#000000', font: '10px sans-serif', textBaseline: 'alphabetic', globalCompositeOperation: 'source-over' }); fns(c, ['fillRect', 'clearRect', 'strokeRect', 'fillText', 'strokeText', 'beginPath', 'closePath', 'arc', 'moveTo', 'lineTo', 'fill', 'stroke', 'rect', 'save', 'restore', 'translate', 'rotate', 'scale', 'drawImage', 'setTransform', 'putImageData'], { measureText: function (t) { return { width: String(t).length * 6 }; }, getImageData: function (x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; } }); c.measureText = nat(function (t) { return { width: String(t).length * 6 }; }, 'measureText'); c.getImageData = nat(function (x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }, 'getImageData'); return c; }
  function element(tagName) {
    var t = String(tagName || 'div').toLowerCase(); var e;
    if (t === 'canvas') { e = inst(HTMLCanvasElement, { width: 300, height: 150 }); e.getContext = nat(function (k) { return k === '2d' ? ctx2d() : /webgl/.test(k) ? inst(WebGLRenderingContext, { getParameter: nat(function () { return null; }, 'getParameter'), getExtension: nat(function () { return null; }, 'getExtension'), getSupportedExtensions: nat(function () { return []; }, 'getSupportedExtensions') }) : null; }, 'getContext'); e.toDataURL = nat(function () { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAYAAABkW7XSAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA='; }, 'toDataURL'); }
    else e = inst(HTMLElement);
    Object.assign(e, { tagName: t.toUpperCase(), nodeName: t.toUpperCase(), style: {}, children: [], childNodes: [], innerHTML: '', innerText: '', id: '', className: '' });
    fns(e, ['setAttribute', 'removeAttribute', 'appendChild', 'removeChild', 'insertBefore', 'addEventListener', 'removeEventListener', 'click', 'focus', 'blur'], { appendChild: function (c) { return c; } });
    e.getAttribute = nat(function () { return null; }, 'getAttribute'); e.getBoundingClientRect = nat(function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }, 'getBoundingClientRect');
    return track('element<' + t + '>', e);
  }
  var body = element('body'), head = element('head'), html = element('html');
  var doc = inst(HTMLDocument, { cookie: CAP.cookie || '', referrer: CAP.referrer || '', title: CAP.title || '', readyState: 'complete', domain: u.hostname, URL: u.href, characterSet: 'UTF-8', charset: 'UTF-8', compatMode: 'CSS1Compat', visibilityState: 'visible', hidden: false, body: body, head: head, documentElement: html, location: location });
  fns(doc, ['addEventListener', 'removeEventListener', 'createEvent', 'createTextNode', 'getElementsByName'], { createEvent: function () { return { initEvent: nat(function () {}, 'initEvent') }; } });
  doc.createElement = nat(function (t) { return element(t); }, 'createElement');
  doc.getElementById = nat(function () { return null; }, 'getElementById');
  doc.getElementsByTagName = nat(function (t) { t = String(t).toLowerCase(); return t === 'head' ? [head] : t === 'body' ? [body] : t === 'html' ? [html] : []; }, 'getElementsByTagName');
  doc.getElementsByClassName = nat(function () { return []; }, 'getElementsByClassName');
  doc.querySelector = nat(function () { return null; }, 'querySelector'); doc.querySelectorAll = nat(function () { return []; }, 'querySelectorAll');
  var document = track('document', doc);
  // ---- window ----
  var Window = cls('Window', Object.create(EventTarget.prototype));
  Object.setPrototypeOf(G, Window.prototype);
  var W = {
    navigator: navigator, location: location, document: document, screen: screen, history: history, localStorage: mkStorage(CAP.localStorage), sessionStorage: mkStorage(CAP.sessionStorage),
    innerWidth: 1920, innerHeight: 969, outerWidth: 1920, outerHeight: 1040, devicePixelRatio: 1, screenX: 0, screenY: 0, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, name: '', closed: false, length: 0, origin: u.origin, isSecureContext: true,
    performance: { now: nat(function () { return Date.now() - H.t0; }, 'now'), timeOrigin: H.t0, timing: { navigationStart: H.t0 } },
    chrome: { runtime: undefined, app: { isInstalled: false }, csi: nat(function () { return {}; }, 'csi'), loadTimes: nat(function () { return {}; }, 'loadTimes') },
  };
  for (var k in W) G[k] = W[k];
  fns(G, ['alert', 'confirm', 'prompt', 'open', 'close', 'focus', 'blur', 'print', 'stop', 'scroll', 'scrollTo', 'scrollBy', 'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getSelection'], { requestAnimationFrame: function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); } });
  G.matchMedia = nat(function (q) { return { matches: false, media: q, addListener: nat(function () {}, 'addListener'), removeListener: nat(function () {}, 'removeListener'), addEventListener: nat(function () {}, 'addEventListener') }; }, 'matchMedia');
  G.getComputedStyle = nat(function () { return { getPropertyValue: nat(function () { return ''; }, 'getPropertyValue') }; }, 'getComputedStyle');
  ['XMLHttpRequest', 'Image', 'MutationObserver', 'Event', 'CustomEvent', 'WebSocket', 'Worker', 'Blob', 'FileReader'].forEach(function (n) { if (!G[n]) G[n] = nat(function () { this.addEventListener = nat(function () {}, 'addEventListener'); this.open = nat(function () {}, 'open'); this.send = nat(function () {}, 'send'); this.setRequestHeader = nat(function () {}, 'setRequestHeader'); this.observe = nat(function () {}, 'observe'); }, n); });
  ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'atob', 'btoa', 'fetch'].forEach(function (n) { if (typeof G[n] === 'function') natives.add(G[n]); });
  G.window = G; G.self = G; G.top = G; G.parent = G; G.frames = G;
  // 采集到的页面全局变量（例如 __ZH__、__INITIAL_STATE__、_bdata 等）
  if (CAP.globals) for (var g in CAP.globals) G[g] = CAP.globals[g];
  // 浏览器中不存在的 Node 特征
  ['global', 'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename'].forEach(function (n) { if (!H.keep[n]) { try { delete G[n]; } catch (e) {} } });
})`;
