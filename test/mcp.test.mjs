import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const directory = fileURLToPath(new URL('../', import.meta.url));

async function waitFor(read, message) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  assert.fail(message);
}

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
          [
            'const WDH_SOURCE_PROOF = 42;',
            'window.fixtureRun = function() { window.debugResult = 7; return window.debugResult; };',
            'function firstRequest() { return fetch("/api", {headers: {"X-Fixture-Tab": "first"}}).then(response => response.text()); }',
            'function startFirstRequest() { return firstRequest(); }',
            'function redirectRequest() { return fetch("/redirect").then(response => response.text()); }',
            'startFirstRequest(); redirectRequest();',
          ].join('\n'),
        );
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/redirected' }).end();
        return;
      }
      if (req.url === '/api' || req.url === '/redirected') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(JSON.stringify({ tab: req.headers['x-fixture-tab'] ?? 'redirected' }));
      }
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/blank') return res.end('<h1>New tab</h1>');
      if (req.url === '/second') {
        return res.end('<script>function secondRequest() { return fetch("/api", {headers: {"X-Fixture-Tab": "second"}}).then(response => response.text()); } secondRequest();</script>');
      }
      res.end('<h1>Standalone WDH verified</h1><button onclick="window.fixtureRun()">Test</button><a id="new-tab" href="/blank" target="_blank">New tab</a><script src="/fixture.js"></script>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
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
    const capturedRequest = (pathname, matches) => waitFor(async () => {
      const { requests } = JSON.parse(await call('browser_requests', { url: origin + pathname }));
      return requests.find(request => request.url === origin + pathname && matches(request));
    }, `Missing captured request for ${pathname}`);
    const readDetail = async (id) => JSON.parse(await call('browser_request_detail', { id }));
    const readInitiator = async (requestId) => {
      const result = await client.callTool({ name: 'get_request_initiator', arguments: { requestId } });
      assert.equal(!!result.isError, false, result.content[0]?.text);
      assert.equal(result.structuredContent?.data?.requestId, requestId);
      return result.structuredContent.data.initiator;
    };
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'browser_open'));
    await call('browser_open', { url: origin });
    assert.match(await call('browser_snapshot'), /Standalone WDH verified/);
    const first = await capturedRequest('/api', request => request.bodyState !== null);
    const firstDetail = await readDetail(first.id);
    assert.ok(firstDetail.body, JSON.stringify(firstDetail));
    assert.equal(JSON.parse(firstDetail.body.text).tab, 'first');
    const redirect = await capturedRequest('/redirect', request => request.status === 302);
    const redirected = await capturedRequest('/redirected', request => request.bodyState === 'ok');
    assert.notEqual(redirect.id, redirected.id);
    assert.equal((await readDetail(redirect.id)).redirectURL, origin + '/redirected');
    assert.equal(JSON.parse((await readDetail(redirected.id)).body.text).tab, 'redirected');
    await call('discover_tools', { group: 'debugger' });
    const firstStack = (await readInitiator(first.id)).stack.callFrames;
    assert.deepEqual(firstStack.slice(0, 2).map(frame => frame.functionName), ['firstRequest', 'startFirstRequest']);
    assert.equal((await readInitiator(redirect.id)).stack.callFrames[0].functionName, 'redirectRequest');
    const { tools } = await client.listTools();
    assert.equal(tools.find(tool => tool.name === 'take_screenshot')?.inputSchema.properties.fullPage?.type, 'boolean');
    const screenshot = await client.callTool({ name: 'take_screenshot', arguments: {} });
    const image = screenshot.content.find(block => block.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    const png = Buffer.from(image.data, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(screenshot.structuredContent?.data?.byteLength, png.length);
    assert.equal(screenshot.structuredContent?.data?.attached, true);
    const evaluation = await client.callTool({
      name: 'evaluate_script',
      arguments: { function: '() => "x".repeat(12000)', confirm: true },
    });
    assert.equal(evaluation.structuredContent?.data?.truncated, true);
    assert.match(evaluation.content[0].text, /inline output is truncated/);
    const unknown = await client.callTool({
      name: 'take_screenshot',
      arguments: { fullpage: true },
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /did you mean "fullPage"/);
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
    assert.equal(fileDenied.structuredContent?.ok, false);

    await call('browser_click', { selector: '#new-tab' });
    const secondTab = await waitFor(async () => JSON.parse(await call('browser_tabs'))
      .find(tab => tab.url === origin + '/blank'), 'Missing second tab');
    await call('browser_select', { index: secondTab.index });
    await call('list_network_requests', { urlFilter: '/api' });
    await call('browser_open', { url: origin + '/second' });
    const second = await capturedRequest('/api', request => request.id !== first.id && request.bodyState === 'ok');
    assert.equal(JSON.parse((await readDetail(second.id)).body.text).tab, 'second');
    assert.equal((await readInitiator(second.id)).stack.callFrames[0].functionName, 'secondRequest');
    assert.equal(JSON.parse((await readDetail(first.id)).body.text).tab, 'first');
    assert.deepEqual((await readInitiator(first.id)).stack.callFrames, firstStack);

    const legacy = await waitFor(async () => {
      const result = await client.callTool({
        name: 'list_network_requests',
        arguments: { urlFilter: '/api' },
      });
      assert.equal(!!result.isError, false, result.content[0]?.text);
      return result.structuredContent.data.requests.find(request => request.url === origin + '/api');
    }, 'Missing debugger request for /api');
    assert.ok(Number.isInteger(legacy.reqid));
    assert.equal((await readInitiator(legacy.reqid)).stack.callFrames[0].functionName, 'secondRequest');

    await call('browser_open', { url: origin + '/blank' });
    assert.equal((await readInitiator(second.id)).stack.callFrames[0].functionName, 'secondRequest');
    const missingRequest = await client.callTool({
      name: 'get_request_initiator',
      arguments: { requestId: 'r999999' },
    });
    assert.equal(missingRequest.isError, true);
    assert.match(missingRequest.content[0].text, /browser_requests/);
  },
);
