import { ensurePatchrightResources } from './runtime.mjs';
await ensurePatchrightResources();
const parent = process.ppid;
const watcher = setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch (e) {
    if (e.code !== 'EPERM') process.exit(0);
  }
}, 3000);
watcher.unref();
process.stdin.on('end', () => setTimeout(() => process.exit(0), 100));
await import('./vendor/core-build/src/main.js');
