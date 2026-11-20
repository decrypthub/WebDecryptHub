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
import { detail, readBody, shortUrl, summary, toHar } from './har.mjs';
import { resolveIn } from './paths.mjs';
import { prepareBrowserDistribution } from './windows-runtime.mjs';
import { RESET_TOOLS } from './resettools.mjs';

const LOCAL_TOOLS = [...BROWSER_TOOLS, ...FINGERPRINT_TOOLS, ...ANTIDEBUG_TOOLS, ...RESET_TOOLS];
const REQUEST_INITIATOR_TOOL = 'get_request_initiator';
const CAPTURE_INITIATOR_SCHEMA = {
  type: 'object',
  properties: { requestId: { type: 'string' } },
  required: ['requestId'],
  additionalProperties: false,
};

function describeDebuggerTool(tool) {
  if (tool.name !== REQUEST_INITIATOR_TOOL) return tool;
  const { inputSchema } = tool;
  return {
    ...tool,
    description: '读取已捕获请求的发起调用栈。支持直接使用 browser_requests 返回的字符串 id，也兼容调试器网络列表中的数字 reqid。',
    inputSchema: {
      ...inputSchema,
      properties: {
        ...inputSchema.properties,
        requestId: {
          description: 'browser_requests 的字符串 id，或 list_network_requests 的数字 reqid。记录清空或淘汰后失效。',
          anyOf: [CAPTURE_INITIATOR_SCHEMA.properties.requestId, inputSchema.properties.requestId],
        },
      },
    },
  };
}

function capturedRequestInitiator(browser, requestId) {
  const record = browser.findRequest(requestId);
  if (!record) throw Error(`抓包记录 ${requestId} 不存在或已清空，请从 browser_requests 重新获取 ID。`);
  const initiator = browser.net.getInitiator(record);
  const data = { requestId, requestUrl: record.url, initiator };
  const summary = initiator?.stack
    ? `请求 ${requestId} 的发起信息`
    : `请求 ${requestId} 没有记录到 JavaScript 发起调用栈。`;
  return {
    content: [{ type: 'text', text: summary + '\n' + JSON.stringify(data) }],
    structuredContent: { ok: true, tool: REQUEST_INITIATOR_TOOL, summary, data },
  };
}

function desktopCaptureDetail(record, initiator) {
  const frames = [];
  for (let stack = initiator?.stack; stack && frames.length < 100; stack = stack.parent) {
    for (const frame of stack.callFrames.slice(0, 100 - frames.length)) {
      frames.push({
        functionName: frame.functionName.slice(0, 512),
        url: shortUrl(frame.url),
        line: frame.lineNumber + 1,
        column: frame.columnNumber + 1,
      });
    }
  }
  const headers = Object.entries(record.respHeaders ?? {}).map(([name, value]) => `${name}: ${value}`).join('\n');
  return {
    id: record.id,
    headers: headers.slice(0, 16_000),
    headersTruncated: headers.length > 16_000,
    body: readBody(record, 45_000),
    frames,
  };
}

export function describeTools(debuggerTools = []) {
  return [
    ...LOCAL_TOOLS.map(({ name, description, schema }) => ({ name, description, inputSchema: schema })),
    {
      name: 'discover_tools',
      description: '加载分析工具（evaluate_script、take_screenshot、控制台、网络列表、脚本、断点、WebSocket）并读取真实 schema。需要先 browser_open；已打开页面时首次使用这些工具必须先调用一次。browser_* 与本地文件工具无需加载。',
      inputSchema: {
        type: 'object',
        properties: {
          group: {
            type: 'string',
            enum: ['browser', 'debugger'],
            description: 'debugger 加载分析与调试工具（多数逆向任务用这个）；browser 只返回当前工具清单不额外加载。',
          },
        },
        required: ['group'],
      },
    },
    ...debuggerTools.map(describeDebuggerTool),
  ];
}

