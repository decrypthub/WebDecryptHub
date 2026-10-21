// Regenerate self-made obfuscator.io samples (requires: npm i javascript-obfuscator)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { default: JavaScriptObfuscator } = await import('javascript-obfuscator');
const src = fs.readFileSync(path.join(__dirname, 'fixtures/clean.js'), 'utf8');
const levels = {
  low: { compact: true, stringArray: true, stringArrayThreshold: 0.5 },
  medium: { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.75, stringArray: true, stringArrayThreshold: 0.8, stringArrayRotate: true, deadCodeInjection: true, transformObjectKeys: true },
  high: { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, stringArray: true, stringArrayThreshold: 1, stringArrayRotate: true, stringArrayEncoding: ['rc4'], deadCodeInjection: true, selfDefending: true, transformObjectKeys: true },
};
for (const [name, opts] of Object.entries(levels)) {
  const out = JavaScriptObfuscator.obfuscate(src, { ...opts, target: 'node' }).getObfuscatedCode();
  fs.writeFileSync(path.join(__dirname, 'obfuscator', name + '.js'), out);
  console.log('wrote', name, out.length);
}
