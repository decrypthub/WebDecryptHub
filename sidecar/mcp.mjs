import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
function selfEntry(){ const a=process.argv[1]; return (a && /\.(mjs|cjs|js)$/.test(a)) ? [a] : []; }

export class McpBridge {
  constructor(log) { this.client = null; this.tools = []; this.log = log || (() => {}); }

  async start({ cdpPort, allowedRoot }) {
    await this.stop();
    this.opts = { cdpPort, allowedRoot }; this.wanted = true;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...selfEntry(), '--browserUrl', `http://127.0.0.1:${cdpPort}`, '--allowedRoots', allowedRoot],
      env: { ...process.env, JSRA_MODE: 'mcp-core' },
      cwd: allowedRoot, // 让模型给出的相对路径（如 save_script_source 的 filePath）落在允许目录内
      stderr: 'pipe',
    });
    transport.stderr?.on('data', d => this.log('[core] ' + String(d).trim()));
    const client = new Client({ name: 'js-reverse-agent', version: '0.1.0' });
    await client.connect(transport);
    this.client = client;
    // 内核进程意外退出时标记断开，下次调用自动重启
    transport.onclose = () => { if (this.client === client) { this.client = null; this.log('[core] 内核连接已断开，将在下次调用时自动重启'); } };
    const res = await client.listTools();
    this.tools = res.tools;
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
  async call(name, args, signal) {
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
        if (/not connected|connection closed/i.test(e.message || '') && attempt < 1 && !signal?.aborted) { this.client = null; await this.start(this.opts); continue; }
        if (/timed out/i.test(e.message || '') && !signal?.aborted)
          return { text: `[工具超时] ${name} 在 130s 内无响应（浏览器内核可能正忙于页面/调试器初始化）。建议：稍后重试，或改用 list_network_requests / search_in_sources / evaluate_script 等其它工具。`, isError: true };
        throw e;
      }
      const text = (res.content || []).map(c => c.type === 'text' ? c.text : c.type === 'image' ? `[图片 ${c.mimeType}]` : '').join('\n');
      if (res.isError && /waiting for another tool call/i.test(text) && attempt < 2 && !signal?.aborted) { await new Promise(r => setTimeout(r, 15000)); continue; }
      return { text: (res.isError ? '[错误] ' : '') + text, isError: !!res.isError };
    }
  }
  async stop() { this.wanted = false; const c = this.client; this.client = null; this.tools = []; if (c) await c.close().catch(() => {}); }
}
