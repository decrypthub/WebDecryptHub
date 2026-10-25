/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DebuggerContext } from '../src/DebuggerContext.js';
function createSession(promiseState = 'fulfilled', options = {}) {
    const handlers = new Map();
    const commands = [];
    const session = {
        on(event, listener) {
            let listeners = handlers.get(event);
            if (!listeners) {
                listeners = new Set();
                handlers.set(event, listeners);
            }
            listeners.add(listener);
            return session;
        },
        off(event, listener) {
            handlers.get(event)?.delete(listener);
            return session;
        },
        async send(method, params) {
            commands.push({ method, params });
            switch (method) {
                case 'Debugger.enable':
                    if (options.failEnableOnce) {
                        options.failEnableOnce = false;
                        throw new Error('enable failed');
                    }
                    return {};
                case 'Debugger.evaluateOnCallFrame':
                    return {
                        result: { type: 'object', subtype: 'promise', objectId: 'promise-1' },
                    };
                case 'Runtime.getProperties':
                    if (params?.objectId ===
                        'result-object') {
                        return {
                            result: [
                                {
                                    name: 'answer',
                                    enumerable: true,
                                    value: { type: 'number', value: 44 },
                                },
                            ],
                        };
                    }
                    return {
                        result: [],
                        internalProperties: [
                            {
                                name: '[[PromiseState]]',
                                value: { type: 'string', value: promiseState },
                            },
                            {
                                name: '[[PromiseResult]]',
                                value: options.objectPromiseResult
                                    ? {
                                        type: 'object',
                                        subtype: 'object',
                                        objectId: 'result-object',
                                    }
                                    : { type: 'string', value: 'settled-value' },
                            },
                        ],
                    };
                case 'Debugger.searchInContent':
                    return {
                        result: [{ lineNumber: 0, lineContent: 'const inlineToken = true;' }],
                    };
                case 'Debugger.setBreakpointByUrl':
                    return {
                        breakpointId: `breakpoint-${commands.length}`,
                        locations: [],
                    };
                case 'Debugger.removeBreakpoint':
                    if (options.failBreakpointRemoval) {
                        throw new Error('remove failed');
                    }
                    return {};
                default:
                    return {};
            }
        },
        emit(event, payload) {
            for (const listener of handlers.get(event) ?? []) {
                listener(payload);
            }
        },
    };
    return {
        commands,
        handlers,
        session: session,
        emitPaused() {
            session.emit('Debugger.paused', {
                reason: 'other',
                hitBreakpoints: [],
                callFrames: [
                    {
                        callFrameId: 'frame-1',
                        functionName: 'pausedFunction',
                        location: { scriptId: '1', lineNumber: 0, columnNumber: 0 },
                        url: 'https://example.test/app.js',
                        scopeChain: [],
                        this: { type: 'undefined' },
                    },
                ],
            });
        },
        emitInlineScript() {
            session.emit('Debugger.scriptParsed', {
                scriptId: 'inline-script',
                url: '',
                startLine: 0,
                startColumn: 0,
                endLine: 0,
                endColumn: 25,
                hash: '',
            });
        },
    };
}
test('paused async evaluation unwraps an already-settled Promise', async () => {
    const fake = createSession('fulfilled');
    const context = new DebuggerContext();
    await context.enable(fake.session);
    fake.emitPaused();
    const result = await context.evaluateSettledPromiseOnCallFrame('frame-1', '(async () => 42)()');
    assert.equal(result.result.value, 'settled-value');
    assert.equal(result.settledPromise, true);
    assert.equal(fake.commands.some(command => command.method === 'Runtime.awaitPromise'), false);
});
test('paused async evaluation rejects a Promise that needs page progress', async () => {
    const fake = createSession('pending');
    const context = new DebuggerContext();
    await context.enable(fake.session);
    fake.emitPaused();
    await assert.rejects(context.evaluateSettledPromiseOnCallFrame('frame-1', '(async () => await fetch("/"))()'), /cannot settle while execution remains paused/);
    assert.equal(fake.commands.some(command => command.method === 'Runtime.awaitPromise'), false);
});
test('materializes an already-settled object without resuming execution', async () => {
    const fake = createSession('fulfilled', { objectPromiseResult: true });
    const context = new DebuggerContext();
    await context.enable(fake.session);
    fake.emitPaused();
    const result = await context.evaluateSettledPromiseOnCallFrame('frame-1', '(async () => ({answer: 44}))()');
    assert.deepEqual(await context.materializeRemoteObject(result.result), {
        answer: 44,
    });
    assert.equal(fake.commands.some(command => command.method === 'Runtime.awaitPromise'), false);
});
test('disable detaches debugger lifecycle listeners', async () => {
    const fake = createSession();
    const context = new DebuggerContext();
    await context.enable(fake.session);
    await context.disable();
    assert.equal(fake.handlers.get('Debugger.paused')?.size, 0);
    assert.equal(fake.handlers.get('Debugger.resumed')?.size, 0);
    assert.ok(fake.commands.some(command => command.method === 'Debugger.disable'));
});
test('failed enable rolls back listeners and can be retried', async () => {
    const fake = createSession('fulfilled', { failEnableOnce: true });
    const context = new DebuggerContext();
    await assert.rejects(context.enable(fake.session), /enable failed/);
    assert.equal(context.isEnabled(), false);
    assert.equal(context.getClient(), null);
    assert.equal(fake.handlers.get('Debugger.scriptParsed')?.size, 0);
    assert.equal(fake.handlers.get('Debugger.paused')?.size, 0);
    assert.equal(fake.handlers.get('Debugger.resumed')?.size, 0);
    await context.enable(fake.session);
    assert.equal(context.isEnabled(), true);
    assert.equal(fake.handlers.get('Debugger.scriptParsed')?.size, 1);
    assert.equal(fake.handlers.get('Debugger.paused')?.size, 1);
    assert.equal(fake.handlers.get('Debugger.resumed')?.size, 1);
});
test('reinitialization can preserve and restore code and XHR breakpoints', async () => {
    const fake = createSession();
    const context = new DebuggerContext();
    await context.enable(fake.session);
    await context.setBreakpoint('https://example.test/app.js', 4);
    await context.setXHRBreakpoint('/api/');
    const definitions = context.getBreakpoints();
    await context.disable({ preserveBreakpoints: true });
    assert.equal(context.getBreakpoints().length, 1);
    assert.deepEqual(context.getXHRBreakpoints(), ['/api/']);
    await context.enable(fake.session);
    await context.restoreBreakpoints(definitions);
    await context.restoreXHRBreakpoints();
    assert.equal(context.getBreakpoints().length, 1);
    assert.ok(fake.commands.filter(command => command.method === 'Debugger.setBreakpointByUrl').length >= 2);
    assert.ok(fake.commands.filter(command => command.method === 'DOMDebugger.setXHRBreakpoint').length >= 2);
    await context.disable();
    assert.equal(context.getBreakpoints().length, 0);
    assert.equal(context.getXHRBreakpoints().length, 0);
});
test('removeAllBreakpoints reports partial failures honestly', async () => {
    const fake = createSession('fulfilled', { failBreakpointRemoval: true });
    const context = new DebuggerContext();
    await context.enable(fake.session);
    const breakpoint = await context.setBreakpoint('https://example.test/app.js', 4);
    await context.setXHRBreakpoint('/api/');
    assert.deepEqual(await context.removeAllBreakpoints(), {
        removedCode: 0,
        removedXHR: 1,
        failedCode: [breakpoint.breakpointId],
        failedXHR: [],
    });
    assert.equal(context.getBreakpoints().length, 1);
    assert.equal(context.getXHRBreakpoints().length, 0);
});
test('source search includes inline/eval scripts without URLs', async () => {
    const fake = createSession();
    const context = new DebuggerContext();
    await context.enable(fake.session);
    fake.emitInlineScript();
    const result = await context.searchInScripts('inlineToken');
    assert.deepEqual(result.matches, [
        {
            scriptId: 'inline-script',
            url: '',
            lineNumber: 0,
            lineContent: 'const inlineToken = true;',
        },
    ]);
});
