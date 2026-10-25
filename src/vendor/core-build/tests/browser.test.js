/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeBrowserResult } from '../src/browser.js';
import { SingleFlight } from '../src/SingleFlight.js';
test('SingleFlight deduplicates a concurrent browser start', async () => {
    const flight = new SingleFlight();
    const deferred = Promise.withResolvers();
    let starts = 0;
    const start = () => {
        starts++;
        return deferred.promise;
    };
    const first = flight.run(start);
    const second = flight.run(start);
    assert.equal(starts, 1);
    assert.equal(first, second);
    deferred.resolve(42);
    assert.deepEqual(await Promise.all([first, second]), [42, 42]);
});
test('SingleFlight clears a failed start so a later call can retry', async () => {
    const flight = new SingleFlight();
    let starts = 0;
    await assert.rejects(flight.run(async () => {
        starts++;
        throw new Error('start failed');
    }), /start failed/);
    const result = await flight.run(async () => {
        starts++;
        return 7;
    });
    assert.equal(result, 7);
    assert.equal(starts, 2);
});
test('closing an external CDP result only disconnects its transport', async () => {
    const calls = [];
    const browser = {
        close: async () => {
            calls.push('browser.close');
        },
        newBrowserCDPSession: async () => {
            calls.push('newBrowserCDPSession');
            throw new Error('must not send Browser.close');
        },
    };
    const context = {
        close: async () => {
            calls.push('context.close');
        },
    };
    await closeBrowserResult({
        browser,
        context,
        closeMode: 'connected-cdp',
    }, 'test shutdown');
    assert.deepEqual(calls, ['browser.close']);
});
test('closing a launched browser closes its owned context and browser', async () => {
    const calls = [];
    await closeBrowserResult({
        browser: { close: async () => calls.push('browser.close') },
        context: { close: async () => calls.push('context.close') },
        closeMode: 'launched',
    }, 'test shutdown');
    assert.deepEqual(calls, ['context.close', 'browser.close']);
});
test('closing a persistent launch closes only its owned context', async () => {
    const calls = [];
    await closeBrowserResult({
        browser: undefined,
        context: { close: async () => calls.push('context.close') },
        closeMode: 'persistent-context',
    }, 'test shutdown');
    assert.deepEqual(calls, ['context.close']);
});
