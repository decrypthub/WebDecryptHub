// 多会话：每个会话 = 独立 Chrome 实例(独立 Profile/CDP 端口) + 独立 js-reverse-core 进程 + 独立 Agent + 独立项目目录。
// 会话之间不共享任何可变状态，因此多个 Agent 可以真正并行；同一会话内的操作由 Agent.running 与 launch 锁串行化。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserManager } from './browser.mjs';
import { McpBridge } from './mcp.mjs';
import { Agent } from './agent.mjs';
import { LOCAL_TOOLS } from './localtools.mjs';
import { wantEmbed } from './settings.mjs';

const MAX_SESSIONS = 6;

class Session {
  constructor(mgr, { id, title, primary, lastUrl }) {
    this.mgr = mgr; this.id = id; this.title = title; this.primary = primary; this.lastUrl = lastUrl || '';
    this.projectDir = path.join(mgr.userDataDir, 'projects', primary ? 'default' : id);
    fs.mkdirSync(this.projectDir, { recursive: true });
    const emit = (ch, p) => mgr.broadcast(ch, p, this.id);
    this.browser = new BrowserManager();
    this.mcp = new McpBridge(m => emit('log', String(m)));
    this.agent = null; this.launching = null; this.lastGoal = null;
    this.browser.on('status', s => { emit('browser-status', s); mgr.emitList(); });
    this.browser.on('requests', l => emit('requests', l));
    this.browser.on('requests-cleared', () => emit('requests-cleared', true));
    this.browser.on('script', s => emit('script', { id: s.id, url: s.url, size: s.size, file: s.file }));
    this.browser.on('frame', f => { if (mgr.focusedId === this.id) emit('frame', f); });
    this.browser.on('log', m => emit('log', m));
    this.browser.on('closed', () => { emit('browser-status', { running: false, pages: [] }); this.mcp.stop(); mgr.emitList(); });
    this.emit = emit;
  }
  info() {
    const live = this.browser.activePage ? safe(() => this.browser.activePage.url()) : '';
    if (/^https?:/.test(live)) this.lastUrl = live;
    const url = live || this.lastUrl;
    return { id: this.id, title: this.title, primary: this.primary, running: this.browser.running, embed: this.browser.embedActive, chromePid: this.browser.embedActive ? this.browser.chromePid : null, agentRunning: !!this.agent?.running, url, projectDir: this.projectDir };
  }
  toolCtx() { return { projectDir: this.projectDir, browser: this.browser, mcp: this.mcp, relaunch: o => this.relaunch(o) }; }
  profileDir() { return this.primary ? path.join(this.mgr.userDataDir, 'chrome-profile') : path.join(this.mgr.userDataDir, 'profiles', this.id); }

  async launch({ isolated, url } = {}) {
    if (this.launching) return this.launching;
    this.launching = (async () => {
      try {
        const settings = this.mgr.getSettings();
        const found = this.mgr.chromeMod.findChrome(this.mgr.userDataDir, settings.chromePath);
        if (!found.length) return { ok: false, needChrome: true, error: '未找到 Chrome/Edge，请在首次运行向导中下载浏览器，或在设置中指定路径' };
        const exe = found[0].path;
        await this.mcp.stop();
        await this.browser.launch({ executablePath: exe, headless: settings.headless, profileDir: this.profileDir(), isolated: isolated ?? (this.primary ? settings.isolated : true), projectDir: this.projectDir, proxy: settings.proxy, embed: wantEmbed(settings) });
        await this.mcp.start({ cdpPort: this.browser.cdpPort, allowedRoot: this.projectDir });
        const prev = this.agent;
        if (!prev) { this.agent = new Agent({ mcp: this.mcp, browser: this.browser, projectDir: this.projectDir, getSettings: this.mgr.getSettings, emit: (ev, p) => { this.emit('agent-' + ev, p); if (ev === 'done' || ev === 'user') this.mgr.emitList(); }, relaunch: o => this.relaunch(o) }); this.agent.restore(); }
        if (this.mgr.focusedId === this.id) await this.browser.startScreencast().catch(() => {});
        if (settings.antiDebug) { try { const { ANTIDEBUG_TOOLS } = await import('./antidebug.mjs'); await ANTIDEBUG_TOOLS[0].run({}, this.toolCtx()); this.emit('log', '已按设置启用反调试绕过'); } catch (e) { this.emit('log', '反调试启用失败: ' + e.message); } }
        try { await this.browser.injector.armAll(); } catch {}
        if (url && /^https?:/.test(url)) await this.browser.navigate(url);
        this.mgr.emitList();
        return { ok: true, chrome: exe, cdpPort: this.browser.cdpPort, toolCount: this.mcp.tools.length + LOCAL_TOOLS.length };
      } catch (e) { this.emit('log', '启动失败: ' + (e.stack || e.message)); return { ok: false, error: e.message }; }
      finally { this.launching = null; }
    })();
    return this.launching;
  }
  async relaunch({ isolated = true, url } = {}) {
    const r = await this.launch({ isolated, url: undefined });
    if (!r.ok) throw new Error(r.error);
    this.emit('log', '已用全新隔离 Profile 重启浏览器：' + this.browser.profileDir);
    if (url && /^https?:/.test(url)) { await this.browser.navigate(url); await new Promise(r => setTimeout(r, 6000)); }
    return { profileDir: this.browser.profileDir, requests: this.browser.requests.length, toolCount: r.toolCount };
  }
  send({ text, auto, maxSteps, tokenBudget }) {
    if (!this.browser.running || !this.agent) return { ok: false, error: '请先打开浏览器' };
    if (this.agent.running) return { ok: false, error: '该会话的 AI 正在运行，请等待或先中断' };
    const s = this.mgr.getSettings(); const key = s.provider === 'anthropic' ? s.anthropic.apiKey : s.openai.apiKey;
    if (!key) return { ok: false, error: '尚未配置 API Key，请在「设置」页填写' };
    this.lastGoal = { text, auto };
    this.agent.send(text, { auto, maxSteps, tokenBudget }).catch(e => this.emit('agent-error', e.message));
    return { ok: true };
  }
  async closeBrowser() { this.agent?.interrupt(); await this.mcp.stop(); await this.browser.close(); this.mgr.emitList(); }
  async dispose() { await this.closeBrowser().catch(() => {}); }
}

