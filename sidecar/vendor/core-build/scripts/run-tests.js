/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
function collectTestFiles(directory) {
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectTestFiles(entryPath);
        }
        return entry.isFile() && entry.name.endsWith('.test.js')
            ? [entryPath]
            : [];
    })
        .sort();
}
const testFiles = collectTestFiles(path.join('build', 'tests'));
if (testFiles.length === 0) {
    throw new Error('No compiled test files found under build/tests.');
}
const result = spawnSync(process.execPath, [
    '--require',
    path.resolve('build/tests/setup.js'),
    '--no-warnings=ExperimentalWarning',
    '--test-reporter',
    'spec',
    '--test-force-exit',
    '--test',
    ...process.argv.slice(2),
    ...testFiles,
], { stdio: 'inherit' });
if (result.error) {
    throw result.error;
}
process.exitCode = result.status ?? 1;
