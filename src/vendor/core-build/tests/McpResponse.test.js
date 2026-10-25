/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpResponse } from '../src/McpResponse.js';
test('paginates Set-Cookie flow like every other list output', async () => {
    const first = createCookieRequest({
        url: 'https://example.test/first',
        setCookieHeaders: ['_abck=first; Path=/'],
    });
    const unrelated = createCookieRequest({
        url: 'https://example.test/other',
        setCookieHeaders: ['sid=abc; Path=/'],
    });
    const latest = createCookieRequest({
        url: 'https://example.test/latest',
        setCookieHeaders: ['_abck=latest; Path=/'],
    });
    const ids = new Map([
        [first, 23],
        [unrelated, 24],
        [latest, 88],
    ]);
    const context = {
        getNetworkRequests: () => [first, unrelated, latest],
        getNetworkRequestStableId: (request) => ids.get(request) ?? 0,
    };
    const response = new McpResponse();
    response.setIncludeNetworkRequests(true, {
        cookieName: '_abck',
        pageSize: 1,
    });
    const result = await response.format('list_network_requests', context, {
        bodies: {},
        consoleData: undefined,
        consoleListData: undefined,
    });
    assert.equal(result[0].type, 'text');
    const text = result[0].text;
    assert.match(text, /## Set-Cookie flow for _abck/);
    assert.match(text, /Matched response Set-Cookie updates, oldest first\./);
    assert.match(text, /Showing 1-1 of 2/);
    assert.match(text, /\[23\] 200 GET https:\/\/example\.test\/first/);
    assert.match(text, /set-cookie: _abck=first/);
    assert.doesNotMatch(text, /sid=abc/);
    assert.doesNotMatch(text, /https:\/\/example\.test\/latest/);
});
test('network listing does not reverse collector storage in place', async () => {
    const first = createCookieRequest({
        url: 'https://example.test/first',
        setCookieHeaders: [],
    });
    const latest = createCookieRequest({
        url: 'https://example.test/latest',
        setCookieHeaders: [],
    });
    const stored = [first, latest];
    const ids = new Map([
        [first, 1],
        [latest, 2],
    ]);
    const context = {
        getNetworkRequests: () => stored,
        getNetworkRequestStableId: (request) => ids.get(request) ?? 0,
    };
    const render = async () => {
        const response = new McpResponse();
        response.setIncludeNetworkRequests(true);
        const [content] = await response.format('list_network_requests', context, {
            bodies: {},
            consoleData: undefined,
            consoleListData: undefined,
        });
        assert.equal(content.type, 'text');
        return content.text;
    };
    const firstRender = await render();
    const secondRender = await render();
    for (const text of [firstRender, secondRender]) {
        assert.ok(text.indexOf('/latest') < text.indexOf('/first'));
    }
    assert.deepEqual(stored, [first, latest]);
});
test('an empty list still returns pagination and rejects later pages', async () => {
    const context = {
        getNetworkRequests: () => [],
    };
    const response = new McpResponse();
    response.setIncludeNetworkRequests(true, { pageIdx: 0 });
    await response.format('list_network_requests', context, {
        bodies: {},
        consoleData: undefined,
        consoleListData: undefined,
    });
    assert.deepEqual(response.createStructuredContent('list_network_requests'), {
        ok: true,
        tool: 'list_network_requests',
        summary: 'list_network_requests completed',
        data: {
            requests: [],
            pagination: {
                pageIdx: 0,
                pageSize: 20,
                totalItems: 0,
                totalPages: 1,
                hasNextPage: false,
                hasPreviousPage: false,
            },
        },
    });
    const invalid = new McpResponse();
    invalid.setIncludeNetworkRequests(true, { pageIdx: 1 });
    await assert.rejects(invalid.format('list_network_requests', context, {
        bodies: {},
        consoleData: undefined,
        consoleListData: undefined,
    }), /pageIdx 1 is outside/);
});
function createCookieRequest(opts) {
    const responseHeaders = opts.setCookieHeaders.map(value => ({
        name: 'Set-Cookie',
        value,
    }));
    const response = {
        headers: () => ({}),
        headersArray: async () => responseHeaders,
        status: () => 200,
        statusText: () => 'OK',
    };
    return {
        failure: () => null,
        headers: () => ({}),
        headersArray: async () => [],
        method: () => 'GET',
        resourceType: () => 'xhr',
        response: async () => response,
        timing: () => ({
            startTime: 0,
            domainLookupStart: -1,
            domainLookupEnd: -1,
            connectStart: -1,
            secureConnectionStart: -1,
            connectEnd: -1,
            requestStart: 1,
            responseStart: 2,
            responseEnd: 3,
        }),
        url: () => opts.url,
    };
}
