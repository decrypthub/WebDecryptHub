// JSRA Sidecar: 单文件可执行。三种模式：默认=WS服务器；mcp-core=运行 js-reverse-core；run-node=沙箱。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODE = process.env.JSRA_MODE || 'server';
const { ensurePatchrightResources, runtimeInfo } = await import('./runtime.mjs');
if (MODE !== 'run-node') await ensurePatchrightResources();
// 父进程看门狗：父进程（Tauri 外壳 / sidecar）意外退出时自行退出，避免遗留孤儿 sidecar / core / Chrome
const PARENT_PID = process.ppid;
function watchParent(onGone) {
  if (!PARENT_PID || PARENT_PID <= 1) return;
  const t = setInterval(() => { let alive = true; try { process.kill(PARENT_PID, 0); } catch (e) { alive = e.code === 'EPERM'; } if (!alive || process.ppid !== PARENT_PID) { clearInterval(t); onGone(); } }, 3000);
  t.unref?.();
}

if (MODE === 'run-node') {
  const { runSandboxFromStdin } = await import('./runner.mjs');
  runSandboxFromStdin();
} else if (MODE === 'mcp-core') {
  // 运行 vendored js-reverse-core（Apache-2.0, fork 自 zhizhuodemao/js-reverse-mcp）作为 MCP server（stdio）
  watchParent(() => process.exit(0));
  process.stdin.on('end', () => setTimeout(() => process.exit(0), 500)); // MCP stdio 断开即退出
  await import('./vendor/core-build/src/main.js');
} else {
  await startServer();
}

