// 浏览器管理：Patchright 启动 Chrome（开放 CDP 端口供 js-reverse-core 连接），抓包、脚本收集、Screencast、输入转发
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import { NetCapture, MAX_RECORDS } from './netcap.mjs';
import { summary } from './har.mjs';
import { Injector } from './inject.mjs';
import { isLaunchedChrome, killPidTree, readProcessIdentity } from './proctree.mjs';
import { normalizeTargetUrl } from './url.mjs';
import { requireNormalExecutable } from './windows-runtime.mjs';

export const CHROME_CLOSE_TIMEOUT_MS = 8000;

/**
 * 先等 ctx.close()。到点还没结束才说明 Chrome 卡住，这时再核对 pid 的映像和启动参数。
 * close 一旦返回（成功或失败），pid 可能已被系统复用，绝不能再 taskkill /T。
 */
export async function closeLaunchedBrowser(ctx, {
  chromePid,
  chromeExe,
  profileDir,
  timeoutMs = CHROME_CLOSE_TIMEOUT_MS,
  readIdentity = readProcessIdentity,
  kill = killPidTree,
  platform = process.platform,
} = {}) {
  if (!ctx || typeof ctx.close !== 'function') return { killed: false, reason: 'no-context' };
  let timer;
  let finished = false;
  try {
    finished = await Promise.race([
      Promise.resolve().then(() => ctx.close()).then(() => true, () => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (finished) return { killed: false, reason: 'closed' };
  let identity = { image: '', commandLine: '' };
  try { identity = await Promise.resolve(readIdentity(chromePid, platform)) || identity; } catch {}
  if (!isLaunchedChrome(identity, { exe: chromeExe, profileDir, platform })) {
    return { killed: false, reason: 'identity-mismatch', image: identity.image || '' };
  }
  try { kill(chromePid, platform); } catch {}
  return { killed: true, reason: 'hung' };
}

class BrowserManager extends EventEmitter {
  constructor() {
    super();
    this.context = null; this.browser = null;
    this.pages = []; this.activePage = null;
    this.requests = []; this.reqSeq = 0; this.reqMap = new WeakMap();
    this.scripts = []; this.scriptSeq = 0;
    this.cdpPort = null; this.cdp = null; this.screencastPage = null;
    this.projectDir = null; this.lastFrameMeta = null;
    this.net = new NetCapture(this); this.imported = []; this._dirty = new Map(); this._flushT = null;
    this.injector = new Injector(this);
    this.injector.on('log', m => this.emit('log', m));
  }

  get running() { return !!this.context; }
  // 真正处于原生嵌入状态（Windows 有头 + 拿到 PID + 未回落）
  get embedActive() { return !!(this.context && this.embed && this.chromePid && !this.embedFailed); }

  // 前端/Rust 报告嵌入失败 → 回落到 screencast（窗口仍在屏幕外，渲染不受遮挡影响）
  // Chrome 自带标签栏/地址栏/边框的尺寸（CSS px），Rust 侧据此把它们裁到宿主窗口外
  async embedInset() {
    const p = this.activePage; if (!p) return null;
    const d = await p.evaluate(() => ({ ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight })).catch(() => null);
    return d ? insetFrom(d) : null;
  }

  async embedFallback(reason) {
    if (!this.embed || this.embedFailed) return false;
    this.embedFailed = true;
    this.emit('log', '原生嵌入失败，已回落 screencast：' + (reason || '未知原因'));
    if (this.screencastOn) { this.screencastPage = null; await this.startScreencast(); }
    this.emit('status', this.status());
    return true;
  }

  async launch({ executablePath, headless, profileDir, isolated, projectDir, proxy, embed, dock }) {
    if (executablePath) await requireNormalExecutable(executablePath);
    await this.close();
    this.projectDir = projectDir;
    this.net.setDir(projectDir);
    fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
    const { chromium } = await import('@zhizhuodemao/patchright');
    const args = ['--test-type', '--hide-crash-restore-bubble', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
    this.headless = !!headless;
    const vw = this.fit?.width || 1366, vh = this.fit?.height || 850;
    if (headless) args.push(`--window-size=${vw},${vh}`);
    // 伪嵌入：先放到屏幕外，等宿主用 CDP 把窗口停靠到面板矩形，避免闪一下。
    this.dock = !!dock && !headless;
    if (this.dock) args.push('--window-position=-32000,-32000', `--window-size=${vw},${vh}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding');
    // Windows 嵌入模式：窗口先放到屏幕外（不闪现），等 Rust 侧 SetParent 进主窗口后再显示；
    // 被遮挡/隐藏的会话也要持续渲染（回落 screencast 时仍有画面）
    this.embed = !!embed && !headless; this.embedFailed = false; this.chromePid = null;
    this.chromeExe = executablePath || '';
    if (this.embed) args.push('--window-position=-32000,-32000', `--window-size=${vw},${vh + 88}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding');
    if (this.embed && process.platform === 'linux' && process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=x11');
    // 无头：按面板的 devicePixelRatio 渲染，screencast 帧为设备像素，画面清晰
    const dsf = headless && this.dpr > 1 ? this.dpr : undefined;
    const opts = { executablePath, headless, args, viewport: headless ? { width: vw, height: vh } : null, ...(dsf ? { deviceScaleFactor: dsf } : {}), ignoreHTTPSErrors: true, chromiumSandbox: process.platform !== 'linux' || !!process.env.JSRA_SANDBOX };
    if (proxy) opts.proxy = { server: proxy };
    // Playwright 默认在本机临时目录建 playwright-artifacts-*，有两个问题：
    //  1) 打包后的 sidecar（bun 编译产物）在那里会 EPERM，等于开不了浏览器；
    //  2) 每启一次浏览器就在 %TEMP% 留一个目录（本机已积了 40 多个）。
    // 显式指到会话目录下，两个问题都没有，而且产物跟着会话一起清。
    opts.artifactsDir = path.join(projectDir, '.artifacts');
    try { fs.mkdirSync(opts.artifactsDir, { recursive: true }); } catch {}
    let dir = profileDir;
    // Keep browser state inside this chat, independent of the host TEMP ACLs.
    if (isolated) { const root = path.join(projectDir, '.browser-profiles'); fs.mkdirSync(root, { recursive: true }); dir = fs.mkdtempSync(path.join(root, 'profile-')); }
    this.tmpProfile = isolated ? dir : null;
    fs.mkdirSync(dir, { recursive: true });
    try { fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true }); } catch {}
    try { this.context = await chromium.launchPersistentContext(dir, { ...opts, timeout: 30000 }); }
    catch (e) { this.emit('status', this.status()); throw new Error('浏览器启动失败（' + executablePath + '）：' + e.message); }
    this.profileDir = dir;
    // 读取 DevToolsActivePort
    const portFile = path.join(dir, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
    this.cdpPort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    this.chromePid = await browserPid(this.cdpPort).catch(e => { this.emit('log', '获取 Chrome PID 失败：' + e.message); return null; });
    if (this.embed && !this.chromePid) this.embedFailed = true;
    this.context.on('page', p => { this._addPage(p); if (this.headless && this.fit) p.setViewportSize(this.fit).catch(() => {}); else if (this.fit) setTimeout(() => this._fitHeadedWindow(p), 300); });
    this.context.on('close', () => { this.context = null; this.emit('closed'); });
    for (const p of this.context.pages()) this._addPage(p);
    if (!this.pages.length) await this.context.newPage();
    await Promise.all(this.pages.map(p => this.captureReady?.get(p)));
    if (!headless && this.fit) await this._fitHeadedWindow(this.pages[0]);
    this.injector.resetContext();
    await this.injector.armAll().catch(e => this.emit('log', 'inject armAll: ' + e.message));
    this.emit('status', this.status());
    return this.status();
  }

  status() {
    return {
      running: this.running, cdpPort: this.cdpPort, capturePaused: this.net.paused,
      embed: this.embedActive, dock: !!(this.dock && this.running), chromePid: this.embedActive ? this.chromePid : null,
      pages: this.pages.map((p, i) => ({ index: i, url: safe(() => p.url()), active: p === this.activePage })),
    };
  }

  _addPage(page) {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    page.on('close', () => {
      this.pages = this.pages.filter(p => p !== page);
      if (this.activePage === page) this.setActive(this.pages[this.pages.length - 1] || null);
      this.emit('status', this.status());
    });
    page.on('framenavigated', f => { if (f === page.mainFrame()) this.emit('status', this.status()); });
    this.captureReady ||= new WeakMap();
    this.captureReady.set(page, this.net.attach(page, this.context).catch(e => this.emit('log', '抓包初始化失败：' + e.message)));
    // General browsing does not automatically copy every website script to disk.
    this.setActive(page);
  }

  async setActive(page) {
    this.activePage = page;
    this.emit('status', this.status());
    if (this.screencastOn) await this.startScreencast();
  }

  async selectPage(index) { const p = this.pages[index]; if (p) { await this.setActive(p); try { await p.bringToFront(); } catch {} } }

  _push(r) { this.requests.push(r); if (this.requests.length > MAX_RECORDS) this.requests.splice(0, 500); }
  // 变更合并后每 250ms 批量推送摘要，避免高频轮询接口刷爆 UI
  _changed(r) { this._dirty.set(r.id, r); if (!this._flushT) this._flushT = setTimeout(() => { this._flushT = null; const list = [...this._dirty.values()].map(summary); this._dirty.clear(); this.emit('requests', list); }, 250); }
  setCapturePaused(p) { this.net.paused = !!p; this.emit('status', this.status()); return this.net.paused; }
  findRequest(id) { return this.requests.find(r => r.id === id) || this.imported.find(r => r.id === id); }

  async _onResponse(res) {
    try {
      const req = res.request();
      if (req.resourceType() !== 'script') return;
      const body = await res.text();
      const hash = crypto.createHash('md5').update(body).digest('hex').slice(0, 10);
      if (this.scripts.find(s => s.hash === hash)) return;
      const id = 's' + (++this.scriptSeq);
      const name = (new URL(res.url()).pathname.split('/').pop() || 'index').replace(/[^\w.-]/g, '_').slice(0, 60);
      const file = path.join(this.projectDir, 'scripts', `${id}_${name}${name.endsWith('.js') ? '' : '.js'}`);
      fs.writeFileSync(file, body);
      const s = { id, url: res.url(), file, size: body.length, hash };
      this.scripts.push(s);
      this.emit('script', s);
    } catch {}
  }

  async navigate(url) {
    url = normalizeTargetUrl(url);
    if (!url) return '';
    let page = this.activePage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    await this.captureReady?.get(page);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      this.emit('log', '导航失败：' + e.message);
      throw new Error('打开网页失败：' + e.message);
    }
    this.emit('status', this.status());
    return page.url();
  }

  async newPage(url) { const p = await this.context.newPage(); await this.setActive(p); if (url) await this.navigate(url); }

  async goBack() { await this.activePage?.goBack().catch(() => {}); }
  async reload() { await this.activePage?.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); }

  // 无头模式：让页面视口跟随左侧面板尺寸（CSS 像素），画面 1:1 填满不留黑边；有头模式只限制帧尺寸
  async fitViewport(width, height, dpr) {
    width = Math.max(320, Math.min(3840, Math.round(width))); height = Math.max(240, Math.min(2160, Math.round(height)));
    dpr = clampDpr(dpr);
    if (this.fit && this.fit.width === width && this.fit.height === height && this.dpr === dpr) return this.fit;
    this.fit = { width, height }; this.dpr = dpr;
    if (this.embedActive) return this.fit; // 尺寸由 Rust 侧 SetWindowPos 控制
    if (this.context && this.headless) await Promise.all(this.pages.map(p => p.setViewportSize(this.fit).catch(() => {})));
    if (this.context && !this.headless) await this._fitHeadedWindow();
    if (this.cdp && this.screencastOn) { const p = this.screencastPage; await this.stopScreencast(true); this.screencastPage = null; if (p) await this.startScreencast(); }
    return this.fit;
  }

  // 有头模式：把真实 Chrome 窗口的内容区调整为与左侧面板同宽高，画面不再被裁切/出现横向滚动
  async _fitHeadedWindow(page = this.activePage) {
    if (!page || !this.fit || this.embedActive) return;
    try {
      const cdp = await this.context.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      const dims = await page.evaluate(() => ({ ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight })).catch(() => null);
      const padW = dims ? Math.max(0, dims.ow - dims.iw) : 0, padH = dims ? Math.max(0, dims.oh - dims.ih) : 88;
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: this.fit.width + padW, height: this.fit.height + padH } });
      await cdp.detach().catch(() => {});
    } catch (e) { this.emit('log', '调整有头窗口失败: ' + e.message); }
  }

  // ---- screencast ----
  async startScreencast() {
    this.screencastOn = true;
    if (this.embedActive) { await this.stopScreencast(true); return; } // 嵌入时无需 screencast/输入转发
    const page = this.activePage; if (!page) return;
    if (this.screencastPage === page && this.cdp) return;
    await this.stopScreencast(true);
    this.screencastPage = page;
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;
    let last = null, idleT = null;
    cdp.on('Page.screencastFrame', async f => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      this.lastFrameMeta = f.metadata;
      if (f.data === last) return; // 截图引起的重复帧：不重发、不重置空闲计时（避免 PNG 循环）
      last = f.data;
      this.emit('frame', { data: f.data, meta: f.metadata, fmt: 'jpeg' });
      // 画面静止 400ms 后补发一帧无损 PNG，文字边缘完全清晰
      clearTimeout(idleT);
      idleT = setTimeout(async () => {
        if (this.cdp !== cdp) return;
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(this.headless ? {} : { fromSurface: true }) }).catch(() => null);
        if (r?.data && this.cdp === cdp) this.emit('frame', { data: r.data, meta: this.lastFrameMeta, fmt: 'png' });
      }, 400);
    });
    cdp.once('Detached', () => clearTimeout(idleT));
    const sz = screencastSize(this.fit, this.dpr);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: sz.maxWidth, maxHeight: sz.maxHeight, everyNthFrame: 1 }).catch(e => this.emit('log', 'screencast 失败: ' + e.message));
  }

  async stopScreencast(keepFlag) {
    if (!keepFlag) this.screencastOn = false;
    const cdp = this.cdp; this.cdp = null; this.screencastPage = null;
    if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); }
  }

  async input(ev) {
    const cdp = this.cdp; if (!cdp || this.embedActive) return;
    const m = this.lastFrameMeta;
    const scale = m ? (m.deviceWidth / ev.w) : 1;
    const x = ev.x * scale, y = ev.y * scale;
    try {
      if (ev.kind === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', { type: ev.type, x, y, button: ev.button || 'left', clickCount: ev.clickCount || (ev.type === 'mouseMoved' ? 0 : 1), buttons: ev.type === 'mouseMoved' ? 0 : 1 });
      } else if (ev.kind === 'wheel') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: ev.dx || 0, deltaY: ev.dy || 0 });
      } else if (ev.kind === 'key') {
        if (ev.text && ev.text.length === 1 && ev.type === 'keyDown') {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ev.text, key: ev.key, code: ev.code });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ev.key, code: ev.code });
        } else if (ev.type === 'keyDown') {
          const vk = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }[ev.key];
          await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ev.key, code: ev.code, windowsVirtualKeyCode: vk, text: ev.key === 'Enter' ? '\r' : undefined });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ev.key, code: ev.code, windowsVirtualKeyCode: vk });
        }
      }
    } catch {}
  }

  clearRequests() { this.requests = []; this._dirty.clear(); this.emit('requests-cleared'); }

  // 伪嵌入：CDP Browser 域移动/缩放/最小化真实窗口，不需要辅助功能权限。
  async dockWindow({ left, top, width, height, hidden } = {}) {
    if (!this.context) throw Error('浏览器尚未启动');
    const browser = this.context.browser();
    if (!browser) throw Error('当前配置不支持窗口停靠');
    const session = await browser.newBrowserCDPSession();
    try {
      const { targetInfos } = await session.send('Target.getTargets');
      const page = targetInfos.find(target => target.type === 'page');
      if (!page) throw Error('没有可停靠的页面');
      const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: page.targetId });
      const bounds = hidden
        ? { windowState: 'minimized' }
        : { windowState: 'normal', left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
      await session.send('Browser.setWindowBounds', { windowId, bounds });
      return { ok: true, windowId };
    } finally { await session.detach().catch(() => {}); }
  }
  async close() {
    try { await this.injector.disarm?.(); } catch {}
    this.injector.resetContext();
    await this.stopScreencast();
    const ctx = this.context; this.context = null;
    this.pages = []; this.activePage = null; this.cdpPort = null;
    const chrome = this.chromePid; this.chromePid = null;
    if (ctx) {
      const outcome = await closeLaunchedBrowser(ctx, {
        chromePid: chrome,
        chromeExe: this.chromeExe,
        profileDir: this.profileDir,
        timeoutMs: this.chromeCloseTimeoutMs,
        readIdentity: this.readBrowserIdentity,
        kill: this.killBrowserTree,
      });
      if (outcome.reason === 'identity-mismatch') {
        this.emit('log', '关闭浏览器超时，但该 PID 已不是本次启动的 Chrome，已跳过强制结束');
      }
    }
    const tmp = this.tmpProfile; this.tmpProfile = null;
    if (tmp) setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1500);
    this.emit('status', this.status());
  }
}

