// node --test sidecar/test/embed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { wantEmbed } from '../settings.mjs';
import { screencastSize, clampDpr, insetFrom } from '../browser.mjs';

test('wantEmbed per platform', () => {
  const s = { headless: false, embedMode: 'auto' };
  assert.equal(wantEmbed(s, 'win32', {}), true);
  assert.equal(wantEmbed(s, 'linux', { DISPLAY: ':0' }), true);
  assert.equal(wantEmbed(s, 'linux', {}), false);
  assert.equal(wantEmbed(s, 'linux', { DISPLAY: ':0', JSRA_NO_EMBED: '1' }), false);
  assert.equal(wantEmbed(s, 'darwin', { DISPLAY: ':0' }), false);
  assert.equal(wantEmbed({ ...s, embedMode: 'screencast' }, 'win32', {}), false);
  assert.equal(wantEmbed({ ...s, headless: true }, 'win32', {}), false);
});
test('screencast uses device pixels', () => {
  assert.deepEqual(screencastSize({ width: 800, height: 600 }, 2), { maxWidth: 1600, maxHeight: 1200 });
  assert.deepEqual(screencastSize({ width: 800, height: 600 }, 1.25), { maxWidth: 1000, maxHeight: 750 });
  assert.deepEqual(screencastSize({ width: 800, height: 600 }, undefined), { maxWidth: 800, maxHeight: 600 });
  assert.equal(clampDpr(9), 4); assert.equal(clampDpr(0.5), 1); assert.equal(clampDpr('x'), 1);
});
test('insetFrom', () => {
  assert.deepEqual(insetFrom({ ow: 1016, oh: 900, iw: 1000, ih: 812 }), { top: 80, left: 8, right: 8, bottom: 8 });
  assert.deepEqual(insetFrom({ ow: 1000, oh: 900, iw: 1000, ih: 812 }), { top: 88, left: 0, right: 0, bottom: 0 });
});
