// VMP：自动检测解释器 + AST 改写插桩（Fetch.requestPaused）+ 轨迹 diff + CDP 日志断点
import fs from 'node:fs';
import path from 'node:path';

const INSTALL = (opts) => `(() => {
  const o = ${JSON.stringify(opts)};
  if (window.__jsra_vmp && !o.force) return { ok: true, already: true, n: window.__jsra_vmp.trace.length };
  const T = { trace: [], n: 0, max: o.maxEvents || 5000, sample: o.sampleEvery || 1, enabled: true,
    counts: { op: 0, call: 0, get: 0, set: 0, opcode: 0, reg: 0, stack: 0 }, start: Date.now() };
  const push = (rec) => {
    if (!T.enabled) return;
    T.n++; if (T.n % T.sample) return;
    if (T.trace.length >= T.max) { if (!T.truncated) T.trace.push({ t: 'meta', m: 'truncated' }); T.truncated = true; return; }
    T.trace.push(rec); T.counts[rec.t] = (T.counts[rec.t] || 0) + 1;
  };
  const resolve = (path) => { try { return path.split('.').reduce((a, k) => a?.[k], window); } catch { return null; } };
  const targets = (o.targets || ['Interpreter', 'VM', 'vm', '__vm', 'DiyVm', 'virtualMachine']).map(resolve).filter(Boolean);
  const wrapFn = (obj, key, kind) => {
    const orig = obj[key]; if (typeof orig !== 'function' || orig.__jsra_vmp) return;
    const wrapped = function(...args) {
      const t0 = performance.now();
      if (kind === 'op') push({ t: 'op', fn: key, args: args.slice(0, 3).map(a => typeof a === 'number' ? a : typeof a), ts: t0 });
      if (kind === 'call') push({ t: 'call', fn: key, n: args.length, ts: t0 });
      try { return orig.apply(this, args); } finally {}
    };
    wrapped.__jsra_vmp = true; try { Object.defineProperty(wrapped, 'name', { value: orig.name }); } catch {}
    obj[key] = wrapped;
  };
  let hooked = 0;
  for (const obj of targets) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (/^(step|run|execute|dispatch|handle|interpret|evalOp|next|loop|tick)$/i.test(key)) { wrapFn(obj, key, 'op'); hooked++; }
      else if (/^(call|invoke|apply|new)$/i.test(key)) { wrapFn(obj, key, 'call'); hooked++; }
    }
    if (obj.prototype) {
      for (const key of Object.getOwnPropertyNames(obj.prototype)) {
        if (/^(step|run|execute|dispatch|handle)$/i.test(key)) { wrapFn(obj.prototype, key, 'op'); hooked++; }
      }
    }
  }
  for (const gp of (o.watchGlobals || [])) {
    try {
      let base = window; const parts = gp.split('.'); const last = parts.pop();
      for (const p of parts) base = base[p];
      let val = base[last];
      Object.defineProperty(base, last, {
        configurable: true, enumerable: true,
        get() { push({ t: 'get', k: gp }); return val; },
        set(v) { push({ t: 'set', k: gp, v: typeof v }); val = v; },
      });
      hooked++;
    } catch {}
  }
  // 供 AST 改写脚本调用的全局日志 API
  window.__jsra_vmp_log = function(kind, a, b, c) {
    push({ t: kind || 'opcode', a, b: typeof b === 'object' ? undefined : b, c: typeof c === 'number' ? c : undefined, ts: performance.now() });
  };
  window.__jsra_vmp = T;
  return { ok: true, hooked, targets: targets.length };
})()`;

async function babel() {
  const [parser, traverseM, generateM, tM] = await Promise.all([
    import('@babel/parser'), import('@babel/traverse'), import('@babel/generator'), import('@babel/types')]);
  return {
    parse: parser.parse,
    traverse: traverseM.default?.default || traverseM.default || traverseM,
    generate: generateM.default?.default || generateM.default || generateM,
    t: tM.default || tM,
  };
}