export class SessionManager {
  constructor({ userDataDir, getSettings, broadcast, chromeMod }) {
    Object.assign(this, { userDataDir, getSettings, broadcast, chromeMod });
    this.sessions = new Map(); this.focusedId = null; this.seq = 0;
    this.stateFile = path.join(userDataDir, 'sessions.json');
    // 恢复上次的会话标签（标题、最后访问的网址、对话上下文；浏览器按需再启动）
    let saved = null; try { saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch {}
    if (saved?.sessions?.length) {
      for (const x of saved.sessions.slice(0, MAX_SESSIONS)) this.create({ id: x.id, title: x.title, primary: x.primary, lastUrl: x.url, quiet: true });
      if (!this.sessions.has('main')) this.create({ title: '会话 1', primary: true, quiet: true });
      if (saved.focused && this.sessions.has(saved.focused)) this.focusedId = saved.focused;
      this.seq = Math.max(this.seq, saved.seq || 0);
    } else this.create({ title: '会话 1', primary: true });
  }
  list() { return { focused: this.focusedId, sessions: [...this.sessions.values()].map(s => s.info()) }; }
  emitList() {
    const l = this.list(); this.broadcast('sessions', l);
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ focused: l.focused, seq: this.seq, sessions: l.sessions.map(s => ({ id: s.id, title: s.title, primary: s.primary, url: s.url })) })); } catch {}
  }
  create({ title, primary, id: wantId, lastUrl, quiet } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`最多同时 ${MAX_SESSIONS} 个会话（每个会话占用一个独立浏览器）`);
    const id = primary ? 'main' : (wantId && /^s[0-9a-f]{6}$/.test(wantId) ? wantId : 's' + crypto.randomBytes(3).toString('hex'));
    this.seq++;
    const s = new Session(this, { id, title: title || `会话 ${this.seq}`, primary: !!primary, lastUrl });
    this.sessions.set(id, s);
    if (!this.focusedId) this.focusedId = id;
    if (!quiet) this.emitList();
    return s;
  }
  get(id, soft) {
    const s = id ? this.sessions.get(id) : (this.sessions.get(this.focusedId) || this.sessions.values().next().value);
    if (!s && !soft) throw new Error('会话不存在或已关闭：' + id);
    return s;
  }
  focused() { return this.sessions.get(this.focusedId); }
  async focus(id) {
    const s = this.get(id); const prev = this.focused();
    this.focusedId = id;
    if (prev && prev !== s) await prev.browser.stopScreencast().catch(() => {});
    if (s.browser.running) await s.browser.startScreencast().catch(() => {});
    this.emitList();
  }
  async close(id) {
    const s = this.get(id);
    if (s.primary && this.sessions.size === 1) { await s.dispose(); s.agent = null; this.emitList(); return; }
    this.sessions.delete(id);
    if (this.focusedId === id) { const next = this.sessions.values().next().value; this.focusedId = next?.id || null; if (next) await this.focus(next.id).catch(() => {}); }
    await s.dispose();
    this.emitList();
  }
  async closeAll() { await Promise.all([...this.sessions.values()].map(s => s.dispose())); }
}
function safe(f) { try { return f(); } catch { return ''; } }
