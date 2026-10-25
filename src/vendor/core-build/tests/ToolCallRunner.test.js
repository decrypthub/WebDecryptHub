/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAbortableOperation } from '../src/ToolCallRunner.js';
test('timeout aborts the operation but waits for its cleanup before settling', async () => {
    const { promise: release, resolve } = Promise.withResolvers();
    let observedAbort = false;
    let callSettled = false;
    const call = runAbortableOperation(async (signal) => {
        signal.addEventListener('abort', () => {
            observedAbort = true;
        });
        await release;
        return 'late result';
    }, { timeoutMs: 5, timeoutMessage: 'operation timed out' }).finally(() => {
        callSettled = true;
    });
    await new Promise(resolveTimer => setTimeout(resolveTimer, 20));
    assert.equal(observedAbort, true, 'the underlying operation must be signalled');
    assert.equal(callSettled, false, 'the caller must keep its mutex until the operation drains');
    resolve();
    await assert.rejects(call, /operation timed out/);
    assert.equal(callSettled, true);
});
test('external cancellation is linked into the operation signal', async () => {
    const controller = new AbortController();
    const call = runAbortableOperation(async (signal) => {
        await new Promise(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
        });
    }, {
        timeoutMs: 1_000,
        timeoutMessage: 'unexpected timeout',
        signal: controller.signal,
    });
    controller.abort(new Error('client cancelled'));
    await assert.rejects(call, /client cancelled/);
});