/** AST 扫描：大 switch/while 分发环、字节码字符串数组、高调用候选 */
async function detectInterpreter(code) {
  const b = await babel();
  let ast;
  let parseErr = null;
  try { ast = b.parse(code, { sourceType: 'unambiguous', errorRecovery: true, tokens: false }); }
  catch (e) { parseErr = e.message; }
  // 解析失败时仍做源码启发式（真实抓包脚本常有截断/非法字符串）
  if (!ast) {
    const candidates = [];
    const hex = (code.match(/_0x[a-f0-9]{4,}/gi) || []);
    const hexSet = new Set(hex);
    if (hexSet.size >= 50) candidates.push({ kind: 'obfuscator-hex', name: '_0x*', size: hexSet.size, score: Math.min(hexSet.size, 500), loc: 0 });
    const sw = (code.match(/switch\s*\(/g) || []).length;
    if (sw >= 3) candidates.push({ kind: 'large-switch', name: '(source-scan)', cases: sw, score: sw * 5, loc: 0 });
    const bc = (code.match(/\[[\s\n]*["'][\\x0-9a-f]{2,}/gi) || []).length;
    if (bc >= 20) candidates.push({ kind: 'bytecode-array', name: '(source-scan)', size: bc, score: bc, loc: 0 });
    candidates.sort((a, b) => b.score - a.score);
    return { ok: candidates.length > 0, error: parseErr, candidates: candidates.slice(0, 20), top: candidates[0] || null, parseFallback: true };
  }
  const { t } = b;
  const candidates = [];
  b.traverse(ast, {
    WhileStatement(p) {
      const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
      const sw = body.find(s => t.isSwitchStatement(s));
      if (!sw) return;
      const nCases = sw.cases?.length || 0;
      if (nCases < 6) return;
      const fn = p.findParent(x => x.isFunctionDeclaration() || x.isFunctionExpression() || x.isArrowFunctionExpression());
      const name = fn?.node?.id?.name || fn?.parent?.id?.name || '(anon-while-switch)';
      candidates.push({ kind: 'dispatch-loop', name, cases: nCases, loc: p.node.loc?.start?.line || 0, score: nCases * 2 });
    },
    SwitchStatement(p) {
      const nCases = p.node.cases?.length || 0;
      if (nCases < 6) return;
      // 不在 while 内的大 switch 也记
      const parentWhile = p.findParent(x => x.isWhileStatement() || x.isForStatement() || x.isDoWhileStatement());
      if (parentWhile) return; // 已由 WhileStatement 覆盖
      const fn = p.findParent(x => x.isFunctionDeclaration() || x.isFunctionExpression());
      candidates.push({ kind: 'large-switch', name: fn?.node?.id?.name || '(anon-switch)', cases: nCases, loc: p.node.loc?.start?.line || 0, score: nCases });
    },
    VariableDeclarator(p) {
      const init = p.node.init;
      if (!t.isArrayExpression(init) || init.elements.length < 40) return;
      const strN = init.elements.filter(e => e && t.isStringLiteral(e)).length;
      if (strN < 30) return;
      candidates.push({ kind: 'bytecode-array', name: p.node.id?.name || '?', size: init.elements.length, strings: strN, loc: p.node.loc?.start?.line || 0, score: strN });
    },
  });
  // 混淆密度：大量 _0x 标识符（obfuscator.io / 部分 JSVMP 壳）
  const hexIds = new Set();
  b.traverse(ast, { Identifier(p) { if (/^_0x[a-f0-9]{4,}$/i.test(p.node.name)) hexIds.add(p.node.name); } });
  if (hexIds.size >= 50) {
    candidates.push({ kind: 'obfuscator-hex', name: '_0x*', size: hexIds.size, score: Math.min(hexIds.size, 500), loc: 0 });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { ok: true, candidates: candidates.slice(0, 20), top: candidates[0] || null };
}

/** AST 改写：在 dispatch switch 的每个 case 入口插入 __jsra_vmp_log('opcode', caseValue, pc?) */
async function instrumentScript(code, opts = {}) {
  const b = await babel();
  let ast;
  try { ast = b.parse(code, { sourceType: 'unambiguous', errorRecovery: true }); }
  catch (e) { return { ok: false, error: e.message, code }; }
  const { t } = b;
  let injected = 0;
  const logId = t.identifier('__jsra_vmp_log');
  const instrumentSwitch = (sw) => {
    if (!sw || (sw.cases?.length || 0) < 8) return;
    for (const c of sw.cases) {
      if (!c.test) continue;
      if (c.consequent.length && t.isExpressionStatement(c.consequent[0]) &&
          t.isCallExpression(c.consequent[0].expression) &&
          t.isIdentifier(c.consequent[0].expression.callee, { name: '__jsra_vmp_log' })) continue;
      const testCode = t.isNumericLiteral(c.test) ? c.test.value
        : t.isStringLiteral(c.test) ? c.test.value
        : t.isIdentifier(c.test) ? c.test.name : '?';
      const call = t.expressionStatement(t.callExpression(logId, [
        t.stringLiteral('opcode'),
        typeof testCode === 'number' ? t.numericLiteral(testCode) : t.stringLiteral(String(testCode)),
      ]));
      c.consequent.unshift(call);
      injected++;
    }
  };
  b.traverse(ast, {
    WhileStatement(p) {
      const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
      const sw = body.find(s => t.isSwitchStatement(s));
      instrumentSwitch(sw);
    },
    SwitchStatement(p) {
      // 独立大 switch（如 step(op){ switch(op){...} }）
      if ((p.node.cases?.length || 0) >= 8) instrumentSwitch(p.node);
    },
  });
  // 可选：对看起来像寄存器/栈的数组 push/pop 插桩
  if (opts.regs !== false) {
    b.traverse(ast, {
      CallExpression(p) {
        if (!t.isMemberExpression(p.node.callee)) return;
        const prop = t.isIdentifier(p.node.callee.property) ? p.node.callee.property.name
          : t.isStringLiteral(p.node.callee.property) ? p.node.callee.property.value : '';
        if (!/^(push|pop|shift|unshift)$/.test(prop)) return;
        const obj = p.node.callee.object;
        const objName = t.isIdentifier(obj) ? obj.name : '';
        if (!/^(stack|stk|reg|regs|registers|vmstack|_s|_r)$/i.test(objName)) return;
        // 包一层：先 log 再调用 — 用 sequence 较难；改在语句前插
        const stmt = p.findParent(x => x.isExpressionStatement());
        if (!stmt || stmt.node._jsra) return;
        const call = t.expressionStatement(t.callExpression(logId, [
          t.stringLiteral(prop === 'push' || prop === 'unshift' ? 'stack' : 'stack'),
          t.stringLiteral(objName + '.' + prop),
        ]));
        call._jsra = true;
        try { stmt.insertBefore(call); injected++; } catch {}
      },
    });
  }
  const out = b.generate(ast, { comments: false, compact: false }).code;
  // 前置：确保全局 log 存在
  const prelude = `typeof __jsra_vmp_log==="function"||(self.__jsra_vmp_log=function(k,a,b,c){try{var T=self.__jsra_vmp;if(!T){self.__jsra_vmp={trace:[],n:0,max:8000,sample:1,enabled:true,counts:{},start:Date.now()};T=self.__jsra_vmp;}T.n++;if(T.trace.length<T.max){T.trace.push({t:k,a:a,b:b,c:c,ts:performance.now()});T.counts[k]=(T.counts[k]||0)+1;}}catch(e){}});\n`;
  return { ok: true, code: prelude + out, injected, bytes: out.length };
}

async function vmpDetect(a, ctx) {
  let code = a.code || '';
  if (!code && a.source) {
    const p = path.isAbsolute(a.source) ? a.source : path.join(ctx.projectDir, a.source);
    code = fs.readFileSync(p, 'utf8');
  }
  if (!code && a.urlPattern) {
    // 从抓包 scripts 里找
    const scripts = (ctx.browser?.net?.records || []).filter(r => /javascript|ecmascript|\.js(\?|$)/i.test(r.mimeType || r.url || '') && new RegExp(a.urlPattern).test(r.url));
    if (scripts[0]?.bodyPath) code = fs.readFileSync(scripts[0].bodyPath, 'utf8');
    else if (scripts[0]?.body) code = scripts[0].body;
  }
  if (!code) return { text: '需要 code / source / urlPattern', isError: true };
  const det = await detectInterpreter(code);
  // 可选 CDP Profiler 热点
  let profileHint = null;
  if (a.profile && ctx.browser?.context) {
    const page = ctx.browser.activePage || ctx.browser.pages[0];
    try {
      const cdp = await ctx.browser.context.newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      await page.waitForTimeout?.(800).catch(() => new Promise(r => setTimeout(r, 800)));
      const { profile } = await cdp.send('Profiler.stop');
      await cdp.detach().catch(() => {});
      const nodes = (profile?.nodes || []).map(n => ({
        name: n.callFrame?.functionName || '(anon)',
        url: n.callFrame?.url || '',
        line: n.callFrame?.lineNumber,
        hit: n.hitCount || 0,
      })).filter(n => n.hit > 50).sort((x, y) => y.hit - x.hit).slice(0, 15);
      profileHint = nodes;
      for (const n of nodes) {
        if (/step|dispatch|interpret|execute|vm|opcode/i.test(n.name)) {
          det.candidates.unshift({ kind: 'profiler-hot', name: n.name, hits: n.hit, loc: n.line, score: n.hit, url: n.url });
        }
      }
    } catch (e) { profileHint = { error: e.message }; }
  }
  const file = a.outputFile ? path.join(ctx.projectDir, a.outputFile) : path.join(ctx.projectDir, `vmp-detect-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ det, profileHint }, null, 2));
  return { text: `VMP 解释器检测：${det.candidates.length} 候选。Top=${JSON.stringify(det.top)}\n全部：\n` + det.candidates.slice(0, 10).map(c => `  [${c.kind}] ${c.name} score=${c.score} loc=${c.loc}`).join('\n') + `\n已保存 ${path.relative(ctx.projectDir, file)}` + (profileHint && !profileHint.error ? `\nProfiler 热点 ${profileHint.length} 个` : '') };
}

async function vmpInstrument(a, ctx) {
  let code = a.code || '';
  if (!code && a.source) {
    const p = path.isAbsolute(a.source) ? a.source : path.join(ctx.projectDir, a.source);
    code = fs.readFileSync(p, 'utf8');
  }
  if (!code) return { text: '需要 code 或 source', isError: true };
  const r = await instrumentScript(code, { regs: a.regs !== false });
  if (!r.ok) return { text: '插桩失败：' + r.error, isError: true };
  const out = a.outputFile || `vmp-instrumented-${Date.now()}.js`;
  const fp = path.join(ctx.projectDir, out);
  fs.writeFileSync(fp, r.code);
  return { text: `AST 插桩完成：注入 ${r.injected} 处日志，${r.bytes} 字节 → ${out}。配合 vmp_trace_fetch_hook 可在页面加载时替换响应。` };
}

async function vmpFetchHook(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  const pattern = a.urlPattern || '\\.js(\\?|$)';
  let replacement = a.code || '';
  if (!replacement && a.source) {
    const p = path.isAbsolute(a.source) ? a.source : path.join(ctx.projectDir, a.source);
    replacement = fs.readFileSync(p, 'utf8');
  }
  const auto = a.autoInstrument !== false;
  // 确保 log API 已在页面
  ctx.browser.injector.register('vmp-log', INSTALL({ force: false, maxEvents: a.maxEvents || 8000 }));
  await ctx.browser.injector.armAll().catch(() => {});

  // 拆除旧 hook
  if (ctx.browser._vmpFetchHandler) {
    try { await ctx.browser._vmpCdp?.send('Fetch.disable'); } catch {}
    try { await ctx.browser._vmpCdp?.detach(); } catch {}
  }
  const cdp = await ctx.browser.context.newCDPSession(page);
  ctx.browser._vmpCdp = cdp;
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Script', requestStage: 'Response' }] });
  const re = new RegExp(pattern);
  let replaced = 0;
  const handler = async (ev) => {
    const { requestId, request, responseStatusCode } = ev;
    try {
      if (!re.test(request.url)) {
        await cdp.send('Fetch.continueRequest', { requestId });
        return;
      }
      const bodyRet = await cdp.send('Fetch.getResponseBody', { requestId });
      let body = bodyRet.base64Encoded ? Buffer.from(bodyRet.body, 'base64').toString('utf8') : bodyRet.body;
      if (replacement) {
        body = replacement;
      } else if (auto && body.length > 500 && body.length < 5_000_000) {
        const det = await detectInterpreter(body);
        if (det.top && det.top.score >= 16) {
          const inst = await instrumentScript(body);
          if (inst.ok && inst.injected > 0) { body = inst.code; replaced++; }
        }
      }
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: responseStatusCode || 200,
        responseHeaders: (ev.responseHeaders || []).filter(h => !/^content-encoding$/i.test(h.name)),
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
    } catch {
      try { await cdp.send('Fetch.continueRequest', { requestId }); } catch {}
    }
  };
  cdp.on('Fetch.requestPaused', handler);
  ctx.browser._vmpFetchHandler = handler;
  return { text: `Fetch 脚本替换已启用（urlPattern=/${pattern}/，autoInstrument=${auto}）。导航或刷新后匹配脚本会被 AST 插桩。当前已替换 ${replaced}。用 vmp_trace_dump 看轨迹。` };
}

async function vmpInstall(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  const src = INSTALL({
    targets: a.targets, maxEvents: a.maxEvents || 5000, sampleEvery: a.sampleEvery || 1,
    watchGlobals: a.watchGlobals || [], force: !!a.force,
  });
  ctx.browser.injector.register('vmp', src);
  await ctx.browser.injector.armAll().catch(() => {});
  const r = await page.evaluate(src);
  return { text: `VMP 插桩已安装：钩住 ${r.hooked} 个方法，目标对象 ${r.targets} 个${r.already ? '（已存在）' : ''}。可用 vmp_trace_detect / vmp_trace_fetch_hook 做自动检测与 AST 改写。` };
}

async function vmpDump(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  const data = await page.evaluate((clear) => {
    const T = window.__jsra_vmp; if (!T) return null;
    const out = { n: T.n, counts: T.counts, sample: T.sample, max: T.max, ms: Date.now() - T.start, trace: T.trace.slice(-((typeof clear === 'number' ? clear : 0) || T.trace.length)) };
    if (clear === true) T.trace = [];
    return out;
  }, a.clear === false ? (a.limit || 0) : true).catch(() => null);
  if (!data) return { text: '尚未安装插桩，先 vmp_trace_install 或 vmp_trace_fetch_hook', isError: true };
  let saved = '';
  if (a.file || a.save !== false) {
    const f = path.join(ctx.projectDir, a.file || `vmp-trace-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
    saved = ' 已保存 ' + path.relative(ctx.projectDir, f) + `（${fs.statSync(f).size} 字节）`;
  }
  const preview = data.trace.slice(0, 15).map(t => JSON.stringify(t)).join('\n');
  return { text: `轨迹：采样 ${data.trace.length}/${data.n} 事件，${data.ms}ms，计数 ${JSON.stringify(data.counts)}。${saved}\n预览：\n${preview || '（空）'}` };
}

async function vmpStatus(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  const s = await page.evaluate(() => window.__jsra_vmp ? { n: window.__jsra_vmp.n, len: window.__jsra_vmp.trace.length, counts: window.__jsra_vmp.counts, enabled: window.__jsra_vmp.enabled } : null);
  return { text: s ? `VMP 插桩运行中：总事件 ${s.n}，缓冲 ${s.len}，${JSON.stringify(s.counts)}` : '未安装' };
}

/** 对齐两条轨迹，找首个分歧（知乎破解关键） */
function alignTraces(a, b, keyFn) {
  const ka = a.map(keyFn); const kb = b.map(keyFn);
  let i = 0, j = 0;
  const matched = [];
  while (i < ka.length && j < kb.length) {
    if (ka[i] === kb[j]) { matched.push({ i, j, k: ka[i] }); i++; j++; continue; }
    // 向前看 8
    let found = false;
    for (let d = 1; d <= 8; d++) {
      if (i + d < ka.length && ka[i + d] === kb[j]) { i += d; found = true; break; }
      if (j + d < kb.length && ka[i] === kb[j + d]) { j += d; found = true; break; }
    }
    if (!found) {
      return {
        ok: false,
        firstDivergence: { indexA: i, indexB: j, a: a[i], b: b[j], keyA: ka[i], keyB: kb[j] },
        matched: matched.length, lenA: a.length, lenB: b.length,
      };
    }
  }
  return { ok: true, matched: matched.length, lenA: a.length, lenB: b.length, exhausted: i >= ka.length && j >= kb.length };
}

async function vmpDiff(a, ctx) {
  const load = (f) => {
    const p = path.isAbsolute(f) ? f : path.join(ctx.projectDir, f);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j.trace || j;
  };
  if (!a.pageTrace || !a.nodeTrace) return { text: '需要 pageTrace 与 nodeTrace 文件路径', isError: true };
  const A = load(a.pageTrace); const B = load(a.nodeTrace);
  const keyFn = (rec) => {
    if (!rec || typeof rec !== 'object') return String(rec);
    return [rec.t || rec.type || '', rec.a ?? rec.fn ?? rec.op ?? '', rec.b ?? '', rec.c ?? ''].join('|');
  };
  const r = alignTraces(A, B, keyFn);
  const out = path.join(ctx.projectDir, a.outputFile || `vmp-diff-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(r, null, 2));
  if (r.ok) return { text: `轨迹一致：对齐 ${r.matched} 步（A=${r.lenA} B=${r.lenB}）。已保存 ${path.relative(ctx.projectDir, out)}` };
  const d = r.firstDivergence;
  return { text: `首个分歧 @ A[${d.indexA}] vs B[${d.indexB}]（已对齐 ${r.matched} 步）\n  page: ${JSON.stringify(d.a)}\n  node: ${JSON.stringify(d.b)}\n  keyA=${d.keyA}\n  keyB=${d.keyB}\n已保存 ${path.relative(ctx.projectDir, out)}` };
}

/** CDP 条件断点：只 log 不暂停 */
async function vmpLogBreakpoint(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  if (!a.url && a.url !== '' || a.line == null) {
    // allow url empty for current
  }
  if (a.line == null) return { text: '需要 line（1-based）与可选 url/expression', isError: true };
  const cdp = await ctx.browser.context.newCDPSession(page);
  await cdp.send('Debugger.enable');
  const url = a.url || page.url();
  const expr = a.expression || '""';
  // 条件：求值并 console，永远返回 false → 不暂停
  const condition = `(() => { try { console.log('[jsra-logbp]', ${expr}); } catch (e) { console.log('[jsra-logbp-err]', e && e.message); } return false; })()`;
  const { breakpointId } = await cdp.send('Debugger.setBreakpointByUrl', {
    lineNumber: Math.max(0, (a.line | 0) - 1),
    urlRegex: a.urlRegex || url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 200),
    condition,
  });
  ctx.browser._logBreakpoints = ctx.browser._logBreakpoints || [];
  ctx.browser._logBreakpoints.push({ breakpointId, url, line: a.line, expression: expr });
  // 保持 session（不断开，否则断点可能丢）
  ctx.browser._logBpCdp = cdp;
  return { text: `日志断点已设：line=${a.line} url≈${url.slice(0, 80)} expr=${expr} id=${breakpointId}。命中时 console 打印且不暂停。` };
}

export const VMP_TOOLS = [
  { name: 'vmp_trace_install', description: '【VMP 插桩】挂钩解释器循环（step/run/execute/dispatch）与可选全局读写。配合 inject 持久化。', schema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, watchGlobals: { type: 'array', items: { type: 'string' } }, sampleEvery: { type: 'number' }, maxEvents: { type: 'number' }, force: { type: 'boolean' } } }, run: vmpInstall },
  { name: 'vmp_trace_detect', description: '【VMP 自动检测】AST 扫描大 switch/while 分发环、字节码字符串数组；可选 CDP Profiler 热点。入参 code/source/urlPattern；profile=true 开采样。', schema: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' }, urlPattern: { type: 'string' }, profile: { type: 'boolean' }, outputFile: { type: 'string' } } }, run: vmpDetect },
  { name: 'vmp_trace_instrument', description: '【VMP AST 插桩】改写脚本：在 dispatch case 入口与 stack/reg 操作插入 __jsra_vmp_log。输出插桩后 JS。', schema: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' }, outputFile: { type: 'string' }, regs: { type: 'boolean' } } }, run: vmpInstrument },
  { name: 'vmp_trace_fetch_hook', description: '【VMP Fetch 替换】Fetch.requestPaused 拦截 Script 响应，按 urlPattern 自动 AST 插桩或替换为 source 文件。刷新页面后生效。', schema: { type: 'object', properties: { urlPattern: { type: 'string' }, source: { type: 'string' }, code: { type: 'string' }, autoInstrument: { type: 'boolean' }, maxEvents: { type: 'number' } } }, run: vmpFetchHook },
  { name: 'vmp_trace_dump', description: '导出 VMP 轨迹 JSON。', schema: { type: 'object', properties: { file: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'number' }, save: { type: 'boolean' } } }, run: vmpDump },
  { name: 'vmp_trace_status', description: '查看 VMP 插桩状态。', schema: { type: 'object', properties: {} }, run: vmpStatus },
  { name: 'vmp_trace_diff', description: '【轨迹差分】对齐 pageTrace 与 nodeTrace，报告首个分歧（知乎 x-zse-96 关键手法）。', schema: { type: 'object', properties: { pageTrace: { type: 'string' }, nodeTrace: { type: 'string' }, outputFile: { type: 'string' } }, required: ['pageTrace', 'nodeTrace'] }, run: vmpDiff },
  { name: 'vmp_log_breakpoint', description: '【日志断点】CDP 条件断点：求值 expression 并 console.log，条件恒 false 不暂停。line 为 1-based。', schema: { type: 'object', properties: { line: { type: 'number' }, url: { type: 'string' }, urlRegex: { type: 'string' }, expression: { type: 'string' } }, required: ['line'] }, run: vmpLogBreakpoint },
];
