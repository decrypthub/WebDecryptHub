// 连接调试器或读取它的工具列表时，才加载 MCP 客户端 SDK。
import { childEnv } from './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Navigation and interaction share BrowserManager's selected page. No second tab authority.
const HIDDEN = new Set(['select_page', 'new_page', 'navigate_page', 'click_element', 'list_console_messages']);

async function connectCore({ cdpPort, allowedRoot, runtimeDir, log }) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const args = [fileURLToPath(new URL('./core-entry.mjs', import.meta.url))];
  if (cdpPort !== undefined) args.push('--browserUrl', `http://127.0.0.1:${cdpPort}`);
  args.push('--allowedRoots', allowedRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnv(process.env, {
      JSRA_MODE: 'mcp-core',
      ...(process.env.JSRA_RES_DIR ? { JSRA_RES_DIR: process.env.JSRA_RES_DIR } : {}),
      ...(runtimeDir ? { TEMP: runtimeDir, TMP: runtimeDir, HOME: runtimeDir, USERPROFILE: runtimeDir, APPDATA: runtimeDir } : {}),
    }),
    cwd: allowedRoot, // 相对输出路径从工作区解析
    stderr: 'pipe',
  });
  transport.stderr?.on('data', d => log?.('[core] ' + String(d).trim()));
  const client = new Client({ name: 'js-reverse-agent', version: '0.1.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close().catch(() => {});
    throw e;
  }
  return { client, transport };
}

async function exposedTools(client) {
  const { tools } = await client.listTools();
  return tools.filter(t => !HIDDEN.has(t.name)).map(({ outputSchema, ...tool }) => tool);
}

export async function listDebuggerTools() {
  // Register tools and read their schemas without asking the core for a browser.
  const { client } = await connectCore({ allowedRoot: process.cwd() });
  try {
    return await exposedTools(client);
  } finally {
    await client.close();
  }
}

function resultText(result) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

export class McpBridge {
  constructor(log) { this.client = null; this.tools = []; this.log = log || (() => {}); }

  async start({ cdpPort, allowedRoot, runtimeDir }) {
    await this.stop();
    this.opts = { cdpPort, allowedRoot, runtimeDir }; this.wanted = true;
    const generation = this.generation;
    runtimeDir ||= path.join(allowedRoot, '.browser-runtime'); fs.mkdirSync(runtimeDir, { recursive: true });
    const { client, transport } = await connectCore({ cdpPort, allowedRoot, runtimeDir, log: this.log });
    if (!this.wanted || generation !== this.generation) { await client.close().catch(() => {}); throw new Error('调试器启动已取消'); }
    this.client = client;
    // 内核进程意外退出时标记断开，下次调用自动重启
    transport.onclose = () => { if (this.client === client) { this.client = null; this.log('[core] 内核连接已断开，将在下次调用时自动重启'); } };
    let tools; try { tools = await exposedTools(client); } catch (e) { await this.stop(); throw e; }
    if (!this.wanted || generation !== this.generation) { await client.close().catch(() => {}); throw new Error('调试器启动已取消'); }
    this.tools = tools;
    await this.warmup();
    return this.tools;
  }

  // 预热：在页面还是空白时就让内核建立 CDP 连接（connectOverCDP 在重页面上可能 >30s 超时），
  // 同时让内核从导航开始就记录网络请求与发起栈。
  async warmup() {
    if (!this.client) return;
    const t = Date.now();
    try {
      await this.client.callTool({ name: 'select_page', arguments: {} }, undefined, { timeout: 90000 });
      this.log(`[core] 内核已连接浏览器（${Date.now() - t}ms）`);
    } catch (e) { this.log('[core] 预热失败（不影响使用，首次调用时会重试）：' + e.message); }
  }
  has(name) { return this.tools.some(t => t.name === name); }
  async selectTarget(targetId, signal) {
    if (!this.client) throw new Error('调试器连接已断开，请重新 discover_tools(debugger)');
    const res = await this.client.callTool({ name: 'select_page', arguments: { targetId } }, undefined, { signal, timeout: 20000 });
    if (res.isError) throw new Error(resultText(res));
  }
  async call(name, args, signal) {
    // Local browser tools consume only the debugger's text.
    const result = await this.callTool(name, args, signal);
    return { text: (result.isError ? '[错误] ' : '') + resultText(result), isError: !!result.isError };
  }
  async callTool(name, args, signal) {
    if (!this.client) {
      if (!this.wanted || !this.opts) throw new Error('MCP 未启动，请先打开浏览器');
      this.log('[core] 正在重启浏览器分析内核…');
      await this.start(this.opts);
    }
    // 内核对每个工具串行加锁；上一次调用若在内核侧仍未结束，会返回"waiting for another tool call"。
    // 这里自动等待重试，并客户端超时 130s（core 单工具 90s），避免一次卡死拖垮后续所有调用。
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.client.callTool({ name, arguments: args || {} }, undefined, { signal, timeout: 130000 });
      } catch (e) {
        // Never retry a mutation after losing its acknowledgement.
        if (/not connected|connection closed/i.test(e.message || '')) { this.client = null; throw new Error('调试连接已断开，操作结果未知；请重新检查页面后再操作。'); }
        if (/timed out/i.test(e.message || '') && !signal?.aborted) {
          return {
            content: [{ type: 'text', text: `[工具超时] ${name} 在 130s 内无响应（浏览器内核可能正忙于页面/调试器初始化）。建议：稍后重试，或改用 list_network_requests / search_in_sources / evaluate_script 等其它工具。` }],
            isError: true,
          };
        }
        throw e;
      }
      if (res.isError && attempt < 2 && !signal?.aborted && /waiting for another tool call/i.test(resultText(res))) {
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      return res;
    }
  }
  async stop() { this.generation = (this.generation || 0) + 1; this.wanted = false; const c = this.client; this.client = null; this.tools = []; if (c) await c.close().catch(() => {}); }
}
