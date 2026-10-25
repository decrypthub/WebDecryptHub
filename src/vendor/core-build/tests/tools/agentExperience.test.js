/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { McpContext } from '../../src/McpContext.js';
import { McpResponse } from '../../src/McpResponse.js';
import { zod } from '../../src/third_party/index.js';
import { ToolError } from '../../src/ToolError.js';
import { listConsoleMessages } from '../../src/tools/console.js';
import { getRequestInitiator, listScripts, pauseOrResume, searchInSources, setBreakpointOnText, } from '../../src/tools/debugger.js';
import { clickElement } from '../../src/tools/interaction.js';
import { clearNetworkRequests, listNetworkRequests, } from '../../src/tools/network.js';
import { screenshot } from '../../src/tools/screenshot.js';
import { evaluateScript } from '../../src/tools/script.js';
import { clearSiteData } from '../../src/tools/siteData.js';
import { timeoutSchema, TOOL_OUTPUT_SCHEMA, } from '../../src/tools/ToolDefinition.js';
import { getWebSocketMessages } from '../../src/tools/websocket.js';
import { paginate } from '../../src/utils/pagination.js';
test('common output schema validates success and stable error envelopes', () => {
    const schema = zod.object(TOOL_OUTPUT_SCHEMA);
    assert.equal(schema.parse({
        ok: true,
        tool: 'list_scripts',
        summary: 'Found scripts',
        data: { scripts: [] },
    }).ok, true);
    assert.equal(schema.parse({
        ok: false,
        tool: 'clear_site_data',
        summary: 'Confirmation required',
        error: {
            code: 'CONFIRMATION_REQUIRED',
            message: 'Confirmation required',
            retryable: false,
        },
    }).ok, false);
});
test('major tools expose typed data schemas inside the common envelope', () => {
    assert.ok(listScripts.outputSchema);
    const parsed = zod.object(listScripts.outputSchema).parse({
        ok: true,
        tool: 'list_scripts',
        summary: 'Found one script',
        data: {
            scripts: [
                {
                    scriptId: '1',
                    url: null,
                    kind: 'inline_or_eval',
                    sourceMapURL: null,
                    hash: 'abc',
                },
            ],
            pagination: {
                pageIdx: 0,
                pageSize: 20,
                totalItems: 1,
                totalPages: 1,
                hasNextPage: false,
            },
        },
    });
    assert.equal(('data' in parsed ? parsed.data : undefined)?.scripts?.[0]?.kind, 'inline_or_eval');
    assert.ok(listNetworkRequests.outputSchema);
    assert.ok(listConsoleMessages.outputSchema);
    assert.ok(getWebSocketMessages.outputSchema);
    assert.ok(screenshot.outputSchema, 'non-major tools inherit the envelope');
});
test('McpResponse creates machine-readable structured content', () => {
    const response = new McpResponse();
    response.appendResponseLine('Found 2 scripts.');
    response.setStructuredContent({ scripts: [{ scriptId: '1' }] });
    assert.deepEqual(response.createStructuredContent('list_scripts'), {
        ok: true,
        tool: 'list_scripts',
        summary: 'Found 2 scripts.',
        data: { scripts: [{ scriptId: '1' }] },
    });
});
test('pagination defaults every list to 20 items', () => {
    const result = paginate(Array.from({ length: 25 }, (_, index) => index));
    assert.equal(result.items.length, 20);
    assert.equal(result.hasNextPage, true);
    assert.equal(result.totalPages, 2);
});
test('pause_or_resume requires an explicit action', () => {
    const schema = zod.object(pauseOrResume.schema);
    assert.throws(() => schema.parse({}));
    assert.equal(schema.parse({ action: 'pause' }).action, 'pause');
});
test('timeout=0 consistently selects the tool default', () => {
    const schema = zod.object(timeoutSchema);
    assert.equal(schema.parse({ timeout: 0 }).timeout, undefined);
    assert.equal(schema.parse({ timeout: 1250 }).timeout, 1250);
});
test('explicit execution action returns a stable conflict code', async () => {
    await assert.rejects(pauseOrResume.handler({ params: { action: 'resume' } }, {}, {
        debuggerContext: {
            isEnabled: () => true,
            isPaused: () => false,
        },
    }), (error) => error instanceof ToolError && error.code === 'CONFLICT');
});
test('stale request IDs use the same not-found code across tools', async () => {
    await assert.rejects(getRequestInitiator.handler({ params: { requestId: 999 } }, {}, {
        getNetworkRequestById: () => {
            throw new Error('Request not found');
        },
    }), (error) => error instanceof ToolError && error.code === 'NOT_FOUND');
});
test('breakpoint setters fail when no breakpoint was created', async () => {
    await assert.rejects(setBreakpointOnText.handler({
        params: {
            text: 'missingFunction',
            occurrence: 1,
        },
    }, {}, {
        debuggerContext: {
            isEnabled: () => true,
            searchInScripts: async () => ({
                query: 'missingFunction',
                matches: [],
            }),
        },
    }), (error) => error instanceof ToolError && error.code === 'NOT_FOUND');
});
test('destructive tools reject calls without explicit confirmation', async () => {
    await assert.rejects(clearNetworkRequests.handler({ params: { confirm: false } }, {}, {}), (error) => error instanceof ToolError && error.code === 'CONFIRMATION_REQUIRED');
    await assert.rejects(clearSiteData.handler({ params: { confirm: false, clearBrowserCache: false } }, {}, {}), (error) => error instanceof ToolError && error.code === 'CONFIRMATION_REQUIRED');
    await assert.rejects(clickElement.handler({
        params: {
            confirm: false,
            selector: 'button',
            button: 'left',
            timeout: undefined,
        },
    }, {}, {}), (error) => error instanceof ToolError && error.code === 'CONFIRMATION_REQUIRED');
    await assert.rejects(evaluateScript.handler({
        params: {
            confirm: false,
            function: '() => 1',
            mainWorld: false,
            confirmOverwrite: false,
        },
    }, {}, {}), (error) => error instanceof ToolError && error.code === 'CONFIRMATION_REQUIRED');
    assert.equal(evaluateScript.annotations.destructiveHint, true);
    assert.equal(pauseOrResume.annotations.destructiveHint, false);
});
test('file output cannot overwrite an existing file without confirmation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-safe-write-'));
    const filename = path.join(directory, 'result.txt');
    await fs.writeFile(filename, 'original');
    const context = { logger: () => undefined };
    try {
        await assert.rejects(McpContext.prototype.saveFile.call(context, new TextEncoder().encode('replacement'), filename), (error) => error instanceof ToolError && error.code === 'CONFIRMATION_REQUIRED');
        await McpContext.prototype.saveFile.call(context, new TextEncoder().encode('replacement'), filename, { confirmOverwrite: true });
        assert.equal(await fs.readFile(filename, 'utf8'), 'replacement');
        assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test('list_scripts includes inline/eval scripts in the default page', async () => {
    const structured = {};
    await listScripts.handler({ params: {} }, {
        appendResponseLine: () => undefined,
        setStructuredContent: (value) => Object.assign(structured, value),
    }, {
        debuggerContext: {
            isEnabled: () => true,
            getScripts: () => [
                {
                    scriptId: 'inline-1',
                    url: '',
                    hash: 'hash',
                },
                {
                    scriptId: 'external-1',
                    url: 'https://example.test/app.js',
                    hash: 'hash-2',
                },
            ],
        },
    });
    assert.deepEqual(structured.scripts.map(script => script.kind), ['inline_or_eval', 'external']);
});
test('compressed-source search is included by default', () => {
    const parsed = zod.object(searchInSources.schema).parse({ query: 'token' });
    assert.equal(parsed.excludeMinified, false);
});
test('compressed-source structured previews stay centered on the match', async () => {
    const params = zod.object(searchInSources.schema).parse({
        query: 'needle-token',
    });
    const structured = {};
    await searchInSources.handler({ params }, {
        appendResponseLine: () => undefined,
        setStructuredContent: (value) => Object.assign(structured, value),
    }, {
        debuggerContext: {
            isEnabled: () => true,
            searchInScripts: async () => ({
                query: 'needle-token',
                matches: [
                    {
                        scriptId: 'minified-1',
                        url: 'https://example.test/app.min.js',
                        lineNumber: 0,
                        lineContent: `${'x'.repeat(500)}needle-token${'y'.repeat(500)}`,
                    },
                ],
            }),
        },
    });
    const [match] = structured.matches;
    assert.match(match.lineContent, /needle-token/);
    assert.ok(match.lineContent.length <= params.maxLineLength + 6);
});
test('click_element refuses to guess among multiple matches', async () => {
    await assert.rejects(clickElement.handler({
        params: {
            confirm: true,
            selector: 'button',
            button: 'left',
            timeout: undefined,
        },
    }, {}, {
        getSelectedFrame: () => ({
            locator: () => ({
                elementHandles: async () => [
                    { dispose: async () => undefined },
                    { dispose: async () => undefined },
                ],
            }),
        }),
    }), (error) => error instanceof ToolError && error.code === 'CONFLICT');
});
test('click_element reports the verified target it clicked', async () => {
    let clicked = false;
    let disposed = false;
    let structured = {};
    const pinnedElement = {
        isVisible: async () => true,
        evaluate: async () => ({
            tagName: 'button',
            id: 'submit',
            role: null,
            text: 'Submit',
            ariaLabel: null,
        }),
        click: async () => {
            clicked = true;
        },
        dispose: async () => {
            disposed = true;
        },
    };
    const locator = {
        elementHandles: async () => [pinnedElement],
    };
    await clickElement.handler({
        params: {
            confirm: true,
            selector: '#submit',
            button: 'left',
            timeout: undefined,
        },
    }, {
        appendResponseLine: () => undefined,
        setStructuredContent: (value) => {
            structured = value;
        },
    }, { getSelectedFrame: () => ({ locator: () => locator }) });
    assert.equal(clicked, true);
    assert.equal(disposed, true);
    assert.deepEqual(structured.element, {
        tagName: 'button',
        id: 'submit',
        role: null,
        text: 'Submit',
        ariaLabel: null,
    });
});
test('click_element never falls through to a replacement node', async () => {
    const pinnedElement = {
        isVisible: async () => true,
        evaluate: async () => ({
            tagName: 'button',
            id: 'old-submit',
            role: null,
            text: 'Old submit',
            ariaLabel: null,
        }),
        click: async () => {
            throw new Error('Element is not attached to the DOM');
        },
        dispose: async () => undefined,
    };
    await assert.rejects(clickElement.handler({
        params: {
            confirm: true,
            selector: '#submit',
            button: 'left',
            timeout: undefined,
        },
    }, { appendResponseLine: () => undefined }, {
        getSelectedFrame: () => ({
            locator: () => ({ elementHandles: async () => [pinnedElement] }),
        }),
    }), (error) => error instanceof ToolError &&
        error.code === 'CONFLICT' &&
        error.retryable);
});
test('tools declare only their required collector capabilities', () => {
    assert.deepEqual(listNetworkRequests.capabilities, [
        'network',
        'devtools-ui',
    ]);
    assert.equal(listConsoleMessages.capabilities, undefined, 'console collection uses Playwright listeners and needs no CDP domain');
    assert.deepEqual(getWebSocketMessages.capabilities, ['websocket']);
    assert.equal(screenshot.capabilities, undefined);
});
