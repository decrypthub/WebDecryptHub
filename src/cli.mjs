#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebRuntime, API_VERSION, VERSION } from './service.mjs';
import { ensurePatchrightResources } from './runtime.mjs';
import * as kernels from './kernels.mjs';
import * as chrome from './chrome.mjs';
const argv = process.argv.slice(2),
  command = argv[0] || 'help';
const value = (key, fallback) => {
  const index = argv.indexOf('--' + key);
  return index >= 0 ? argv[index + 1] : fallback;
};
const dataDir = path.resolve(
  value(
    'data-dir',
    path.join(
      process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'WebDecryptHubRuntime',
    ),
  ),
);
const kernelDir = path.resolve(value('kernel-dir', dataDir));
fs.mkdirSync(dataDir, { recursive: true });
if (command === '--version' || command === 'version') {
  console.log('WebDecryptHub ' + VERSION);
} else if (command === 'kernel' && argv[1] === 'install') {
  const kind = argv[2] || 'cloak';
  if (!['cloak', 'bundled'].includes(kind)) throw Error('Choose cloak or bundled');
  if (kind === 'cloak')
    console.error(
      'CloakBrowser binary terms: https://github.com/CloakHQ/cloakbrowser/blob/main/BINARY-LICENSE.md',
    );
  const result =
    kind === 'bundled'
      ? await chrome.downloadCft(kernelDir, (p) => console.error(JSON.stringify(p)))
      : await kernels.downloadGithub(
          kernelDir,
          { repository: 'CloakHQ/cloakbrowser', tag: value('tag', '') },
          (p) => console.error(JSON.stringify(p)),
        );
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'doctor') {
  console.log(
    JSON.stringify(
      {
        version: VERSION,
        apiVersion: API_VERSION,
        kernelDir,
        system: chrome.findChrome(null),
        cloak: kernels.installedKernel(kernelDir, 'cloak'),
      },
      null,
      2,
    ),
  );
} else if (command === 'mcp') {
  await ensurePatchrightResources();
  const runtime = new WebRuntime({
    root: value('root', process.cwd()),
    dataDir,
    kernelDir,
    desktop: argv.includes('--desktop'),
    options: {
      kernel: value('browser', 'cloak'),
      chromePath: value('executable', ''),
      headless: argv.includes('--headless'),
    },
  });
  const server = new Server(
    { name: 'WebDecryptHub', version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );
  const transport = new StdioServerTransport();
  let subscribed = false;
  runtime.listeners.add((channel, payload) => {
    if (subscribed)
      server
        .notification({ method: 'notifications/wdh/event', params: { channel, payload } })
        .catch(() => {});
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.tools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name === 'wdh_control') {
        if (!runtime.desktop) throw Error('Owning desktop only');
        const { action, args } = request.params.arguments || {};
        if (action === 'hello') subscribed = true;
        const result = await runtime.control(action, args);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
      }
      const result = await runtime.call(
        request.params.name,
        request.params.arguments || {},
        request.params._meta?.['decrypthub/target'],
        extra.signal,
      );
      if (request.params.name === 'discover_tools')
        await server.notification({ method: 'notifications/tools/list_changed' });
      return {
        content: [
          {
            type: 'text',
            text: typeof result?.text === 'string' ? result.text : JSON.stringify(result ?? null),
          },
        ],
        isError: !!result?.isError,
      };
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  });
  await server.connect(transport);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('end', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  const parent = process.ppid,
    watch = setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch (e) {
        if (e.code !== 'EPERM') close();
      }
    }, 3000);
  watch.unref();
} else
  console.log(
    'WebDecryptHub\n  wdh mcp [--root folder] [--browser cloak|system] [--headless]\n  wdh kernel install cloak|bundled [--tag version]\n  wdh doctor\nBrowser binaries are downloaded separately from their official source.',
  );
