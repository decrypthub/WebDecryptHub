// GitHub 未登录 API 每小时只有 60 次额度，用尽后必须能改走公开网页通道，
// 而不是只报「请求受限，请稍后再试」。这里验证网页通道的解析与选取。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseTags, parseReleaseAssets, releasesFromHtml } from '../src/kernels.mjs';

const repo = 'CloakHQ/cloakbrowser';

const releasesPage = `
<a href="/CloakHQ/CloakBrowser/releases/tag/chromium-v155.0.8059.39.2-pro">v155</a>
<a href="/CloakHQ/CloakBrowser/releases/tag/chromium-v155.0.8059.39.2-pro">重复链接</a>
<a href="/CloakHQ/CloakBrowser/releases/tag/chromium-v146.0.7680.177.5">v146</a>
<a href="/CloakHQ/CloakBrowser/compare/chromium-v155...chromium-v146">比较</a>
`;

const assetsPage = (tag, names) =>
  names.map((n) => `<a href="/CloakHQ/CloakBrowser/releases/download/${tag}/${n}">${n}</a>`).join('\n');

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  body: (async function* () {
    yield Buffer.from(body);
  })(),
});

test('parseReleaseTags 去重并保持页面顺序', () => {
  assert.deepEqual(parseReleaseTags(releasesPage), [
    'chromium-v155.0.8059.39.2-pro',
    'chromium-v146.0.7680.177.5',
  ]);
});

test('parseReleaseAssets 大小写不敏感，并去掉查询串', () => {
  const html =
    '<a href="/CloakHQ/CloakBrowser/releases/download/t/cloakbrowser-windows-x64.zip?download=1">zip</a>' +
    '<a href="/CloakHQ/CloakBrowser/releases/download/t/SHA256SUMS">sums</a>' +
    '<a href="/OtherOrg/repo/releases/download/t/evil.zip">skip</a>';
  const assets = parseReleaseAssets(html, 'cloakhq/cloakbrowser');
  assert.deepEqual(assets.map((a) => a.name), ['cloakbrowser-windows-x64.zip', 'SHA256SUMS']);
  assert.equal(
    assets[0].browser_download_url,
    'https://github.com/CloakHQ/CloakBrowser/releases/download/t/cloakbrowser-windows-x64.zip',
  );
});

test('releasesFromHtml 跳过只有校验文件的版本，且不碰 API', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (!url.includes('/expanded_assets/')) return response(200, releasesPage);
    const tag = decodeURIComponent(url.split('/').pop());
    if (tag.endsWith('-pro')) return response(200, assetsPage(tag, ['SHA256SUMS', 'SHA256SUMS.sig']));
    return response(200, assetsPage(tag, ['cloakbrowser-windows-x64.zip', 'cloakbrowser-linux-x64.tar.gz']));
  };
  const list = await releasesFromHtml(repo, fetcher);
  assert.equal(list.length, 1);
  assert.equal(list[0].tag_name, 'chromium-v146.0.7680.177.5');
  assert.deepEqual(list[0].assets.map((a) => a.name), [
    'cloakbrowser-windows-x64.zip',
    'cloakbrowser-linux-x64.tar.gz',
  ]);
  assert.ok(calls.every((u) => !u.includes('api.github.com')), '网页通道不应请求 API');
});

test('releasesFromHtml 指定 tag 时只读该标签', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response(200, assetsPage('v1', ['cloakbrowser-windows-x64.zip']));
  };
  const list = await releasesFromHtml(repo, fetcher, { tag: 'v1' });
  assert.equal(list[0].tag_name, 'v1');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/releases/expanded_assets/v1'));
});