async function startServer() {
  const { WebSocketServer } = await import('ws');
  const settingsMod = await import('./settings.mjs');
  const chromeMod = await import('./chrome.mjs');
  const { SessionManager } = await import('./sessions.mjs');
  const { LOCAL_TOOLS } = await import('./localtools.mjs');

  let settings = settingsMod.load();
  const logDir = path.join(settingsMod.userDataDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'sidecar-' + new Date().toISOString().slice(0, 10) + '.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  function fileLog(line) { try { logStream.write('[' + new Date().toISOString() + '] ' + line + '\n'); } catch {} }
  fileLog('sidecar 启动 pid=' + process.pid + ' 资源=' + runtimeInfo.source + (runtimeInfo.error ? ' 错误=' + runtimeInfo.error : ''));

  const clients = new Set();
  // 事件信封带 sid（会话 id）；全局事件 sid=null
  function broadcast(channel, payload, sid = null) {
    if (channel === 'log') fileLog((sid ? '[' + sid + '] ' : '') + String(payload));
    const msg = JSON.stringify({ type: 'event', channel, sid, payload });
    for (const c of clients) { try { c.send(msg); } catch {} }
  }
  const sessions = new SessionManager({ userDataDir: settingsMod.userDataDir(), getSettings: () => settings, broadcast, chromeMod });
  const S = a => sessions.get(a?.sessionId);
  const B = a => { const s = S(a); if (!s.browser.running) throw new Error('该会话的浏览器未启动'); return s.browser; };

  let downloading = null;
  const handlers = {
    'get-settings': () => settings,
    'save-settings': s => { settings = { ...settings, ...s, openai: { ...settings.openai, ...(s?.openai || {}) }, anthropic: { ...settings.anthropic, ...(s?.anthropic || {}) } }; settingsMod.save(settings); for (const x of sessions.sessions.values()) if (x.agent) x.agent.emitContext(); return true; },
    'doctor': () => {
      const chromes = chromeMod.findChrome(settingsMod.userDataDir(), settings.chromePath);
      return { runtime: runtimeInfo, chrome: chromes, chromeOk: chromes.length > 0, downloading: !!downloading, version: process.env.JSRA_APP_VERSION || '' };
    },
    'kernel-info': () => ({ bundled: chromeMod.bundledInfo(settingsMod.userDataDir()), system: chromeMod.findChrome(null, settings.chromePath)[0] || null, kernel: settings.kernel, downloading: !!downloading }),
    'kernel-delete': async () => { if (downloading) return { ok: false, error: '下载中' }; for (const s of sessions.sessions.values()) if (s.browser.running && settings.kernel === 'bundled') await s.closeBrowser().catch(() => {}); chromeMod.deleteBundled(settingsMod.userDataDir()); if (settings.kernel === 'bundled') { settings.kernel = 'system'; settingsMod.save(settings); } return { ok: true }; },
    'find-chrome': () => chromeMod.findChrome(settingsMod.userDataDir(), settings.chromePath),
    'download-chrome': async () => {
      if (downloading) return downloading;
      downloading = (async () => {
        try { const r = await chromeMod.downloadCft(settingsMod.userDataDir(), p => broadcast('download-progress', p)); if (!chromeMod.findChrome(null, settings.chromePath).length) { settings.kernel = 'bundled'; settingsMod.save(settings); } return { ok: true, ...r }; }
        catch (e) { return { ok: false, error: e.message }; }
        finally { setTimeout(() => { downloading = null; }, 0); }
      })();
      return downloading;
    },
    // 会话（多目标站点并行分析，每个会话独立 Chrome/内核/Agent）
    'session-list': () => sessions.list(),
    'session-create': a => sessions.create(a || {}).info(),
    'session-close': async a => { await sessions.close(a?.sessionId); return sessions.list(); },
    'session-rename': a => { const s = S(a); s.title = String(a.title || '').slice(0, 40) || s.title; sessions.emitList(); return true; },
    'session-focus': async a => { await sessions.focus(a?.sessionId); return true; },
    'browser-launch': async a => S(a).launch(),
    'browser-viewport': async a => { const s = S(a); return s.browser.fitViewport(a.width, a.height, a.dpr); },
    'embed-inset': a => S(a).browser.embedInset(),
    'embed-fallback': async a => { const s = S(a); const r = await s.browser.embedFallback(a.reason); sessions.emitList(); return r; },
    'browser-close': async a => { await S(a).closeBrowser(); return true; },
    'navigate': a => B(a).navigate(a.url),
    'new-page': a => B(a).newPage(a.url),
    'select-page': a => B(a).selectPage(a.index),
    'go-back': a => B(a).goBack(),
    'reload': a => B(a).reload(),
    'clear-requests': a => { S(a).browser.clearRequests(); return true; },
    'reset-session': async a => { const { RESET_TOOLS } = await import('./resettools.mjs'); const s = S(a); return RESET_TOOLS[0].run({ confirm: true, scope: a.scope, reload: a.reload }, s.toolCtx()); },
    'restart-fresh': async a => S(a).relaunch({ isolated: true, url: a?.url }),
    'get-requests': async a => { const { summary } = await import('./har.mjs'); const b = S(a).browser; return { list: b.requests.slice(-2000).map(summary), paused: b.net.paused }; },
    'net-detail': async a => { const { detail } = await import('./har.mjs'); const r = S(a).browser.findRequest(a.id); return r ? detail(r) : null; },
    'net-pause': a => S(a).browser.setCapturePaused(a.paused),
    // 导出 HAR：ids 为空则导出全部；path 由原生保存对话框给出
    'har-export': async a => {
      const { toHar } = await import('./har.mjs'); const b = S(a).browser;
      const ids = Array.isArray(a.ids) ? new Set(a.ids) : null;
      const recs = b.requests.filter(r => !ids || ids.has(r.id));
      const out = String(a.path || ''); if (!out || !/\.har$/i.test(out)) throw new Error('导出路径须以 .har 结尾');
      const har = toHar(recs, { version: process.env.JSRA_APP_VERSION });
      fs.writeFileSync(out, JSON.stringify(har, null, 1));
      return { ok: true, path: out, entries: har.log.entries.length, bytes: fs.statSync(out).size };
    },
    'get-scripts': a => S(a).browser.scripts.map(s => ({ id: s.id, url: s.url, size: s.size, file: s.file })),
    'read-file': a => { const s = S(a); const p = path.resolve(s.projectDir, String(a.file || '')); if (!p.startsWith(s.projectDir)) return '拒绝：仅允许读取会话项目目录'; try { return fs.readFileSync(p, 'utf8').slice(0, 300000); } catch (e) { return '读取失败: ' + e.message; } },
    'list-files': a => { const s = S(a); try { return fs.readdirSync(s.projectDir, { recursive: true }).map(String).filter(f => { try { return fs.statSync(path.join(s.projectDir, f)).isFile(); } catch { return false; } }).map(f => ({ name: f, size: fs.statSync(path.join(s.projectDir, f)).size, mtime: fs.statSync(path.join(s.projectDir, f)).mtimeMs })).sort((x, y) => y.mtime - x.mtime); } catch { return []; } },
    'agent-send': a => S(a).send(a),
    'agent-state': a => { const s = S(a); s.ensureAgent(); return s.publicState(); },
    'session-set-mode': a => S(a).setMode(a?.mode),
    'agent-execute': a => {
      const s = S(a);
      if (!s.browser.running) return { ok: false, error: '请先打开浏览器，再执行计划' };
      if (s.mode === 'plan') s.setMode(s.prevMode === 'autonomous' ? 'autonomous' : 'safe');
      return s.send({ text: '请按已确认的计划执行。从任务清单里未完成的步骤继续，现在可以写入文件、运行脚本和调用 shell。' });
    },
    'agent-approval-reply': a => ({ ok: S(a).replyApproval(a?.id, { allow: !!a?.allow, always: !!a?.always }) }),
    'debug-paused': async a => {
      const s = S(a);
      if (!s.browser.running || !s.mcp?.has?.('get_paused_info')) return { paused: false, text: '浏览器分析内核未连接，无法读取断点。' };
      const r = await s.mcp.call('get_paused_info', { includeScopes: true, maxScopeDepth: 2, frameIndex: 0 });
      const paused = !r.isError && /Execution Paused|Call Stack/.test(r.text || '');
      return { paused, text: r.text, isError: !!r.isError };
    },
    'agent-interrupt': a => { S(a).agent?.interrupt(); return true; },
    'agent-wrapup': a => { S(a).agent?.finishSoon(); return true; },
    'agent-reset': a => { S(a).ensureAgent().reset(); return true; },
    'agent-new-chat': a => { const s = S(a); if (s.agent?.running) return false; s.ensureAgent().newChat(); return true; },
    'agent-context': a => S(a).ensureAgent().stats(),
    'agent-compress': async a => { const s = S(a); const ag = s.ensureAgent(); if (ag.running) return { ok: false, error: 'AI 运行中，将在接近上限时自动压缩' }; try { return await ag.compress({ reason: 'manual', instructions: String(a?.instructions || '').slice(0, 500), force: true }); } catch (e) { return { ok: false, error: e.message }; } },
    'test-connection': async (override) => {
      const { testConnection } = await import('./llm.mjs');
      const merged = override ? { ...settings, ...override, openai: { ...settings.openai, ...(override.openai || {}) }, anthropic: { ...settings.anthropic, ...(override.anthropic || {}) } } : settings;
      return testConnection(merged);
    },
    // 更新前调用：先应答，再关掉浏览器、工作区后台任务和 MCP，然后退出。
    // 外壳会等一段时间；到点仍未退出就按进程树强制结束。
    'prepare-exit': () => { gracefulExit(); return { ok: true }; },
    'export-diagnostics': async () => {
      try {
        const out = path.join(settingsMod.userDataDir(), 'diagnostics-' + Date.now() + '.txt');
        const safe = JSON.parse(JSON.stringify(settings));
        if (safe.openai) safe.openai.apiKey = safe.openai.apiKey ? '***已隐藏***' : '';
        if (safe.anthropic) safe.anthropic.apiKey = safe.anthropic.apiKey ? '***已隐藏***' : '';
        let logTail = ''; try { logTail = fs.readFileSync(logFile, 'utf8').slice(-20000); } catch {}
        const chromes = chromeMod.findChrome(settingsMod.userDataDir(), settings.chromePath);
        const content = ['=== WebDecryptHub 诊断信息 ===', '时间: ' + new Date().toLocaleString('zh-CN'), '平台: ' + process.platform + ' ' + process.arch, '运行时: ' + process.version,
          '运行资源: ' + JSON.stringify(runtimeInfo), '会话: ' + JSON.stringify(sessions.list()),
          '检测到的 Chrome: ' + (chromes.map(c => c.source + ':' + c.path).join(' | ') || '无'), '设置: ' + JSON.stringify(safe, null, 2), '', '=== 最近日志 ===', logTail].join('\n');
        fs.writeFileSync(out, content);
        return { ok: true, path: out };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    'read-report': a => { const p = path.join(S(a).projectDir, 'report.md'); try { return { ok: true, path: p, content: fs.readFileSync(p, 'utf8') }; } catch { return { ok: false, path: p, content: '' }; } },
    // 仅开发/测试：直接运行本地工具（JSRA_DEV=1 时启用）
    'tool-run': async a => { if (!process.env.JSRA_DEV) throw new Error('disabled'); const t = LOCAL_TOOLS.find(x => x.name === a.name); if (!t) throw new Error('no tool'); return t.run(a.args || {}, S(a).toolCtx()); },
    'list-tools': a => {
      const s = sessions.get(a?.sessionId, true);
      const local = LOCAL_TOOLS.map(t => ({ name: t.name, description: t.description, kind: '本地' }));
      const m = (s?.mcp?.tools || []).map(t => ({ name: t.name, description: t.description, kind: '浏览器' }));
      return [...m, ...local];
    },
  };

  const port = Number(process.env.JSRA_WS_PORT || 0);
  const wss = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 64 * 1024 * 1024 });
  wss.on('error', e => { fileLog('WS 服务启动失败: ' + e.message); process.stderr.write('WS 服务启动失败: ' + e.message + '\n'); setTimeout(() => process.exit(3), 200); });
  wss.on('listening', () => { const p = wss.address().port; process.stdout.write(`JSRA_PORT=${p}\n`); });
  wss.on('connection', (ws, req) => {
    // 仅接受本机 UI（tauri://、http://tauri.localhost、开发 vite）或无 Origin 的本地客户端
    const origin = req.headers.origin || '';
    if (origin && !/^(tauri:\/\/|https?:\/\/(tauri\.localhost|127\.0\.0\.1|localhost)(:\d+)?$)/.test(origin)) { ws.close(1008, 'origin'); return; }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'input') { sessions.focused()?.browser.input(m.payload); return; }
      if (m.type === 'invoke') {
        const h = handlers[m.channel];
        let result, error = null;
        try { result = h ? await h(m.args) : undefined; if (!h) error = '未知通道: ' + m.channel; }
        catch (e) { error = e.message || String(e); }
        try { ws.send(JSON.stringify({ type: 'reply', id: m.id, result, error })); } catch {}
      }
    });
  });
  async function gracefulExit() {
    try { await sessions.closeAll(); } catch {}
    fileLog('sidecar 退出');
    process.exit(0);
  }
  process.on('SIGINT', gracefulExit);
  process.on('SIGTERM', gracefulExit);
  watchParent(() => { fileLog('父进程已退出，sidecar 自行关闭'); gracefulExit(); });
  process.on('SIGHUP', gracefulExit);
  process.on('uncaughtException', e => { fileLog('uncaughtException: ' + (e && e.stack || e)); broadcast('log', '内部异常: ' + (e && e.message || e)); });
  process.on('unhandledRejection', e => { fileLog('unhandledRejection: ' + (e && (e.stack||e))); });
}
