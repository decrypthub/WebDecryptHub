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
import { buildCloakArgs, getOrCreateSeed } from '../src/cloak.js';
test('CloakBrowser args preserve upstream platform defaults safely', () => {
    assert.deepEqual(buildCloakArgs([
        '--no-sandbox',
        '--fingerprint=99999',
        '--fingerprint-platform=macos',
        '--future-stealth-flag',
    ], 12345), [
        '--fingerprint-platform=macos',
        '--future-stealth-flag',
        '--fingerprint=12345',
    ]);
});
test('Cloak fingerprint seed is a 0600 regular file', async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cloak-'));
    try {
        const seed = getOrCreateSeed(profile);
        const seedFile = path.join(profile, '.cloak-seed');
        const stat = await fs.stat(seedFile);
        assert.equal(stat.isFile(), true);
        assert.equal(stat.mode & 0o777, 0o600);
        assert.equal(getOrCreateSeed(profile), seed);
    }
    finally {
        await fs.rm(profile, { recursive: true, force: true });
    }
});
test('Cloak fingerprint seed refuses dangling symlinks', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cloak-link-'));
    const profile = path.join(parent, 'profile');
    const outside = path.join(parent, 'outside-seed');
    await fs.mkdir(profile);
    await fs.symlink(outside, path.join(profile, '.cloak-seed'));
    try {
        assert.throws(() => getOrCreateSeed(profile));
        await assert.rejects(fs.stat(outside), { code: 'ENOENT' });
    }
    finally {
        await fs.rm(parent, { recursive: true, force: true });
    }
});
