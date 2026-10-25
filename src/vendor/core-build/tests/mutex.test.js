/**
 * @license
 * Copyright 2025 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mutex } from '../src/Mutex.js';
test('mutex acquire can time out while another caller holds the lock', async () => {
    const mutex = new Mutex();
    const guard = await mutex.acquire();
    await assert.rejects(() => mutex.acquire({ timeoutMs: 1 }), /Timed out waiting for another tool call to finish/);
    guard.dispose();
    const nextGuard = await mutex.acquire({ timeoutMs: 100 });
    nextGuard.dispose();
});
test('mutex removes a cancelled waiter without disturbing FIFO handoff', async () => {
    const mutex = new Mutex();
    const guard = await mutex.acquire();
    const controller = new AbortController();
    const cancelled = mutex.acquire({ signal: controller.signal });
    const next = mutex.acquire();
    controller.abort(new Error('client cancelled'));
    await assert.rejects(cancelled, /client cancelled/);
    guard.dispose();
    const nextGuard = await next;
    nextGuard.dispose();
});