function safe(f) { try { return f(); } catch { return ''; } }
function insetFrom({ ow, oh, iw, ih }) {
  const side = Math.max(0, Math.min(40, (ow - iw) / 2));
  return { top: Math.max(0, oh - ih - side), left: side, right: side, bottom: side };
}
function clampDpr(d) { d = Number(d); return Number.isFinite(d) && d > 0 ? Math.min(4, Math.max(1, Math.round(d * 100) / 100)) : 1; }
// screencast 帧上限 = 面板 CSS 尺寸 × devicePixelRatio（设备像素），保证 1:1 显示不被缩放模糊
function screencastSize(fit, dpr) {
  const d = clampDpr(dpr);
  if (!fit) return { maxWidth: Math.round(1920 * d), maxHeight: Math.round(1200 * d) };
  return { maxWidth: Math.round(fit.width * d), maxHeight: Math.round(fit.height * d) };
}
// 通过浏览器级 CDP 取 Chrome 主进程 PID（Rust 侧按 PID EnumWindows 找顶层窗口）
async function browserPid(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }));
    ws.onerror = e => { clearTimeout(t); reject(new Error('ws error')); };
    ws.onmessage = m => {
      let j; try { j = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      if (j.id !== 1) return;
      clearTimeout(t); try { ws.close(); } catch {}
      const b = (j.result?.processInfo || []).find(p => p.type === 'browser');
      b ? resolve(b.id) : reject(new Error(j.error?.message || 'no browser process'));
    };
  });
}
export {BrowserManager, screencastSize, clampDpr, insetFrom};
