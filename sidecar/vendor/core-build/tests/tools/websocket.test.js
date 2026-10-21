/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolError } from '../../src/ToolError.js';
import { getWebSocketMessages } from '../../src/tools/websocket.js';
test('WebSocket traffic summary cache is read and written with frame version', async () => {
    const cacheReads = [];
    const cacheWrites = [];
    const lines = [];
    const ws = {
        connection: {
            requestId: 'ws-1',
            url: 'wss://example.test/socket',
            status: 'open',
            createdAt: 0,
        },
        version: 7,
        frames: [
            {
                index: 11,
                requestId: 'ws-1',
                direction: 'received',
                timestamp: 1,
                opcode: 1,
                payloadData: '{"ok":true}',
                payloadBytes: 11,
            },
        ],
    };
    await getWebSocketMessages.handler({
        params: {
            wsid: 3,
            analyze: false,
            groupId: 'A',
            pageSize: 10,
            show_content: false,
            includePreservedConnections: false,
        },
    }, {
        appendResponseLine: (line) => lines.push(line),
        setStructuredContent: () => undefined,
    }, {
        getWebSocketById: () => ws,
        getCachedTrafficSummary: (wsid, version) => {
            cacheReads.push([wsid, version]);
            return undefined;
        },
        cacheTrafficSummary: (wsid, version) => {
            cacheWrites.push([wsid, version]);
        },
    });
    assert.deepEqual(cacheReads, [[3, 7]]);
    assert.deepEqual(cacheWrites, [[3, 7]]);
    assert.match(lines.join('\n'), /Group A Messages/);
});
test('WebSocket message pagination rejects an out-of-range empty page', async () => {
    await assert.rejects(getWebSocketMessages.handler({
        params: {
            wsid: 3,
            analyze: false,
            pageIdx: 1,
            pageSize: 10,
            show_content: false,
            includePreservedConnections: false,
        },
    }, { appendResponseLine: () => undefined }, {
        getWebSocketById: () => ({
            connection: {
                requestId: 'ws-1',
                url: 'wss://example.test/socket',
                status: 'open',
                createdAt: 0,
            },
            version: 1,
            frames: [],
        }),
    }), (error) => error instanceof ToolError && error.code === 'INVALID_ARGUMENT');
});
test('WebSocket frame eviction reports a stable not-found error', async () => {
    await assert.rejects(getWebSocketMessages.handler({
        params: {
            wsid: 3,
            analyze: false,
            frameIndex: 99,
            pageSize: 10,
            show_content: false,
            includePreservedConnections: false,
        },
    }, { appendResponseLine: () => undefined }, {
        getWebSocketById: () => ({
            connection: {
                requestId: 'ws-1',
                url: 'wss://example.test/socket',
                status: 'open',
                createdAt: 0,
            },
            version: 1,
            frames: [],
        }),
    }), (error) => error instanceof ToolError && error.code === 'NOT_FOUND');
});
