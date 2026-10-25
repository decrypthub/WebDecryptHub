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
import { formatLogValue, formatToolErrorLog, logger, saveLogsToFile, } from '../src/logger.js';
test('structured log formatting redacts credentials and executable source', () => {
    const output = formatLogValue({
        authorization: 'Bearer top-secret',
        function: '() => window.secret',
        localFilePath: '/Users/example/private/input.bin',
        nested: {
            url: 'https://user:password@example.test/?X-Amz-Credential=AKIA&X-Amz-Signature=query-secret#fragment-secret',
            endpoint: 'ws://127.0.0.1:9222/devtools/browser/control-secret',
        },
        urlFilter: 'private-url-filter-secret',
        text: 'proprietary-source-text',
        harmless: 'visible',
    });
    assert.doesNotMatch(output, /top-secret|window\.secret|password|query-secret|fragment-secret|control-secret|AKIA|private\/input|private-url-filter-secret|proprietary-source-text/);
    assert.match(output, /\[REDACTED\]/);
    assert.match(output, /visible/);
});
test('tool error logs contain stable metadata but not free-form messages', () => {
    const error = {
        code: 'IO_ERROR',
        retryable: false,
        message: "EACCES: permission denied, open '/Users/example/private/input.txt'",
    };
    const output = formatToolErrorLog('save_script_source', error);
    assert.equal(output, 'save_script_source error: code=IO_ERROR retryable=false');
    assert.doesNotMatch(output, /EACCES|permission denied|Users\/example/);
});
test('log files refuse symbolic-link destinations', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-log-link-'));
    const outside = path.join(directory, 'outside.log');
    const link = path.join(directory, 'linked.log');
    await fs.writeFile(outside, 'unchanged', { mode: 0o644 });
    await fs.symlink(outside, link);
    try {
        assert.throws(() => saveLogsToFile(link));
        assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
        assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
test('log files use 0600 and redact free-form credential patterns', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-log-'));
    const filename = path.join(directory, 'debug.log');
    await fs.writeFile(filename, '', { mode: 0o644 });
    await fs.chmod(filename, 0o644);
    const stream = saveLogsToFile(filename);
    try {
        logger('request https://user:pass@example.test/?api_key=query-secret Authorization: Bearer header-secret');
        logger('save failed', new Error("EACCES: permission denied, open '/Users/example/private/input.txt'"));
        await new Promise(resolve => stream.end(resolve));
        const stat = await fs.stat(filename);
        const content = await fs.readFile(filename, 'utf8');
        assert.equal(stat.mode & 0o777, 0o600);
        assert.doesNotMatch(content, /user:pass|query-secret|header-secret|Users\/example\/private/);
        assert.match(content, /\[REDACTED\]/);
    }
    finally {
        if (!stream.closed) {
            stream.end();
        }
        await fs.rm(directory, { recursive: true, force: true });
    }
});