export const API_VERSION = 1;
export const VERSION = metadata.version;
export class WebRuntime {
  #captureGeneration = crypto.randomUUID();

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
            ? 'CloakBrowser 尚未安装。运行 wdh kernel install cloak，或在桌面插件页下载内核。'
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
      dock: this.desktop && config.dock,
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
    return describeTools(this.mcp.tools);
  }
  async call(name, args = {}, expected, signal) {
    signal?.throwIfAborted();
    this.checkTarget(expected);
    if (name === 'discover_tools') {
      if (!['browser', 'debugger'].includes(args.group)) throw Error('Unknown tool group');
      if (args.group === 'debugger') await this.ensureDebugger();
      return { text: JSON.stringify(this.tools()) };
    }
    const ctx = {
      browser: this.browser,
      mcp: this.mcp,
      projectDir: this.dataDir,
      workRoot: this.root,
      signal,
      relaunch: (options) => this.launch(options),
      openBrowser: async (options) =>
        this.browser.running
          ? this.browser.navigate(options.url).then(() => ({ ok: true }))
          : this.launch(options),
      emit: (event, value) => this.emit(event, value),
    };
    const local = LOCAL_TOOLS.find((t) => t.name === name);
    if (local) {
      const checked = validateArgs(local.schema, args, { strict: true });
      if (!checked.ok) throw Error(checked.error);
      args = checked.value;
      if (this.mcp.client && ['browser_click', 'browser_fill', 'browser_press'].includes(name))
        await this.bindTarget();
      return local.run(args, ctx);
    }
    if (this.mcp.has(name)) {
      if (name === REQUEST_INITIATOR_TOOL && typeof args.requestId === 'string') {
        const checked = validateArgs(CAPTURE_INITIATOR_SCHEMA, args, { strict: true });
        if (!checked.ok) throw Error(checked.error);
        return capturedRequestInitiator(this.browser, checked.value.requestId);
      }
      await this.bindTarget();
      return this.mcp.callTool(name, args, signal);
    }
    // 调试器层工具要 discover_tools 之后才可见。只报"未知工具"会让调用方
    // 以为工具不存在，实际上只是还没加载。
    const hint = this.mcp.tools.length === 0
      ? '该工具属于调试器层，需要先调用 discover_tools({ group: "debugger" })。'
      : '可用工具见 discover_tools 的返回。参数名拼错时错误里会列出可接受的名称。';
    throw Error(`未知 WDH 工具：${name}。${hint}`);
  }
  async control(action, args = {}) {
    if (!this.desktop) throw Error('Desktop control is available only to an owning desktop process');
    switch (action) {
      case 'hello':
        return {
          apiVersion: API_VERSION,
          capabilities: { pageTabs: true },
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
      case 'dock':
        return this.browser.dockWindow(args);
      case 'close':
        await this.mcp.stop();
        await this.browser.close();
        return true;
      case 'navigate':
        await this.browser.navigate(args.url);
        return this.status();
      case 'select':
        {
          const index = args.pageId ? this.status().pages.findIndex(p => p.id === args.pageId) : args.index;
          if (!Number.isInteger(index) || !this.browser.pages[index]) throw Error('浏览器标签页已关闭，请重新列出');
          await this.browser.selectPage(index);
        }
        return this.status();
      case 'close-page': {
        const index = this.status().pages.findIndex(p => p.id === args.pageId);
        const page = this.browser.pages[index];
        if (!page) throw Error('浏览器标签页已关闭，请重新列出');
        await page.close();
        return this.status();
      }
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
      case 'capture-list':
        return {
          generation: this.#captureGeneration,
          requests: this.browser.requests.slice(-100).reverse().map((record) => {
            const { id, url, method, status } = summary(record);
            return { id, url, method, status };
          }),
        };
      case 'capture-detail': {
        if (args.generation !== this.#captureGeneration) return null;
        const record = this.browser.findRequest(args.id);
        return record ? desktopCaptureDetail(record, this.browser.net.getInitiator(record)) : null;
      }
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
      case 'debugger-rebind': {
        // Self-healing path: the debugger mirror can drift out of sync with CDP
        // after the CDP session is re-created (page switch, frame switch, host
        // rebind). Tearing the kernel connection down and re-binding gives a
        // clean target instead of leaving callers with contradictory states.
        await this.mcp.stop();
        await this.ensureDebugger(args.allowedRoot || this.root);
        await this.bindTarget();
        return {
          tools: [...FINGERPRINT_TOOLS, ...ANTIDEBUG_TOOLS]
            .map(({ name, description, schema }) => ({ name, description, inputSchema: schema }))
            .concat(this.mcp.tools),
        };
      }
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
