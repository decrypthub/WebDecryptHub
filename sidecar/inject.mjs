// 持久注入管理器
// Patchright 可能吞掉 addInitScript / NewDocument 脚本，因此以 framenavigated 立即 evaluate 为主，
// CDP Page.addScriptToEvaluateOnNewDocument + context.addInitScript 为辅，Target.setAutoAttach 覆盖 worker。
import { EventEmitter } from 'node:events';

export class Injector extends EventEmitter {
  constructor(browser) {
    super();
    this.b = browser;
    this.scripts = new Map();
    this._ctxHooked = false;
    this._autoAttach = false;
    this._cdpRoot = null;
    this._armedNames = new Set();
    this._pageHooks = new WeakSet();
  }

  register(name, source) { this.scripts.set(name, source); return name; }
  unregister(name) { this.scripts.delete(name); this._armedNames.delete(name); }
  list() { return [...this.scripts.keys()]; }

  async armAll() {
    if (!this.b.context) return { ok: false, error: 'browser not running' };
    await this._hookContext();
    await this._ensureAutoAttach();
    for (const [name, source] of this.scripts) {
      if (this._armedNames.has(name)) continue;
      const wrapped = wrap(name, source);
      try { await this.b.context.addInitScript({ content: wrapped }); this._armedNames.add(name); }
      catch (e) {
        try { await this.b.context.addInitScript(wrapped); this._armedNames.add(name); }
        catch (e2) { this.emit('log', `addInitScript ${name}: ` + e2.message); }
      }
    }
    const pages = this.b.pages.slice();
    const results = [];
    for (const page of pages) {
      try { results.push(await this.armPage(page)); }
      catch (e) { results.push({ ok: false, error: String(e.message || e) }); }
    }
    return { ok: true, pages: results.length, scripts: this.list(), results };
  }

  async _hookContext() {
    if (this._ctxHooked || !this.b.context) return;
    this._ctxHooked = true;
    this.b.context.on('page', p => {
      this.armPage(p).catch(e => this.emit('log', 'arm new page: ' + e.message));
    });
  }

  _hookPageNav(page) {
    if (!page || this._pageHooks.has(page)) return;
    this._pageHooks.add(page);
    const reinject = async (frame) => {
      if (frame !== page.mainFrame()) return; // 主框；iframe 另处理
      await this._evaluateAll(page);
    };
    page.on('framenavigated', reinject);
    page.on('domcontentloaded', () => this._evaluateAll(page).catch(() => {}));
    page.on('load', () => this._evaluateAll(page).catch(() => {}));
    // iframe
    page.on('frameattached', async (frame) => {
      try {
        for (const [name, source] of this.scripts) {
          await frame.evaluate(wrap(name, source)).catch(() => {});
        }
      } catch {}
    });
  }

  async _evaluateAll(page) {
    if (!page || page.isClosed?.()) return;
    if (!this.scripts.size) return;
    const blob = [...this.scripts].map(([name, source]) => wrap(name, source)).join('\n');
    try { await page.evaluate(blob); }
    catch (e) {
      this.emit('log', 'evaluate blob: ' + (e.message || e));
      for (const [name, source] of this.scripts) {
        try { await page.evaluate(wrap(name, source)); }
        catch (e2) { this.emit('log', `evaluate ${name}: ` + (e2.message || e2)); }
      }
    }
  }

  async armPage(page) {
    if (!page || page.isClosed?.()) return { ok: false, error: 'closed' };
    this._hookPageNav(page);
    const installed = [];
    // CDP NewDocument
    let cdp = page.__jsra_injectCdp;
    if (!cdp) {
      try { cdp = await this.b.context.newCDPSession(page); page.__jsra_injectCdp = cdp; }
      catch (e) { /* continue with evaluate path */ }
    }
    if (cdp) {
      await cdp.send('Page.enable').catch(() => {});
      for (const [name, source] of this.scripts) {
        const wrapped = wrap(name, source);
        try {
          let r;
          try { r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped, runImmediately: true }); }
          catch { r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped }); }
          installed.push(name + ':' + (r?.identifier || 'ok'));
        } catch (e) { this.emit('log', `CDP inject ${name}: ` + e.message); }
      }
    }
    try { await page.addInitScript({ content: [...this.scripts].map(([n, s]) => wrap(n, s)).join('\n') }); } catch {}
    await this._evaluateAll(page);
    return { ok: true, installed };
  }

  async _ensureAutoAttach() {
    if (this._autoAttach || !this.b.context) return;
    const page = this.b.pages[0]; if (!page) return;
    let cdp = page.__jsra_injectCdp;
    try { if (!cdp) { cdp = await this.b.context.newCDPSession(page); page.__jsra_injectCdp = cdp; } } catch { return; }
    this._cdpRoot = cdp;
    cdp.on('Target.attachedToTarget', async ev => {
      const t = ev.targetInfo || {};
      if (!/^(page|iframe|worker|shared_worker|service_worker)$/.test(t.type || '')) return;
      this.emit('log', `inject auto-attach ${t.type} ${String(t.url || '').slice(0, 80)}`);
      if (ev.sessionId) {
        for (const [name, source] of this.scripts) {
          const wrapped = wrap(name, source);
          try { await cdp.send('Runtime.evaluate', { expression: wrapped, returnByValue: true }, ev.sessionId); } catch {}
        }
      }
      if (t.type === 'page') {
        for (const p of this.b.pages) { try { await this.armPage(p); } catch {} }
      }
    });
    try {
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      this._autoAttach = true;
    } catch (e) { this.emit('log', 'setAutoAttach: ' + e.message); }
  }

  async status(page) {
    if (!page) page = this.b.activePage || this.b.pages[0];
    if (!page) return { ok: false, error: 'no page', registered: this.list() };
    try {
      const st = await page.evaluate(() => ({
        registered: (window.__jsra_inject && window.__jsra_inject.registered) || [],
        antiDebug: !!(window.__jsra_antidebug && window.__jsra_antidebug.enabled),
        fingerprint: !!window.__jsra_fp,
        vmp: !!window.__jsra_vmp,
        href: location.href,
      }));
      return { ok: true, ...st, registeredHere: this.list(), contextArmed: [...this._armedNames] };
    } catch (e) { return { ok: false, error: e.message, registeredHere: this.list() }; }
  }

  resetContext() {
    this._ctxHooked = false;
    this._autoAttach = false;
    this._cdpRoot = null;
    this._armedNames.clear();
    this._pageHooks = new WeakSet();
  }
}

function wrap(name, source) {
  return `(function(){try{\n${source}\n}catch(e){try{console.warn('[jsra-inject:${name}]',e&&e.message);}catch{}}
try{window.__jsra_inject=window.__jsra_inject||{registered:[]};if(window.__jsra_inject.registered.indexOf(${JSON.stringify(name)})<0)window.__jsra_inject.registered.push(${JSON.stringify(name)});}catch{}})();`;
}
