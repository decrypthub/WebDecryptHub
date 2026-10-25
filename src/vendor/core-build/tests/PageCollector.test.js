/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_IN_FLIGHT_BODY_CAPTURES, NetworkCollector, responseBodyCacheSymbol, } from '../src/PageCollector.js';
// Mirror of MAX_RETAINED_REQUESTS in PageCollector.ts (the FIFO cap is module
// private). Keep in sync if the source constant changes.
const FIFO_CAP = 5000;
function createFakePage() {
    const listeners = new Map();
    const mainFrame = { id: 'main' };
    const page = {
        on(event, cb) {
            const arr = listeners.get(event) ?? [];
            arr.push(cb);
            listeners.set(event, arr);
            return page;
        },
        off() {
            return page;
        },
        mainFrame: () => mainFrame,
        emit(event, arg) {
            for (const cb of listeners.get(event) ?? []) {
                cb(arg);
            }
        },
    };
    return { page: page, mainFrame };
}
function createFakeRequest(url, frame) {
    return {
        url: () => url,
        method: () => 'POST',
        isNavigationRequest: () => false,
        frame: () => frame,
    };
}
// A request whose response body the collector will eagerly cache on
// 'requestfinished', counting `bodyLen` bytes against the page's body budget.
// frame().page() returns the page so the budget WeakMap keys correctly.
function createFakeRequestWithResponse(url, page, bodyLen) {
    const buffer = Buffer.alloc(bodyLen, 0x61);
    const frame = { page: () => page };
    return {
        url: () => url,
        method: () => 'POST',
        isNavigationRequest: () => false,
        frame: () => frame,
        response: async () => ({
            headers: () => ({ 'content-length': String(bodyLen) }),
            body: async () => buffer,
        }),
    };
}
function createFakeWorkerRequestWithResponse(url, bodyLen) {
    const buffer = Buffer.alloc(bodyLen, 0x61);
    return {
        url: () => url,
        method: () => 'GET',
        isNavigationRequest: () => false,
        frame: () => {
            throw new Error('service worker requests have no frame');
        },
        response: async () => ({
            headers: () => ({ 'content-length': String(bodyLen) }),
            body: async () => buffer,
        }),
    };
}
function createDeferredBodyRequest(url, page, onBodyStarted, contentLength) {
    const deferred = Promise.withResolvers();
    const frame = { page: () => page };
    return {
        request: {
            url: () => url,
            method: () => 'GET',
            isNavigationRequest: () => false,
            frame: () => frame,
            response: async () => ({
                headers: () => contentLength === undefined
                    ? {}
                    : { 'content-length': String(contentLength) },
                body: () => {
                    onBodyStarted();
                    return deferred.promise;
                },
            }),
        },
        resolveBody: deferred.resolve,
    };
}
function createCollector() {
    return new NetworkCollector({}, {});
}
function createFakeCdpSession(sendImpl = async () => undefined) {
    const handlers = new Map();
    const session = {
        on(event, cb) {
            const arr = handlers.get(event) ?? [];
            arr.push(cb);
            handlers.set(event, arr);
            return session;
        },
        off(event, cb) {
            const arr = handlers.get(event);
            if (arr) {
                handlers.set(event, arr.filter(listener => listener !== cb));
            }
            return session;
        },
        send: sendImpl,
        emit(event, payload) {
            for (const cb of handlers.get(event) ?? []) {
                cb(payload);
            }
        },
    };
    return { handlers, session };
}
const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));
test('requests survive navigation (FIFO is navigation-agnostic)', () => {
    const collector = createCollector();
    const { page, mainFrame } = createFakePage();
    collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    // A request that already fired (e.g. the POST that triggers a redirect).
    const subframe = { id: 'sub' };
    const bundle = createFakeRequest('https://x/assets/js/bundle', subframe);
    emit('request', bundle);
    // Navigation no longer splits or trims the queue, so the request stays
    // inspectable however many times the main frame navigates afterwards.
    for (let i = 0; i < 5; i++) {
        emit('framenavigated', mainFrame);
    }
    assert.ok(collector.getData(page).includes(bundle), 'request should stay inspectable after navigations');
});
test('evicts the oldest request once past the FIFO cap', () => {
    const collector = createCollector();
    const { page } = createFakePage();
    collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    const subframe = { id: 'sub' };
    let firstReq;
    let lastReq;
    // Emit more than the cap; the oldest beyond the cap roll off, newest stay.
    const total = FIFO_CAP + 500;
    for (let i = 0; i < total; i++) {
        const req = createFakeRequest(`https://x/r${i}`, subframe);
        if (i === 0) {
            firstReq = req;
        }
        if (i === total - 1) {
            lastReq = req;
        }
        emit('request', req);
    }
    const all = collector.getData(page);
    assert.equal(all.length, FIFO_CAP, 'queue should be capped at the FIFO cap');
    assert.ok(!all.includes(firstReq), 'the oldest request should be evicted');
    assert.ok(all.includes(lastReq), 'the newest request should be retained');
});
test('clear() empties the queue and reports + releases the body budget', async () => {
    const collector = createCollector();
    const { page } = createFakePage();
    collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    const req = createFakeRequestWithResponse('https://x/api', page, 1234);
    emit('request', req);
    emit('requestfinished', req);
    // Wait for the eager body capture (fire-and-forget) to count its bytes.
    await req[responseBodyCacheSymbol];
    const result = collector.clear(page);
    assert.equal(result.requestCount, 1, 'should report the cleared request count');
    assert.equal(result.reclaimedBytes, 1234, 'should report the released body budget');
    assert.equal(collector.getData(page).length, 0, 'queue should be empty after clear');
});
test('a body that resolves after clear is invalidated and cannot refill the budget', async () => {
    const collector = createCollector();
    const { page } = createFakePage();
    collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    const { promise: bodyPromise, resolve: resolveBody } = Promise.withResolvers();
    const frame = { page: () => page };
    const req = {
        url: () => 'https://x/slow',
        method: () => 'GET',
        isNavigationRequest: () => false,
        frame: () => frame,
        response: async () => ({
            headers: () => ({ 'content-length': '1234' }),
            body: () => bodyPromise,
        }),
    };
    emit('request', req);
    emit('requestfinished', req);
    const capture = req[responseBodyCacheSymbol];
    assert.deepEqual(collector.clear(page), {
        requestCount: 1,
        reclaimedBytes: 0,
    });
    resolveBody(Buffer.alloc(1234));
    assert.deepEqual(await capture, {
        ok: 'skipped',
        reason: 'response body cache generation was invalidated',
    });
    assert.equal(collector.clear(page).reclaimedBytes, 0, 'late capture must not refill a cleared cache generation');
});
test('response body capture bounds unknown-length in-flight allocations', async () => {
    const collector = createCollector();
    const { page } = createFakePage();
    await collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    let bodyStarts = 0;
    const deferred = Array.from({ length: MAX_IN_FLIGHT_BODY_CAPTURES + 1 }, (_, index) => createDeferredBodyRequest(`https://x/pending-${index}`, page, () => bodyStarts++));
    for (const { request } of deferred) {
        emit('request', request);
        emit('requestfinished', request);
    }
    await flushMicrotasks();
    assert.equal(bodyStarts, MAX_IN_FLIGHT_BODY_CAPTURES);
    const overflow = deferred.at(-1).request;
    assert.deepEqual(await overflow[responseBodyCacheSymbol], {
        ok: 'skipped',
        reason: 'page cache capture capacity exhausted',
    });
    for (const entry of deferred.slice(0, MAX_IN_FLIGHT_BODY_CAPTURES)) {
        entry.resolveBody(Buffer.from('x'));
    }
    await Promise.all(deferred.slice(0, MAX_IN_FLIGHT_BODY_CAPTURES).map(({ request }) => request[responseBodyCacheSymbol]));
});
test('clear invalidates captures without releasing their in-flight slots early', async () => {
    const collector = createCollector();
    const { page } = createFakePage();
    await collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    let bodyStarts = 0;
    const pending = Array.from({ length: MAX_IN_FLIGHT_BODY_CAPTURES }, (_, index) => createDeferredBodyRequest(`https://x/old-${index}`, page, () => bodyStarts++, 1));
    const oldCaptures = [];
    for (const { request } of pending) {
        emit('request', request);
        emit('requestfinished', request);
        oldCaptures.push(request[responseBodyCacheSymbol]);
    }
    await flushMicrotasks();
    assert.equal(bodyStarts, MAX_IN_FLIGHT_BODY_CAPTURES);
    collector.clear(page);
    const blocked = createDeferredBodyRequest('https://x/new-before-drain', page, () => bodyStarts++, 1);
    emit('request', blocked.request);
    emit('requestfinished', blocked.request);
    assert.deepEqual(await blocked.request[responseBodyCacheSymbol], { ok: 'skipped', reason: 'page cache capture capacity exhausted' });
    assert.equal(bodyStarts, MAX_IN_FLIGHT_BODY_CAPTURES);
    for (const entry of pending) {
        entry.resolveBody(Buffer.from('x'));
    }
    await Promise.all(oldCaptures);
    const admitted = createDeferredBodyRequest('https://x/new-after-drain', page, () => bodyStarts++, 1);
    emit('request', admitted.request);
    emit('requestfinished', admitted.request);
    await flushMicrotasks();
    assert.equal(bodyStarts, MAX_IN_FLIGHT_BODY_CAPTURES + 1);
    admitted.resolveBody(Buffer.from('x'));
    await admitted.request[responseBodyCacheSymbol];
});
test('frame-less worker responses still count against their collector page budget', async () => {
    const collector = createCollector();
    const { page } = createFakePage();
    collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    const req = createFakeWorkerRequestWithResponse('https://x/worker-resource', 321);
    emit('request', req);
    emit('requestfinished', req);
    await req[responseBodyCacheSymbol];
    assert.equal(collector.clear(page).reclaimedBytes, 321);
});
test('FIFO eviction reclaims the evicted request body budget (no ratchet)', async () => {
    const collector = createCollector();
    const { page } = createFakePage();
    collector.addPage(page);
    const emit = (event, arg) => page.emit(event, arg);
    const subframe = { id: 'sub' };
    // A request with a cached 1000-byte body, counted against the budget.
    const withBody = createFakeRequestWithResponse('https://x/r0', page, 1000);
    emit('request', withBody);
    emit('requestfinished', withBody);
    await withBody[responseBodyCacheSymbol];
    // Push exactly FIFO_CAP more requests so the body request rolls off the tail.
    for (let i = 0; i < FIFO_CAP; i++) {
        emit('request', createFakeRequest(`https://x/d${i}`, subframe));
    }
    assert.ok(!collector.getData(page).includes(withBody), 'the body request should have been evicted');
    // A new request adds 50 bytes. If eviction reclaimed the 1000 bytes, the
    // budget now holds only these 50; if it ratcheted, it would hold 1050.
    const newBody = createFakeRequestWithResponse('https://x/rn', page, 50);
    emit('request', newBody);
    emit('requestfinished', newBody);
    await newBody[responseBodyCacheSymbol];
    assert.equal(collector.clear(page).reclaimedBytes, 50, 'evicted request bytes must be reclaimed, not ratcheted');
});
test('getInitiator recovers via URL+method when the requestId mapping lost the race', async () => {
    const { page } = createFakePage();
    const { session: cdp } = createFakeCdpSession();
    const collector = new NetworkCollector({ pages: () => [page] }, { getSession: async () => cdp });
    collector.addPage(page);
    await collector.initCdp();
    await flushMicrotasks(); // let the fire-and-forget CDP setup finish
    // The CDP requestWillBeSent event arrives before the Playwright request is in
    // storage, so the requestId mapping never tags the request object.
    cdp.emit('Network.requestWillBeSent', {
        requestId: 'req-1',
        request: { url: 'https://x/api', method: 'POST' },
        initiator: {
            type: 'script',
            stack: {
                callFrames: [
                    {
                        functionName: 'doFetch',
                        scriptId: '1',
                        url: 'https://x/page1.html',
                        lineNumber: 1,
                        columnNumber: 1,
                    },
                ],
            },
        },
    });
    // createFakeRequest uses method POST; cdpRequestIdSymbol was never set, so the
    // requestId path yields nothing and the URL+method fallback must recover it.
    const request = createFakeRequest('https://x/api', { id: 'sub' });
    const initiator = collector.getInitiator(page, request);
    assert.ok(initiator, 'initiator should be recovered via the URL+method fallback');
    assert.equal(initiator?.type, 'script');
    assert.equal(initiator?.stack?.callFrames[0].functionName, 'doFetch');
});
test('network CDP initialization is deduplicated and does not resolve before ready', async () => {
    const { page } = createFakePage();
    const enabled = Promise.withResolvers();
    let enableCalls = 0;
    let sessionCalls = 0;
    const { session } = createFakeCdpSession(async (method) => {
        if (method === 'Network.enable') {
            enableCalls++;
            await enabled.promise;
        }
    });
    const collector = new NetworkCollector({
        pages: () => [page],
        on: () => undefined,
        off: () => undefined,
    }, {
        getSession: async () => {
            sessionCalls++;
            return session;
        },
    });
    await collector.addPage(page);
    let settled = false;
    const first = collector.initCdp();
    const second = collector.initCdp();
    void Promise.all([first, second]).finally(() => {
        settled = true;
    });
    await flushMicrotasks();
    assert.equal(sessionCalls, 1);
    assert.equal(enableCalls, 1);
    assert.equal(settled, false);
    enabled.resolve();
    await Promise.all([first, second]);
    assert.equal(settled, true);
});
test('network CDP initialization rolls back listeners and retries after failure', async () => {
    const { page } = createFakePage();
    let enableCalls = 0;
    const { handlers, session } = createFakeCdpSession(async (method) => {
        if (method === 'Network.enable' && ++enableCalls === 1) {
            throw new Error('transient Network.enable failure');
        }
    });
    const collector = new NetworkCollector({
        pages: () => [page],
        on: () => undefined,
        off: () => undefined,
    }, { getSession: async () => session });
    await collector.addPage(page);
    await assert.rejects(collector.initCdp(), /transient Network.enable failure/);
    assert.equal(handlers.get('Network.requestWillBeSent')?.length ?? 0, 0);
    await collector.initCdp();
    assert.equal(enableCalls, 2);
    assert.equal(handlers.get('Network.requestWillBeSent')?.length, 1);
});
test('disposing during network CDP setup removes listeners after setup drains', async () => {
    const { page } = createFakePage();
    const enabled = Promise.withResolvers();
    const { handlers, session } = createFakeCdpSession(async (method) => {
        if (method === 'Network.enable') {
            await enabled.promise;
        }
    });
    const collector = new NetworkCollector({
        pages: () => [page],
        on: () => undefined,
        off: () => undefined,
    }, { getSession: async () => session });
    await collector.addPage(page);
    const setup = collector.initCdp();
    await flushMicrotasks();
    collector.dispose();
    enabled.resolve();
    await setup;
    assert.equal(handlers.get('Network.requestWillBeSent')?.length ?? 0, 0);
    assert.equal(collector.getData(page).length, 0);
});
test('concurrent new-page setup shares the pending network CDP initialization', async () => {
    const firstPage = createFakePage().page;
    const secondPage = createFakePage().page;
    let pages = [firstPage];
    const secondEnabled = Promise.withResolvers();
    let secondSessionCalls = 0;
    const firstSession = createFakeCdpSession().session;
    const secondSession = createFakeCdpSession(async (method) => {
        if (method === 'Network.enable') {
            await secondEnabled.promise;
        }
    }).session;
    const collector = new NetworkCollector({
        pages: () => pages,
        on: () => undefined,
        off: () => undefined,
    }, {
        getSession: async (page) => {
            if (page === secondPage) {
                secondSessionCalls++;
                return secondSession;
            }
            return firstSession;
        },
    });
    await collector.addPage(firstPage);
    await collector.initCdp();
    pages = [firstPage, secondPage];
    let settled = false;
    const fromEvent = collector.addPage(secondPage);
    const fromExplicitPath = collector.addPage(secondPage).finally(() => {
        settled = true;
    });
    await flushMicrotasks();
    assert.equal(secondSessionCalls, 1);
    assert.equal(settled, false);
    secondEnabled.resolve();
    await Promise.all([fromEvent, fromExplicitPath]);
    assert.equal(settled, true);
});
