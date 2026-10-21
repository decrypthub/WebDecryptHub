// 浏览器管理：Patchright 启动 Chrome（开放 CDP 端口供 js-reverse-core 连接），抓包、脚本收集、Screencast、输入转发
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import { NetCapture, MAX_RECORDS } from './netcap.mjs';
import { summary } from './har.mjs';
import { Injector } from './inject.mjs';

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

  async launch({ executablePath, headless, profileDir, isolated, projectDir, proxy }) {
    await this.close();
    this.projectDir = projectDir;
    this.net.setDir(projectDir);
    fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
    const { chromium } = await import('@zhizhuodemao/patchright');
    const args = ['--test-type', '--hide-crash-restore-bubble', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
    this.headless = !!headless;
    const vw = this.fit?.width || 1366, vh = this.fit?.height || 850;
    if (headless) args.push(`--window-size=${vw},${vh}`);
    const opts = { executablePath, headless, args, viewport: headless ? { width: vw, height: vh } : null, ignoreHTTPSErrors: true, chromiumSandbox: process.platform !== 'linux' || !!process.env.JSRA_SANDBOX };
    if (proxy) opts.proxy = { server: proxy };
    let dir = profileDir;
    if (isolated) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsra-profile-'));
    this.tmpProfile = isolated ? dir : null;
    fs.mkdirSync(dir, { recursive: true });
    try { fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true }); } catch {}
    this.context = await chromium.launchPersistentContext(dir, opts);
    this.profileDir = dir;
    // 读取 DevToolsActivePort
    const portFile = path.join(dir, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
    this.cdpPort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    this.context.on('page', p => { this._addPage(p); if (this.headless && this.fit) p.setViewportSize(this.fit).catch(() => {}); else if (this.fit) setTimeout(() => this._fitHeadedWindow(p), 300); });
    this.context.on('close', () => { this.context = null; this.emit('closed'); });
    for (const p of this.context.pages()) this._addPage(p);
    if (!this.pages.length) await this.context.newPage();
    if (!headless && this.fit) await this._fitHeadedWindow(this.pages[0]);
    this.injector.resetContext();
    await this.injector.armAll().catch(e => this.emit('log', 'inject armAll: ' + e.message));
    this.emit('status', this.status());
    return this.status();
  }

  status() {
    return {
      running: this.running, cdpPort: this.cdpPort,
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
    this.net.attach(page, this.context);
    page.on('response', res => this._onResponse(res));
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
  setCapturePaused(p) { this.net.paused = !!p; return this.net.paused; }
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
    if (!/^[a-z]+:/i.test(url)) url = 'https://' + url;
    let page = this.activePage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://www.google.com/' }).catch(e => { this.emit('log', '导航警告: ' + e.message); });
    this.emit('status', this.status());
    return page.url();
  }

  async newPage(url) { const p = await this.context.newPage(); await this.setActive(p); if (url) await this.navigate(url); }

  async goBack() { await this.activePage?.goBack().catch(() => {}); }
  async reload() { await this.activePage?.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); }

  // 无头模式：让页面视口跟随左侧面板尺寸（CSS 像素），画面 1:1 填满不留黑边；有头模式只限制帧尺寸
  async fitViewport(width, height) {
    width = Math.max(320, Math.min(3840, Math.round(width))); height = Math.max(240, Math.min(2160, Math.round(height)));
    if (this.fit && this.fit.width === width && this.fit.height === height) return this.fit;
    this.fit = { width, height };
    if (this.context && this.headless) await Promise.all(this.pages.map(p => p.setViewportSize(this.fit).catch(() => {})));
    if (this.context && !this.headless) await this._fitHeadedWindow();
    if (this.cdp && this.screencastOn) { const p = this.screencastPage; await this.stopScreencast(true); this.screencastPage = null; if (p) await this.startScreencast(); }
    return this.fit;
  }

  // 有头模式：把真实 Chrome 窗口的内容区调整为与左侧面板同宽高，画面不再被裁切/出现横向滚动
  async _fitHeadedWindow(page = this.activePage) {
    if (!page || !this.fit) return;
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
    const page = this.activePage; if (!page) return;
    if (this.screencastPage === page && this.cdp) return;
    await this.stopScreencast(true);
    this.screencastPage = page;
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', async f => {
      this.lastFrameMeta = f.metadata;
      this.emit('frame', { data: f.data, meta: f.metadata });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: this.fit ? this.fit.width : 1920, maxHeight: this.fit ? this.fit.height : 1200, everyNthFrame: 1 }).catch(e => this.emit('log', 'screencast 失败: ' + e.message));
  }

  async stopScreencast(keepFlag) {
    if (!keepFlag) this.screencastOn = false;
    const cdp = this.cdp; this.cdp = null; this.screencastPage = null;
    if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); }
  }

  async input(ev) {
    const cdp = this.cdp; if (!cdp) return;
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

  async close() {
    try { await this.injector.disarm?.(); } catch {}
    this.injector.resetContext();
    await this.stopScreencast();
    const ctx = this.context; this.context = null;
    this.pages = []; this.activePage = null; this.cdpPort = null;
    if (ctx) await ctx.close().catch(() => {});
    const tmp = this.tmpProfile; this.tmpProfile = null;
    if (tmp) setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1500);
    this.emit('status', this.status());
  }
}

function safe(f) { try { return f(); } catch { return ''; } }
export {BrowserManager};
