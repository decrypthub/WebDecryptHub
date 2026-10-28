import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebRuntime } from '../src/service.mjs';
test('desktop page IDs survive reordering, select brings the page forward, and close rejects stale IDs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wdh-tabs-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  const runtime = new WebRuntime({ root: directory, dataDir: directory, desktop: true });
  const seen = [], makePage = name => ({ url: () => 'https://' + name + '.test', bringToFront: async () => seen.push(name), close: async () => { runtime.browser.pages = runtime.browser.pages.filter(p => p !== pages[name]); } });
  const pages = { a: makePage('a'), b: makePage('b') }; runtime.browser.pages = [pages.a, pages.b]; runtime.browser.activePage = pages.a;
  const a = runtime.status().pages[0].id, b = runtime.status().pages[1].id;
  assert.equal((await runtime.control('hello')).capabilities.pageTabs, true);
  runtime.browser.pages.reverse(); await runtime.control('select', { pageId: a, index: 0 }); assert.deepEqual(seen, ['a']); assert.equal(runtime.browser.activePage, pages.a);
  await runtime.control('close-page', { pageId: b }); assert.equal(runtime.browser.pages.includes(pages.b), false);
  await assert.rejects(runtime.control('close-page', { pageId: b }), /已关闭/);
  await assert.rejects(runtime.control('select', { pageId: b }), /已关闭/);
});
