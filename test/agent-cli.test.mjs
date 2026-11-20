import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const run = (command, ...args) => execFileAsync(process.execPath,
  ['src/cli.mjs', command, '--json', ...args],
  { cwd: new URL('..', import.meta.url), timeout: 15000, maxBuffer: 2 * 1024 * 1024 });

test('machine-readable status and tool discovery do not open a browser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdh-agent-cli-'));
  try {
    const status = JSON.parse((await run('status', '--browser', 'system', '--data-dir', directory)).stdout);
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.component, 'wdh');
    assert.equal(status.browser.state, 'not-observed');
    assert.deepEqual(status.targets, []);
    const tools = JSON.parse((await run('tools', '--data-dir', directory)).stdout).tools;
    assert.ok(tools.some(tool => tool.name === 'browser_state' && tool.inputSchema));
    assert.ok(!tools.some(tool => ['wdh_control', 'take_screenshot'].includes(tool.name)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('offline debugger discovery returns parameter schemas without an installed kernel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdh-debugger-cli-'));
  try {
    const { stdout } = await run('tools', '--group', 'debugger',
      '--browser', 'custom', '--executable', join(directory, 'missing-browser'),
      '--data-dir', join(directory, 'data'));
    const { tools } = JSON.parse(stdout);
    const screenshot = tools.find(tool => tool.name === 'take_screenshot');
    assert.equal(screenshot?.inputSchema.properties.fullPage?.type, 'boolean');
    assert.ok(screenshot.inputSchema.properties.fullPage.description?.length > 10);
    assert.equal(screenshot.inputSchema.additionalProperties, false);
    const evaluate = tools.find(tool => tool.name === 'evaluate_script');
    assert.ok(evaluate?.inputSchema.required?.includes('function'));
    const initiator = tools.find(tool => tool.name === 'get_request_initiator');
    assert.deepEqual(initiator?.inputSchema.properties.requestId.anyOf?.map(schema => schema.type),
      ['string', 'integer']);
    assert.ok(tools.some(tool => tool.name === 'browser_state'));
    assert.ok(!tools.some(tool => ['wdh_control', 'select_page'].includes(tool.name)));
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
