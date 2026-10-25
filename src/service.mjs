import fs from 'node:fs';
import metadata from '../package.json' with { type: 'json' };
import path from 'node:path';
import crypto from 'node:crypto';
import { validateArgs } from './protocol.mjs';
import { BrowserManager } from './browser.mjs';
import { McpBridge } from './mcp.mjs';
import { BROWSER_TOOLS } from './browsertools.mjs';
import { FINGERPRINT_TOOLS } from './fingerprint.mjs';
import { ANTIDEBUG_TOOLS } from './antidebug.mjs';
import * as chrome from './chrome.mjs';
import * as kernels from './kernels.mjs';
import { detail, toHar } from './har.mjs';
import { resolveIn } from './paths.mjs';
import { prepareBrowserDistribution } from './windows-runtime.mjs';
import { RESET_TOOLS } from './resettools.mjs';

export const API_VERSION = 1;
export const VERSION = metadata.version;
export class WebRuntime {
  constructor({ root, dataDir, kernelDir = dataDir, desktop = false, options = {} }) {
    this.root = path.resolve(root);
    this.dataDir = path.resolve(dataDir);
    this.kernelDir = path.resolve(kernelDir);
    this.desktop = desktop;
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.dataDir, { recursive: true });
    resolveIn(this.root, '.');
    this.options = { kernel: 'cloak', headless: false, embed: false, isolated: false, ...options };
    this.browser = new BrowserManager();
    this.listeners = new Set();
    this.ids = new WeakMap();
    this.mcp = new McpBridge((message) => this.emit('log', message));
    for (const channel of ['status', 'requests', 'requests-cleared', 'script', 'frame', 'log', 'closed'])
      this.browser.on(channel, (payload) =>
        this.emit(channel, channel === 'status' ? this.status() : payload),
      );
  }
  emit(channel, payload) {
    for (const fn of this.listeners) fn(channel, payload);
  }
  status() {
    const status = this.browser.status();
    return {
      ...status,
      apiVersion: API_VERSION,
      chromeExe: this.browser.chromeExe,
      profileDir: this.browser.profileDir,
      pages: this.browser.pages.map((page, index) => {
        if (!this.ids.has(page)) this.ids.set(page, crypto.randomUUID());
        return { index, id: this.ids.get(page), url: page.url(), active: page === this.browser.activePage };
      }),
    };
  }
  async launch(options = {}) {
    const config = { ...this.options, ...options };
    this.options = config;
    const executable = chrome.resolveKernel(this.kernelDir, config)[0];
    if (!executable)
      return {
        ok: false,
        needChrome: true,
        error:
          config.kernel === 'cloak'
            ? 'CloakBrowser 尚未安装。运行 wdh kernel install cloak，或选择系统 Chrome / Edge。'
            : '所选浏览器未安装或路径无效。',
      };
    await this.mcp.stop();
    await this.browser.launch({
      executablePath: executable.path,
      headless: config.headless,
      profileDir: config.profileDir || path.join(this.dataDir, 'profile'),
      isolated: config.isolated,
      projectDir: this.dataDir,
      proxy: config.proxy,
      embed: this.desktop && config.embed,
    });
    if (config.antiDebug) {
      this.browser.injector.antiDebug = true;
      await this.browser.injector.armAll();
    }
    if (config.url) await this.browser.navigate(config.url);
    return { ok: true, chrome: executable.path, ...this.status() };
  }
  async ensureDebugger(root = this.root) {
    if (!this.browser.running) throw Error('请先 browser_open');
    if (this.mcp.client && this.mcp.opts?.allowedRoot === root) return;
    this.root = path.resolve(root);
    resolveIn(this.root, '.');
    await this.mcp.start({
      cdpPort: this.browser.cdpPort,
      allowedRoot: this.root,
      runtimeDir: path.join(this.dataDir, '.debugger'),
    });
  }
  async bindTarget() {
    const page = this.browser.activePage;
    if (!page || page.isClosed()) throw Error('浏览器页面已关闭');
    const session = await page.context().newCDPSession(page);
    try {
      const info = await session.send('Target.getTargetInfo');
      await this.mcp.selectTarget(info.targetInfo.targetId);
    } finally {
      await session.detach();
    }
  }
  checkTarget(expected) {
    if (!expected) return;
    const active = this.status().pages.find((p) => p.active);
    if (!active || active.id !== expected.id || active.url !== expected.url)
      throw Error('目标网页已变化，请重新检查后操作。');
  }
  tools() {
    return [...BROWSER_TOOLS, ...FINGERPRINT_TOOLS, ...ANTIDEBUG_TOOLS]
      .map(({ name, description, schema }) => ({ name, description, inputSchema: schema }))
      .concat(
        [
          {
            name: 'discover_tools',
            description: '加载 debugger 工具并读取真实 schema；browser 工具已可用。',
            inputSchema: {
              type: 'object',
              properties: { group: { type: 'string', enum: ['browser', 'debugger'] } },
              required: ['group'],
            },
          },
        ],
        this.mcp.tools.map((t) => ({ ...t })),
      );
  }
  async call(name, args = {}, expected, signal) {
    signal?.throwIfAborted();
    this.checkTarget(expected);
    if (name === 'discover_tools') {
      if (!['browser', 'debugger'].includes(args.group)) throw Error('Unknown tool group');
      if (args.group === 'debugger') await this.ensureDebugger();
      return { text: JSON.stringify(this.tools()) };
    }
    const local = [...BROWSER_TOOLS, ...FINGERPRINT_TOOLS, ...ANTIDEBUG_TOOLS].find((t) => t.name === name);
    if (local) {
      const checked = validateArgs(local.schema, args, { strict: true });
      if (!checked.ok) throw Error(checked.error);
      args = checked.value;
      if (this.mcp.client && ['browser_click', 'browser_fill', 'browser_press'].includes(name))
        await this.bindTarget();
      return local.run(args, {
        browser: this.browser,
        mcp: this.mcp,
        projectDir: this.dataDir,
        workRoot: this.root,
        signal,
        openBrowser: async (options) =>
          this.browser.running
            ? this.browser.navigate(options.url).then(() => ({ ok: true }))
            : this.launch(options),
        emit: (event, value) => this.emit(event, value),
      });
    }
    if (this.mcp.has(name)) {
      await this.bindTarget();
      return this.mcp.call(name, args, signal);
    }
    throw Error('未知 WDH 工具：' + name);
  }
  async control(action, args = {}) {
    if (!this.desktop) throw Error('Desktop control is available only to an owning desktop process');
    switch (action) {
      case 'hello':
        return {
          apiVersion: API_VERSION,
          version: VERSION,
          tools: BROWSER_TOOLS.map(({ name, description, schema, group }) => ({
            name,
            description,
            schema,
            group,
          })),
          status: this.status(),
        };
      case 'launch':
        return this.launch(args);
      case 'close':
        await this.mcp.stop();
        await this.browser.close();
        return true;
      case 'navigate':
        await this.browser.navigate(args.url);
        return this.status();
      case 'select':
        await this.browser.setActive(this.browser.pages[args.index]);
        return this.status();
      case 'new-page':
        await this.browser.newPage(args.url);
        return this.status();
      case 'go-back':
        await this.browser.goBack();
        return this.status();
      case 'reload':
        await this.browser.reload();
        return this.status();
      case 'viewport':
        return this.browser.fitViewport(args.width, args.height, args.dpr);
      case 'input':
        this.checkTarget(args.expected);
        return this.browser.input(args.event);
      case 'start-frames':
        await this.browser.startScreencast();
        return true;
      case 'stop-frames':
        await this.browser.stopScreencast();
        return true;
      case 'embed-inset':
        return this.browser.embedInset();
      case 'embed-fallback':
        return this.browser.embedFallback(args.reason);
      case 'capture-pause':
        this.browser.setCapturePaused(args.paused);
        return true;
      case 'clear-requests':
        this.browser.clearRequests();
        return true;
      case 'reset':
        return RESET_TOOLS[0].run(
          { confirm: true, ...args },
          {
            browser: this.browser,
            projectDir: this.dataDir,
            workRoot: this.root,
            relaunch: (options) => this.launch(options),
          },
        );
      case 'requests':
        return this.browser.requests;
      case 'net-detail': {
        const record = this.browser.requests.find((r) => r.id === args.id);
        return record ? detail(record) : null;
      }
      case 'title':
        return this.browser.activePage?.title() || '';
      case 'debugger-start':
        await this.ensureDebugger(args.allowedRoot || this.root);
        return {
          tools: [...FINGERPRINT_TOOLS, ...ANTIDEBUG_TOOLS]
            .map(({ name, description, schema }) => ({ name, description, inputSchema: schema }))
            .concat(this.mcp.tools),
        };
      case 'debugger-stop':
        await this.mcp.stop();
        return true;
      case 'debugger-bind':
        await this.bindTarget();
        return true;
      case 'har':
        return toHar(this.browser.requests.filter((r) => !args.ids || args.ids.includes(r.id)));
      case 'kernel-info':
        return {
          bundled: chrome.bundledInfo(this.kernelDir),
          cloak: kernels.installedKernel(this.kernelDir, 'cloak'),
          github: kernels.installedKernel(this.kernelDir, 'github'),
          system: chrome.findChrome(null)[0] || null,
        };
      case 'kernel-resolve':
        return chrome.resolveKernel(this.kernelDir, args);
      case 'kernel-download':
        return kernels.downloadGithub(this.kernelDir, args, (p) => this.emit('download-progress', p));
      case 'kernel-cft':
        return chrome.downloadCft(this.kernelDir, (p) => this.emit('download-progress', p));
      case 'kernel-probe':
        return kernels.probeKernel(
          this.kernelDir,
          args.path || chrome.resolveKernel(this.kernelDir, args)[0]?.path,
        );
      case 'kernel-delete':
        return chrome.deleteBundled(this.kernelDir);
      case 'kernel-repair': {
        const installed =
          args.kind === 'bundled'
            ? chrome.bundledInfo(this.kernelDir)
            : kernels.installedKernel(this.kernelDir, args.kind);
        if (!installed) throw Error('内核未安装');
        if (this.browser.running) throw Error('请先关闭浏览器');
        await prepareBrowserDistribution(path.dirname(installed.path), this.kernelDir);
        return kernels.probeKernel(this.kernelDir, installed.path);
      }
      default:
        throw Error('Unsupported WDH desktop operation: ' + action);
    }
  }
  async close() {
    await this.mcp.stop();
    await this.browser.close();
  }
}
