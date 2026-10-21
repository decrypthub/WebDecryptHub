// 构建 sidecar 单文件 exe（bun）。用法：bun scripts/build-sidecar.mjs [win|linux|all]
// 关键：patchright-core 的 __dirname 在 bun --compile 下会被固化为构建机绝对路径（v1.0.2 的启动崩溃根因）。
// 这里用插件把 __dirname 重写为运行时解析的资源目录，并把 package.json / browsers.json 内联进 bundle。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const ROOT = path.resolve(import.meta.dir, '..');
const SC = path.join(ROOT, 'sidecar');
const PWC = path.join(SC, 'node_modules/@zhizhuodemao/patchright-core');
const OUT = path.join(ROOT, 'build');
const RES = path.join(OUT, 'resources');
const pwPkg = JSON.parse(fs.readFileSync(path.join(PWC, 'package.json'), 'utf8'));

// 1) 运行资源目录 + 内嵌 zip
fs.rmSync(path.join(RES, 'patchright-core'), { recursive: true, force: true });
fs.mkdirSync(path.join(RES, 'patchright-core'), { recursive: true });
execSync(`cp package.json browsers.json "${RES}/patchright-core/" && cp -r lib "${RES}/patchright-core/" && rm -rf "${RES}/patchright-core/lib/vite"`, { cwd: PWC });
const zip = path.join(SC, '.pw-res.zip');
fs.rmSync(zip, { force: true });
execSync(`python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', sys.argv[2])" "${zip}" "${RES}/patchright-core"`);

const pwPlugin = {
  name: 'patchright-relocate',
  setup(build) {
    build.onLoad({ filter: /patchright-core[\\/]lib[\\/].*\.js$/ }, args => {
      let src = fs.readFileSync(args.path, 'utf8');
      const rel = path.relative(path.join(PWC, 'lib'), path.dirname(args.path)).split(path.sep).join('/');
      src = src.replace(/require\((import_path\d*)\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g, (_, __, n) => JSON.stringify(JSON.parse(fs.readFileSync(path.join(PWC, n + '.json'), 'utf8'))));
      // __dirname -> 运行时资源目录下对应子目录
      src = src.replace(/(?<![.\w$])__dirname(?![\w$])/g, '__jsra_dirname');
      src = `var __jsra_dirname = globalThis.__JSRA_PW_LIB ? require("path").join(globalThis.__JSRA_PW_LIB, "..", ${JSON.stringify(rel)}) : require("path").join(require("path").dirname(process.execPath), "resources", "patchright-core", "lib", ${JSON.stringify(rel)});\n` + src;
      return { contents: src, loader: 'js' };
    });
  },
};

const entry = path.join(SC, '.entry.mjs');
fs.writeFileSync(entry, `import zipPath from './.pw-res.zip' with { type: 'file' };\nglobalThis.__JSRA_PW_ZIP = zipPath; globalThis.__JSRA_PW_VERSION = ${JSON.stringify(pwPkg.version)};\nawait import('./index.mjs');\n`);

const which = process.argv[2] || 'all';
const targets = [];
if (which === 'all' || which === 'win') targets.push(['bun-windows-x64', 'jsra-sidecar.exe']);
if (which === 'all' || which === 'linux') targets.push(['bun-linux-x64', 'jsra-sidecar-linux']);
for (const [target, name] of targets) {
  const r = await Bun.build({
    entrypoints: [entry], compile: { target, outfile: path.join(OUT, name) }, minify: { syntax: true, whitespace: true },
    external: ['chromium-bidi', 'chromium-bidi/*', '/bundled/*', 'isolated-vm', 'electron', 'fsevents', 'jsdom', 'jsdom/*'], plugins: [pwPlugin], define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!r.success) { console.error(r.logs); process.exit(1); }
  console.log('built', name, (fs.statSync(path.join(OUT, name)).size / 1e6).toFixed(1) + 'MB');
}
// 发布检查：exe 内不得出现构建机路径
for (const [, name] of targets) {
  const buf = fs.readFileSync(path.join(OUT, name));
  for (const bad of [ROOT, ROOT.replace(/\//g, '\\\\')]) if (buf.includes(bad)) { console.error('✖ 产物中仍包含构建机路径: ' + bad + ' in ' + name); process.exit(2); }
}
console.log('✓ 产物不含构建机路径');
