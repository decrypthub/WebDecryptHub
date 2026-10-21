import test from 'node:test';
import assert from 'node:assert/strict';
import { isLaunchedChrome, readProcessIdentity, sameExecutable } from '../proctree.mjs';
import { BrowserManager, CHROME_CLOSE_TIMEOUT_MS, closeLaunchedBrowser } from '../browser.mjs';

const OURS = 'C:\\Users\\a\\AppData\\Local\\WebDecryptHub\\chrome-for-testing\\chrome-win64\\chrome.exe';
const PROFILE = 'C:\\Users\\a\\AppData\\Local\\WebDecryptHub\\profiles\\s1';
const launched = (commandLine) => ({ image: OURS, commandLine });

test('default browser close timeout is 8 seconds', () => {
  assert.equal(CHROME_CLOSE_TIMEOUT_MS, 8000);
});

test('only the launched chrome image matches', () => {
  assert.equal(sameExecutable(OURS, OURS, 'win32'), true);
  assert.equal(sameExecutable(OURS.toLowerCase().replace(/\\/g, '/'), OURS, 'win32'), true);
  assert.equal(sameExecutable('\\\\?\\' + OURS, OURS, 'win32'), true);
  assert.equal(sameExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', OURS, 'win32'), false);
  assert.equal(sameExecutable('C:\\Program Files\\nodejs\\node.exe', OURS, 'win32'), false);
  assert.equal(sameExecutable('', OURS, 'win32'), false);
  assert.equal(sameExecutable(OURS, '', 'win32'), false);
});

test('hung chrome must also be the profile this app launched', () => {
  const ours = `--user-data-dir=${PROFILE} --remote-debugging-port=0`;
  assert.equal(isLaunchedChrome(launched(ours), { exe: OURS, profileDir: PROFILE, platform: 'win32' }), true);
  assert.equal(isLaunchedChrome(launched(ours.replace(/\\/g, '/')), { exe: OURS, profileDir: PROFILE, platform: 'win32' }), true);
  assert.equal(isLaunchedChrome(
    { image: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', commandLine: '--user-data-dir=C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data' },
    { exe: OURS, profileDir: PROFILE, platform: 'win32' },
  ), false);
  assert.equal(isLaunchedChrome(
    { image: 'C:\\Program Files\\nodejs\\node.exe', commandLine: 'node server.js' },
    { exe: OURS, profileDir: PROFILE, platform: 'win32' },
  ), false);
  assert.equal(isLaunchedChrome(launched('--user-data-dir=C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data'), { exe: OURS, profileDir: PROFILE, platform: 'win32' }), false);
  assert.equal(isLaunchedChrome({ image: OURS, commandLine: '' }, { exe: OURS, profileDir: PROFILE, platform: 'win32' }), false);
});

test('a finished close never kills, even if that pid now looks like our chrome', async () => {
  let reads = 0;
  let killed = 0;
  const outcome = await closeLaunchedBrowser({ async close() {} }, {
    chromePid: 4242,
    chromeExe: OURS,
    profileDir: PROFILE,
    timeoutMs: 200,
    platform: 'win32',
    readIdentity: () => { reads++; return launched(`--user-data-dir=${PROFILE}`); },
    kill: () => { killed++; },
  });
  assert.equal(outcome.reason, 'closed');
  assert.equal(reads, 0);
  assert.equal(killed, 0);
});

test('a close that errors is finished and does not kill the pid', async () => {
  let killed = 0;
  const outcome = await closeLaunchedBrowser({ close: async () => { throw new Error('already gone'); } }, {
    chromePid: 7,
    chromeExe: OURS,
    profileDir: PROFILE,
    timeoutMs: 200,
    platform: 'win32',
    readIdentity: () => launched(`--user-data-dir=${PROFILE}`),
    kill: () => { killed++; },
  });
  assert.equal(outcome.reason, 'closed');
  assert.equal(killed, 0);
});

test('a hung close kills only when the pid is still our chrome', async () => {
  const seen = [];
  const outcome = await closeLaunchedBrowser({ close: () => new Promise(() => {}) }, {
    chromePid: 99,
    chromeExe: OURS,
    profileDir: PROFILE,
    timeoutMs: 20,
    platform: 'win32',
    readIdentity: () => launched(`--user-data-dir=${PROFILE}`),
    kill: (pid) => { seen.push(pid); },
  });
  assert.equal(outcome.reason, 'hung');
  assert.deepEqual(seen, [99]);
});

test('a hung close does not kill a reused pid', async () => {
  const strangers = [
    { image: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', commandLine: '--user-data-dir=C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data' },
    { image: 'C:\\Program Files\\nodejs\\node.exe', commandLine: 'node.exe server.js' },
    { image: '', commandLine: '' },
  ];
  for (const identity of strangers) {
    let killed = 0;
    const outcome = await closeLaunchedBrowser({ close: () => new Promise(() => {}) }, {
      chromePid: 99,
      chromeExe: OURS,
      profileDir: PROFILE,
      timeoutMs: 15,
      platform: 'win32',
      readIdentity: () => identity,
      kill: () => { killed++; },
    });
    assert.equal(outcome.reason, 'identity-mismatch', identity.image || '(empty)');
    assert.equal(killed, 0);
  }
});

test('BrowserManager.close uses the same guard', async () => {
  const hung = new BrowserManager();
  const killed = [];
  hung.chromePid = 55;
  hung.chromeExe = OURS;
  hung.profileDir = PROFILE;
  hung.chromeCloseTimeoutMs = 20;
  hung.killBrowserTree = (pid) => { killed.push(pid); };
  hung.readBrowserIdentity = () => launched(`--user-data-dir=${PROFILE}`);
  hung.context = { close: () => new Promise(() => {}) };
  await hung.close();
  assert.deepEqual(killed, [55]);
  assert.equal(hung.chromePid, null);

  const reused = new BrowserManager();
  const logs = [];
  const emit = reused.emit.bind(reused);
  reused.emit = (ch, payload) => { if (ch === 'log') logs.push(payload); return emit(ch, payload); };
  let again = 0;
  reused.chromePid = 56;
  reused.chromeExe = OURS;
  reused.profileDir = PROFILE;
  reused.chromeCloseTimeoutMs = 15;
  reused.killBrowserTree = () => { again++; };
  reused.readBrowserIdentity = () => ({ image: 'C:\\Program Files\\nodejs\\node.exe', commandLine: 'node' });
  reused.context = { close: () => new Promise(() => {}) };
  await reused.close();
  assert.equal(again, 0);
  assert.equal(logs.length, 1);
});

test('linux can read this process image', () => {
  if (process.platform !== 'linux') return;
  const identity = readProcessIdentity(process.pid);
  assert.equal(sameExecutable(identity.image, process.execPath), true);
  assert.match(identity.commandLine, /node/);
});
