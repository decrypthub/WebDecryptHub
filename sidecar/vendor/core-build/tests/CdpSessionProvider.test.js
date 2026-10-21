/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdpSessionProvider } from '../src/CdpSessionProvider.js';
function fakeSession(detachCalls, name) {
    return {
        detach: async () => {
            detachCalls.push(name);
        },
    };
}
test('deduplicates concurrent page session creation and caches the result', async () => {
    const created = Promise.withResolvers();
    let creationCalls = 0;
    const page = {
        context: () => undefined,
        mainFrame: () => undefined,
    };
    const provider = new CdpSessionProvider({
        newCDPSession: async () => {
            creationCalls++;
            return created.promise;
        },
    });
    const first = provider.getSession(page);
    const second = provider.getSession(page);
    assert.equal(first, second, 'callers must share the pending Promise');
    assert.equal(creationCalls, 1);
    const session = fakeSession([], 'page');
    created.resolve(session);
    assert.deepEqual(await Promise.all([first, second]), [session, session]);
    assert.equal(await provider.getSession(page), session);
    assert.equal(creationCalls, 1);
});
test('deduplicates frame sessions independently from page sessions', async () => {
    const created = Promise.withResolvers();
    let creationCalls = 0;
    const frame = { page: () => undefined };
    const provider = new CdpSessionProvider({
        newCDPSession: async () => {
            creationCalls++;
            return created.promise;
        },
    });
    const first = provider.getSession(frame);
    const second = provider.getSession(frame);
    assert.equal(first, second);
    assert.equal(creationCalls, 1);
    const session = fakeSession([], 'frame');
    created.resolve(session);
    assert.deepEqual(await Promise.all([first, second]), [session, session]);
});
test('failed session creation is removed so a later call can retry', async () => {
    let creationCalls = 0;
    const session = fakeSession([], 'retry');
    const page = {
        context: () => undefined,
        mainFrame: () => undefined,
    };
    const provider = new CdpSessionProvider({
        newCDPSession: async () => {
            creationCalls++;
            if (creationCalls === 1) {
                throw new Error('transient session failure');
            }
            return session;
        },
    });
    await assert.rejects(provider.getSession(page), /transient session failure/);
    assert.equal(await provider.getSession(page), session);
    assert.equal(creationCalls, 2);
});
test('invalidating pending creation detaches its stale result and permits a fresh start', async () => {
    const firstCreated = Promise.withResolvers();
    const secondCreated = Promise.withResolvers();
    const detachCalls = [];
    let creationCalls = 0;
    const frame = { page: () => undefined };
    const provider = new CdpSessionProvider({
        newCDPSession: async () => {
            creationCalls++;
            return creationCalls === 1 ? firstCreated.promise : secondCreated.promise;
        },
    });
    const stale = provider.getSession(frame);
    provider.invalidate(frame);
    const fresh = provider.getSession(frame);
    assert.notEqual(stale, fresh);
    assert.equal(creationCalls, 2);
    firstCreated.resolve(fakeSession(detachCalls, 'stale'));
    await assert.rejects(stale, /session creation was invalidated/);
    assert.deepEqual(detachCalls, ['stale']);
    const current = fakeSession(detachCalls, 'fresh');
    secondCreated.resolve(current);
    assert.equal(await fresh, current);
    assert.equal(await provider.getSession(frame), current);
});
