/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { basename, dirname, join } from 'node:path';
import * as nodeTest from 'node:test';
import '../src/polyfill.js';
nodeTest.snapshot?.setResolveSnapshotPath((testFilePath) => {
    if (!testFilePath)
        return 'unknown.snapshot';
    return join(dirname(testFilePath), `${basename(testFilePath)}.snapshot`);
});
