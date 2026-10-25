import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const directory = fileURLToPath(new URL('../', import.meta.url));
test(
  'standalone MCP: browser, capture, source debugger and workspace boundary',
  { timeout: 120000 },
  async (t) => {
    const temp = path.join(directory, '.tmp');
    fs.mkdirSync(temp, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(temp, 'mcp-'));
    const server = http.createServer((req, res) => {
      if (req.url === '/fixture.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(
          'const WDH_SOURCE_PROOF = 42; window.fixtureRun = function() { window.debugResult = 7; return window.debugResult; }; fetch("/api");',
        );
      }
      res.setHeader('Content-Type', req.url === '/api' ? 'application/json' : 'text/html');
      res.end(
        req.url === '/api'
          ? '{"verified":true}'
          : '<h1>Standalone WDH verified</h1><button onclick="window.fixtureRun()">Test</button><script src="/fixture.js"></script>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new Client({ name: 'wdh-independent-test', version: '1' }),
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(directory, 'src/cli.mjs'),
          'mcp',
          '--headless',
          '--browser',
          process.env.WDH_TEST_EXECUTABLE ? 'custom' : 'system',
          ...(process.env.WDH_TEST_EXECUTABLE ? ['--executable', process.env.WDH_TEST_EXECUTABLE] : []),
          '--root',
          fixture,
          '--data-dir',
          path.join(fixture, 'data'),
        ],
        cwd: directory,
        stderr: 'pipe',
      });
    let logs = '';
    transport.stderr.on('data', (data) => (logs += String(data)));
    t.after(async () => {
      await client.close().catch(() => {});
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    await client.connect(transport);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      assert.equal(!!result.isError, false, text + '\n' + logs);
      return text;
    };
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'browser_open'));
    await call('browser_open', { url: `http://127.0.0.1:${server.address().port}` });
    assert.match(await call('browser_snapshot'), /Standalone WDH verified/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(await call('browser_requests'), /\/api/);
    await call('discover_tools', { group: 'debugger' });
    assert.match(await call('search_in_sources', { query: 'WDH_SOURCE_PROOF' }), /WDH_SOURCE_PROOF/);
    await call('set_breakpoint_on_text', { text: 'window.debugResult = 7', urlFilter: '/fixture.js' });
    assert.match(await call('browser_click', { selector: 'button' }), /断点|暂停/);
    assert.match(await call('get_paused_info', { includeScopes: true }), /Execution Paused|Call Stack/);
    await call('step', { direction: 'over' });
    await call('pause_or_resume', { action: 'resume' });
    assert.match(await call('browser_snapshot'), /Standalone WDH verified/);
    const stale = await client.callTool({
      name: 'browser_click',
      arguments: { selector: 'button' },
      _meta: { 'decrypthub/target': { id: 'stale', url: 'http://invalid' } },
    });
    assert.equal(stale.isError, true);
    const denied = await client.callTool({ name: 'wdh_control', arguments: { action: 'hello' } });
    assert.equal(denied.isError, true);
    const fileDenied = await client.callTool({
      name: 'save_script_source',
      arguments: { scriptId: 'not-real', filePath: '../escape.js' },
    });
    assert.equal(fileDenied.isError, true);
  },
);
