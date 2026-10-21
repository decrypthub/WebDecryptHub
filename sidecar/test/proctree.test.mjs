import test from 'node:test';
import assert from 'node:assert/strict';
import { killTreeArgs } from '../proctree.mjs';

test('windows kill is by pid and tree, never by image name', () => {
  assert.equal(killTreeArgs(0, 'win32'), null);
  assert.equal(killTreeArgs(-3, 'win32'), null);
  const spec = killTreeArgs(4242, 'win32');
  assert.deepEqual(spec, { file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
  assert.equal(spec.args.includes('/IM'), false);
  assert.equal(spec.args.join(' ').toLowerCase().includes('chrome'), false);
  assert.equal(spec.args.join(' ').toLowerCase().includes('node'), false);
});

test('posix kill targets the process group of that pid', () => {
  assert.deepEqual(killTreeArgs(7, 'linux'), { signalGroup: true, pid: 7 });
});
