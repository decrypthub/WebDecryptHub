// 反调试绕过：CDP 禁用断点 + 注入钩子（debugger 死循环、devtools 检测、toString、console 时序、outerWidth）
const HOOK = `(() => {
  if (window.__jsra_antidebug) return 'already';
  window.__jsra_antidebug = { hits: [], enabled: true };
  const log = (k, d) => { try { window.__jsra_antidebug.hits.push({ t: Date.now(), k, d: String(d).slice(0, 200) }); if (window.__jsra_antidebug.hits.length > 200) window.__jsra_antidebug.hits.shift(); } catch {} };
  // 1) Function/eval 中的 debugger 语句：重写构造器，剥掉 debugger
  const strip = s => String(s).replace(/\\bdebugger\\b/g, 'void 0');
  const wrapFn = Orig => {
    function F(...args) {
      if (!window.__jsra_antidebug.enabled) return new Orig(...args);
      if (args.length) args[args.length - 1] = strip(args[args.length - 1]);
      log('Function', args[args.length - 1]?.slice?.(0, 80));
      return new Orig(...args);
    }
    F.prototype = Orig.prototype; Object.defineProperty(F, 'name', { value: 'Function' });
    try { F.toString = () => 'function Function() { [native code] }'; } catch {}
    return F;
  };
  try { window.Function = wrapFn(window.Function); } catch {}
  const _eval = window.eval;
  try { window.eval = function(s) { if (window.__jsra_antidebug.enabled) { log('eval', s); s = strip(s); } return _eval(s); }; window.eval.toString = () => 'function eval() { [native code] }'; } catch {}
  // 2) console 时序检测：clear/profile/table 等被重写为空操作的变体
  const c = window.console || {};
  for (const k of ['clear', 'profile', 'profileEnd', 'table', 'log', 'debug', 'info', 'warn', 'error']) {
    try { const orig = c[k] && c[k].bind(c); c[k] = function(...a) { log('console.'+k, a[0]); return orig ? orig(...a) : undefined; }; } catch {}
  }
  // 3) outerWidth/outerHeight 差：固定为 inner+chrome 模拟
  try {
    const iw = () => window.innerWidth, ih = () => window.innerHeight;
    Object.defineProperty(window, 'outerWidth', { configurable: true, get() { log('outerWidth'); return iw() + 8; } });
    Object.defineProperty(window, 'outerHeight', { configurable: true, get() { log('outerHeight'); return ih() + 88; } });
  } catch {}
  // 4) devtools 元素检测：保持 console 里没有 id 探测元素
  try {
    const el = new Image(); Object.defineProperty(el, 'id', { get() { log('devtools-element'); return 'jsra'; } });
  } catch {}
  // 5) Function.prototype.toString：对钩子过的函数返回 native code（已在上面处理 Function/eval）
  const _ts = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (window.__jsra_antidebug.enabled && (this === window.Function || this === window.eval || this === Function.prototype.toString)) {
      log('toString', this.name); return 'function ' + (this.name || '') + '() { [native code] }';
    }
    return _ts.call(this);
  };
  return 'armed';
})()`;

async function ensureCdp(ctx) {
  const b = ctx.browser; const page = b.activePage || b.pages[0];
  if (!page) throw new Error('无活动页面');
  if (!b._antiCdp || b._antiCdpPage !== page) {
    try { await b._antiCdp?.detach?.(); } catch {}
    b._antiCdp = await b.context.newCDPSession(page);
    b._antiCdpPage = page;
  }
  return { cdp: b._antiCdp, page };
}

async function antiDebugEnable(a, ctx) {
  const { cdp, page } = await ensureCdp(ctx);
  await cdp.send('Debugger.enable').catch(() => {});
  await cdp.send('Debugger.setBreakpointsActive', { active: false }).catch(() => {});
  // 持久注入：Injector 负责导航/弹窗/iframe/worker 再武装
  const inj = ctx.browser.injector;
  inj.register('anti-debug', HOOK);
  const arm = await inj.armAll().catch(e => ({ ok: false, error: e.message }));
  const r = await page.evaluate(HOOK).catch(e => 'inject-fail: ' + e.message);
  ctx.browser._antiDebug = true;
  const st = await inj.status(page);
  return { text: `反调试已启用：CDP breakpoints inactive + 持久钩子（当前页 ${r}；armAll pages=${arm.pages||0}；页面内 registered=${JSON.stringify(st.registered||st.registeredHere)}）。可绕过：debugger 死循环、Function/eval、console 时序、outerWidth、toString。用 anti_debug_status / inject_status 复查。` };
}
async function antiDebugDisable(a, ctx) {
  const { cdp, page } = await ensureCdp(ctx);
  await cdp.send('Debugger.setBreakpointsActive', { active: true }).catch(() => {});
  await page.evaluate(() => { if (window.__jsra_antidebug) window.__jsra_antidebug.enabled = false; }).catch(() => {});
  ctx.browser._antiDebug = false;
  return { text: '反调试已关闭（断点重新激活，钩子进入旁路）。' };
}
async function antiDebugStatus(a, ctx) {
  const page = ctx.browser.activePage || ctx.browser.pages[0];
  if (!page) return { text: '无页面', isError: true };
  const st = await page.evaluate(() => window.__jsra_antidebug || null).catch(() => null);
  const inj = await ctx.browser.injector.status(page).catch(() => null);
  if (!st) return { text: '钩子未注入。调用 anti_debug_enable。\ninject_status: ' + JSON.stringify(inj) };
  const by = {}; for (const h of st.hits || []) by[h.k] = (by[h.k] || 0) + 1;
  return { text: `反调试 ${st.enabled ? '启用中' : '旁路'}；命中 ${st.hits.length} 次：` + JSON.stringify(by) + '\n注入状态 registered=' + JSON.stringify(inj?.registered||inj?.registeredHere) + '\n最近：\n' + (st.hits.slice(-10).map(h => `  ${h.k}: ${h.d}`).join('\n') || '（无）') };
}

export const ANTIDEBUG_TOOLS = [
  { name: 'anti_debug_enable', description: '启用反调试绕过：CDP 停用断点 + 注入钩子，中和 debugger 死循环、Function/eval 中的 debugger、DevTools 打开检测、Function.toString 校验、console 时序检测、outerWidth/outerHeight 差检测。设置里也可默认开启。', schema: { type: 'object', properties: {} }, run: antiDebugEnable },
  { name: 'anti_debug_disable', description: '关闭反调试绕过。', schema: { type: 'object', properties: {} }, run: antiDebugDisable },
  { name: 'anti_debug_status', description: '查看反调试钩子状态与命中统计（站点触发了哪些检测）。', schema: { type: 'object', properties: {} }, run: antiDebugStatus },
];
export { HOOK as ANTIDEBUG_HOOK };
