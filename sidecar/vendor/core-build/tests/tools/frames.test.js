/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectFrame } from '../../src/tools/frames.js';
test('select_frame waits for frame debugger reinitialization', async () => {
    const selected = Promise.withResolvers();
    const mainFrame = {
        parentFrame: () => null,
        url: () => 'https://example.test/',
        name: () => '',
    };
    const childFrame = {
        parentFrame: () => mainFrame,
        url: () => 'https://child.example.test/',
        name: () => 'child',
    };
    let settled = false;
    let structured = {};
    const call = selectFrame
        .handler({ params: { frameIdx: 1 } }, {
        appendResponseLine: () => undefined,
        setStructuredContent: (value) => {
            structured = value;
        },
    }, {
        getSelectedPage: () => ({ frames: () => [mainFrame, childFrame] }),
        getSelectedFrame: () => mainFrame,
        selectFrame: () => selected.promise,
    })
        .finally(() => {
        settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    selected.resolve();
    await call;
    assert.equal(settled, true);
    assert.deepEqual(structured.selectedFrame, {
        frameIdx: 1,
        url: 'https://child.example.test/',
        name: 'child',
        isMainFrame: false,
    });
});
