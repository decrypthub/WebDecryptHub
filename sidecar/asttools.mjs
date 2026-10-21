// AST 反混淆（babel）：字符串数组解码、控制流平坦化、常量折叠、死代码消除、重命名、美化。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let B = null;
async function babel() {
  if (B) return B;
  const [parser, traverseM, generateM, tM] = await Promise.all([
    import('@babel/parser'), import('@babel/traverse'), import('@babel/generator'), import('@babel/types')]);
  B = {
    parse: parser.parse,
    traverse: traverseM.default?.default || traverseM.default || traverseM,
    generate: generateM.default?.default || generateM.default || generateM,
    t: tM.default || tM,
  };
  return B;
}
function readSrc(ctx, a) {
  let code = a.code || '';
  if (!code && a.source) { const p = path.isAbsolute(a.source) ? a.source : path.join(ctx.projectDir, a.source); code = fs.readFileSync(p, 'utf8'); }
  if (!code) throw new Error('需要 code 或 source');
  return code;
}

function constantFold(ast, b) {
  const { t } = b; let n = 0;
  b.traverse(ast, {
    BinaryExpression: { exit(p) {
      const { left, right, operator } = p.node;
      try {
        if (t.isNumericLiteral(left) && t.isNumericLiteral(right) && ['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>', '>>>'].includes(operator)) {
          const v = Function(`return (${left.value}${operator}${right.value})`)();
          if (typeof v === 'number' && isFinite(v)) { p.replaceWith(t.numericLiteral(v)); n++; }
        } else if (operator === '+' && t.isStringLiteral(left) && t.isStringLiteral(right)) { p.replaceWith(t.stringLiteral(left.value + right.value)); n++; }
      } catch {}
    }},
    UnaryExpression: { exit(p) {
      if (p.node.operator === '!' && t.isBooleanLiteral(p.node.argument)) { p.replaceWith(t.booleanLiteral(!p.node.argument.value)); n++; }
      else if (p.node.operator === '-' && t.isNumericLiteral(p.node.argument)) { p.replaceWith(t.numericLiteral(-p.node.argument.value)); n++; }
    }},
    MemberExpression(p) {
      if (p.node.computed && t.isStringLiteral(p.node.property) && /^[A-Za-z_$][\w$]*$/.test(p.node.property.value)) {
        p.node.property = t.identifier(p.node.property.value); p.node.computed = false; n++;
      }
    },
  });
  return n;
}

function unflatten(ast, b, log) {
  const { t } = b; let fixed = 0;
  const orders = new Map();
  b.traverse(ast, { VariableDeclarator(p) {
    const init = p.node.init;
    if (t.isCallExpression(init) && t.isMemberExpression(init.callee) && t.isStringLiteral(init.callee.object)
      && (t.isIdentifier(init.callee.property, { name: 'split' }) || t.isStringLiteral(init.callee.property, { value: 'split' }))
      && t.isIdentifier(p.node.id)) {
      const sep = init.arguments[0] && t.isStringLiteral(init.arguments[0]) ? init.arguments[0].value : '|';
      orders.set(p.node.id.name, init.callee.object.value.split(sep));
    }
  }});
  if (!orders.size) return 0;
  b.traverse(ast, { WhileStatement(p) {
    const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
    const sw = body.find(s => t.isSwitchStatement(s)); if (!sw) return;
    let arrName = null;
    if (t.isMemberExpression(sw.discriminant) && t.isIdentifier(sw.discriminant.object)) arrName = sw.discriminant.object.name;
    if (!arrName || !orders.has(arrName)) return;
    const order = orders.get(arrName);
    const cases = new Map();
    for (const c of sw.cases) {
      if (!c.test) continue;
      const key = t.isStringLiteral(c.test) || t.isNumericLiteral(c.test) ? String(c.test.value) : null;
      if (key == null) continue;
      cases.set(key, c.consequent.filter(s => !t.isContinueStatement(s) && !(t.isBreakStatement(s) && !s.label)));
    }
    const linear = [];
    for (const idx of order) { const cs = cases.get(String(idx)); if (cs) for (const s of cs) linear.push(t.cloneNode(s)); }
    if (linear.length < 2) return;
    p.replaceWithMultiple(linear); fixed++;
  }});
  if (fixed) log(`控制流平坦化：还原 ${fixed} 处`);
  return fixed;
}

function deadCode(ast, b) {
  const { t } = b; let n = 0;
  b.traverse(ast, {
    IfStatement(p) {
      if (t.isBooleanLiteral(p.node.test) || t.isNumericLiteral(p.node.test)) {
        const keep = p.node.test.value ? p.node.consequent : p.node.alternate;
        if (keep) p.replaceWith(keep); else p.remove(); n++;
      }
    },
    ConditionalExpression(p) {
      if (t.isBooleanLiteral(p.node.test) || t.isNumericLiteral(p.node.test)) {
        p.replaceWith(p.node.test.value ? p.node.consequent : p.node.alternate); n++;
      }
    },
  });
  return n;
}

function rename(ast, b) {
  let n = 0;
  b.traverse(ast, { Scope(p) {
    for (const name of Object.keys(p.scope.bindings)) {
      if (!/^_0x[0-9a-f]+$/i.test(name)) continue;
      const bnd = p.scope.bindings[name];
      const kind = bnd.path.isFunctionDeclaration() || bnd.path.node?.init?.type === 'FunctionExpression' ? 'f' : bnd.kind === 'param' ? 'p' : 'v';
      let nn, i = 0; do { nn = kind + (++n); } while (p.scope.hasBinding(nn) && i++ < 9999);
      try { p.scope.rename(name, nn); } catch {}
    }
  }});
  return n;
}

// 字符串数组：识别 decoder 函数，在 vm 中执行 rotate 后，用 decoder 本身对所有「字面量参数调用」试探求值（不依赖别名是否仍在作用域）。
function stringArrayPass(ast, b, log) {
  const { t } = b;
  // 找返回 arr[idx] 的函数 → decoder 候选
  const decoders = new Set();
  b.traverse(ast, {
    FunctionDeclaration(p) {
      const name = p.node.id?.name; if (!name) return;
      let returnsIndex = false;
      p.traverse({ ReturnStatement(rp) {
        const a = rp.node.argument;
        if (t.isMemberExpression(a) && a.computed) returnsIndex = true;
        if (t.isIdentifier(a)) returnsIndex = true; // let x = arr[i]; return x
      }});
      if (returnsIndex && p.node.params.length >= 1 && p.node.params.length <= 2) decoders.add(name);
    },
  });
  // 也接受：大型字符串数组的「读取函数」（名字被引用次数高）
  const sites = [];
  b.traverse(ast, { CallExpression(p) {
    const c = p.node.callee;
    if (!t.isIdentifier(c)) return;
    if (/^(parseInt|parseFloat|Number|String|Boolean|Math|Object|Array|Date|RegExp|encodeURIComponent|decodeURIComponent|atob|btoa|require|console|setTimeout|setInterval|Function)$/.test(c.name)) return;
    if (!p.node.arguments.length || p.node.arguments.length > 3) return;
    if (!p.node.arguments.every(a => t.isNumericLiteral(a) || t.isStringLiteral(a) || t.isBooleanLiteral(a))) return;
    sites.push({ path: p, name: c.name, args: p.node.arguments.map(a => a.value) });
  }});
  if (!sites.length) return 0;
  // 若没静态识别到 decoder，把被调用次数最多的函数名当作候选
  if (!decoders.size) {
    const freq = new Map();
    for (const s of sites) freq.set(s.name, (freq.get(s.name) || 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    for (const n of top) decoders.add(n);
  }
  const full = b.generate(ast, { compact: true, comments: false }).code;
  const table = new Map(); // argsKey -> string
  try {
    const sandbox = {
      console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, clear() {}, table() {}, profile() {}, profileEnd() {} },
      atob: s => Buffer.from(s, 'base64').toString('binary'),
      btoa: s => Buffer.from(s, 'binary').toString('base64'),
      Buffer, URL, URLSearchParams,
      setTimeout: (fn, ms, ...a) => setTimeout(() => { try { typeof fn === 'function' ? fn(...a) : 0; } catch {} }, Math.min(ms || 0, 50)),
      clearTimeout, clearInterval,
      setInterval: () => 0, // 阻断自防御定时器
      document: { createElement: () => ({ style: {}, setAttribute(){}, appendChild(){} }), addEventListener(){}, body: { appendChild(){} }, head: { appendChild(){} } },
      window: {}, self: {}, globalThis: {},
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    // 阻断 Function("debugger") 类自防御
    const RealFunction = sandbox.Function = function(...args) {
      const body = String(args[args.length - 1] || '');
      if (/\bdebugger\b/.test(body) || /console/.test(body) && /while\s*\(/.test(body)) {
        return function(){};
      }
      return RealFunction.__orig(...args);
    };
    sandbox.Function.__orig = Function;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(full, ctx, { timeout: 8000 });
    // 拿到 decoder 函数引用（function 声明会挂到 sandbox）
    const fns = [];
    for (const name of decoders) {
      try { const f = vm.runInContext('typeof ' + name + '==="function"?' + name + ':null', ctx); if (typeof f === 'function') fns.push(f); } catch {}
    }
    const uniqArgs = new Map();
    for (const s of sites) uniqArgs.set(JSON.stringify(s.args), s.args);
    for (const [akey, args] of uniqArgs) {
      for (const fn of fns) {
        try {
          const v = fn.apply(null, args);
          if (typeof v === 'string' && v.length > 0 && v.length < 800) { table.set(akey, v); break; }
        } catch {}
      }
    }
  } catch (e) { log('字符串数组：沙箱失败（' + String(e.message).slice(0, 100) + '）'); return 0; }
  let decoded = 0;
  for (const s of sites) {
    const v = table.get(JSON.stringify(s.args));
    if (v == null) continue;
    // 跳过旋转 bootstrap 内部的 decode 调用（避免 parseInt("Hello") 死循环）
    let skip = false;
    let cur = s.path;
    while (cur) {
      try {
        if (typeof cur.isWhileStatement === 'function' && cur.isWhileStatement()) {
          const wsrc = b.generate(cur.node).code;
          if (/parseInt/.test(wsrc) && /shift\s*\(/.test(wsrc)) { skip = true; break; }
        }
      } catch {}
      cur = cur.parentPath;
    }
    if (skip) continue;
    // 用作方法名/属性名时，若解码结果不是合法标识符则跳过（避免 obj["Hello, 1!"]()）
    const parent = s.path.parentPath;
    if (parent && parent.isMemberExpression && parent.isMemberExpression() && parent.node.property === s.path.node) {
      if (!/^[A-Za-z_$][\w$]*$/.test(v)) continue;
    }
    if (parent && parent.isCallExpression && parent.isCallExpression() && parent.node.callee === s.path.node) {
      // decoder 直接作为 callee 是正常的；保留
    }
    s.path.replaceWith(t.stringLiteral(v)); decoded++;
  }
  if (decoded) log('字符串数组：解码 ' + decoded + ' 处（decoder 候选 ' + decoders.size + '）');
  return decoded;
}


/** obfuscator.io object-proxy 控制流：const ops = { 'abc': function(x,y){return x+y}, ... }; ops['abc'](a,b) → a+b */
function objectProxyInline(ast, b, log) {
  const { t } = b; let n = 0;
  const maps = new Map();
  b.traverse(ast, { VariableDeclarator(p) {
    if (!t.isIdentifier(p.node.id) || !t.isObjectExpression(p.node.init)) return;
    const props = {};
    for (const prop of p.node.init.properties) {
      if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue;
      const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key == null) continue;
      const val = prop.value || prop;
      if (t.isFunctionExpression(val) || t.isArrowFunctionExpression(val) || t.isObjectMethod(prop)) {
        const body = t.isObjectMethod(prop) ? prop.body : val.body;
        const params = t.isObjectMethod(prop) ? prop.params : val.params;
        // 单 return 二元/一元
        const stmts = t.isBlockStatement(body) ? body.body : [t.returnStatement(body)];
        if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && stmts[0].argument) {
          props[key] = { params: params.map(x => x.name), ret: stmts[0].argument };
        }
      } else if (t.isStringLiteral(val) || t.isNumericLiteral(val) || t.isBooleanLiteral(val)) {
        props[key] = { literal: val };
      }
    }
    if (Object.keys(props).length >= 3) maps.set(p.node.id.name, props);
  }});
  if (!maps.size) return 0;
  b.traverse(ast, { CallExpression(p) {
    if (!t.isMemberExpression(p.node.callee)) return;
    const obj = p.node.callee.object;
    if (!t.isIdentifier(obj) || !maps.has(obj.name)) return;
    const key = p.node.callee.computed
      ? (t.isStringLiteral(p.node.callee.property) ? p.node.callee.property.value : null)
      : (t.isIdentifier(p.node.callee.property) ? p.node.callee.property.name : null);
    if (key == null) return;
    const def = maps.get(obj.name)[key];
    if (!def || !def.ret) return;
    // 替换参数
    let ret = t.cloneNode(def.ret);
    const bind = new Map(def.params.map((name, i) => [name, p.node.arguments[i] || t.identifier('undefined')]));
    const remap = { Identifier(q) {
      if (bind.has(q.node.name) && q.isReferencedIdentifier()) q.replaceWith(t.cloneNode(bind.get(q.node.name)));
    }};
    // 简单：只处理二元表达式叶子是标识符
    function subst(node) {
      if (t.isIdentifier(node) && bind.has(node.name)) return t.cloneNode(bind.get(node.name));
      if (t.isBinaryExpression(node)) return t.binaryExpression(node.operator, subst(node.left), subst(node.right));
      if (t.isUnaryExpression(node)) return t.unaryExpression(node.operator, subst(node.argument), node.prefix);
      if (t.isLogicalExpression(node)) return t.logicalExpression(node.operator, subst(node.left), subst(node.right));
      if (t.isConditionalExpression(node)) return t.conditionalExpression(subst(node.test), subst(node.consequent), subst(node.alternate));
      return t.cloneNode(node);
    }
    try { p.replaceWith(subst(def.ret)); n++; } catch {}
  }});
  // 字面量属性直接替换 member
  b.traverse(ast, { MemberExpression(p) {
    if (!t.isIdentifier(p.node.object) || !maps.has(p.node.object.name)) return;
    const key = p.node.computed ? (t.isStringLiteral(p.node.property) ? p.node.property.value : null)
      : (t.isIdentifier(p.node.property) ? p.node.property.name : null);
    if (key == null) return;
    const def = maps.get(p.node.object.name)[key];
    if (def?.literal) { p.replaceWith(t.cloneNode(def.literal)); n++; }
  }});
  if (n) log('object-proxy：内联 ' + n + ' 处');
  return n;
}

/** 不透明谓词：!![] / ![] / [ ][[]] / 常量比较 */
function opaquePredicates(ast, b, log) {
  const { t } = b; let n = 0;
  b.traverse(ast, {
    UnaryExpression(p) {
      // !![] → true, ![] → false, !![0] → true
      if (p.node.operator === '!' && t.isUnaryExpression(p.node.argument, { operator: '!' })) {
        const a = p.node.argument.argument;
        if (t.isArrayExpression(a) || t.isObjectExpression(a) || (t.isNumericLiteral(a) && a.value) || t.isStringLiteral(a)) {
          p.replaceWith(t.booleanLiteral(true)); n++;
        }
      } else if (p.node.operator === '!' && t.isArrayExpression(p.node.argument)) {
        p.replaceWith(t.booleanLiteral(false)); n++;
      } else if (p.node.operator === '!' && t.isNumericLiteral(p.node.argument)) {
        p.replaceWith(t.booleanLiteral(!p.node.argument.value)); n++;
      }
    },
    BinaryExpression(p) {
      // 'x' === 'x' / 1 == 1
      try {
        if ((t.isStringLiteral(p.node.left) && t.isStringLiteral(p.node.right)) ||
            (t.isNumericLiteral(p.node.left) && t.isNumericLiteral(p.node.right))) {
          if (['==','===','!=','!==','>','<','>=','<='].includes(p.node.operator)) {
            const v = Function('return (' + JSON.stringify(p.node.left.value) + p.node.operator + JSON.stringify(p.node.right.value) + ')')();
            if (typeof v === 'boolean') { p.replaceWith(t.booleanLiteral(v)); n++; }
          }
        }
      } catch {}
    },
  });
  if (n) log('不透明谓词：折叠 ' + n + ' 处');
  return n;
}

/** sojson/jsjiami v6/v7：识别 _0x 大数组 + 立即旋转 IIFE + window 函数；剥离自防御（debugProtect / console disable） */
function sojsonPrep(ast, b, log) {
  const { t } = b; let n = 0;
  // 移除典型自防御：setInterval/debugger 死循环/console 清空
  b.traverse(ast, {
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'setInterval' }) || t.isIdentifier(p.node.callee, { name: 'setTimeout' })) {
        const arg0 = p.node.arguments[0];
        const src = arg0 ? b.generate(arg0).code : '';
        if (/debugger|console\.clear|_0x[a-f0-9]+\s*\(/.test(src)) {
          if (p.parentPath.isExpressionStatement()) { p.parentPath.remove(); n++; }
          else { p.replaceWith(t.numericLiteral(0)); n++; }
        }
      }
      // Function("...debugger...")()
      if (t.isIdentifier(p.node.callee, { name: 'Function' }) || (t.isMemberExpression(p.node.callee) && t.isIdentifier(p.node.callee.property, { name: 'constructor' }))) {
        const src = p.node.arguments.map(a => t.isStringLiteral(a) ? a.value : '').join(' ');
        if (/debugger/.test(src)) {
          if (p.parentPath.isExpressionStatement()) { p.parentPath.remove(); n++; }
          else if (p.parentPath.isCallExpression()) { p.parentPath.replaceWith(t.identifier('undefined')); n++; }
        }
      }
    },
    WhileStatement(p) {
      const src = b.generate(p.node).code;
      if (/debugger/.test(src) && src.length < 400) { p.remove(); n++; }
    },
  });
  // 检测 sojson 特征注释 / 变量名
  let sojson = false;
  b.traverse(ast, {
    StringLiteral(p) { if (/sojson|jsjiami|obfuscator/i.test(p.node.value)) sojson = true; },
    Identifier(p) { if (/^_0x[a-f0-9]{4,}$/i.test(p.node.name)) sojson = true; },
  });
  if (n) log('sojson/jsjiami：移除自防御 ' + n + ' 处');
  if (sojson) log('检测到 sojson/jsjiami/obfuscator 特征');
  return n;
}



function stripSelfDefendSource(code) {
  let out = code
    .replace(/setInterval\s*\([\s\S]*?\)\s*;?/g, (m) => /debugger|console\.clear|devtools/i.test(m) ? '0;' : m)
    .replace(/setTimeout\s*\([\s\S]*?\)\s*;?/g, (m) => /debugger|console\.clear|devtools/i.test(m) ? '0;' : m);
  // 干掉字符串数组旋转 IIFE：while(true){try{parseInt...}catch{arr.push(arr.shift())}}
  out = out.replace(
    /\(function\s*\([^)]*\)\s*\{[\s\S]*?while\s*\(\s*true\s*\)\s*\{[\s\S]*?parseInt[\s\S]*?shift\s*\([\s\S]*?\}\s*\)\s*\([^;]*\)\s*;?/g,
    '/* string-array bootstrap removed */;'
  );
  return out;
}


/** 删除 obfuscator 字符串数组旋转 while(true){ try{ parseInt(_0x..) ... } catch{ push/shift } } IIFE */
function removeStringArrayBootstrap(ast, b, log) {
  const { t } = b; let n = 0;
  b.traverse(ast, {
    WhileStatement(p) {
      const src = b.generate(p.node).code;
      if (/while\s*\(\s*true\s*\)/.test(src) && /parseInt/.test(src) && /shift\s*\(/.test(src) && src.length < 2500) {
        let target = p;
        const call = p.findParent(x => x.isCallExpression() && (t.isFunctionExpression(x.node.callee) || t.isArrowFunctionExpression(x.node.callee)));
        if (call && call.parentPath?.isExpressionStatement()) target = call.parentPath;
        else if (call) target = call;
        try { target.remove(); n++; } catch { try { p.remove(); n++; } catch {} }
      }
    },
  });
  if (n) log('字符串数组：移除旋转 bootstrap ' + n + ' 处');
  return n;
}


/** 在沙箱中加载代码，返回 { ok, exports, error, result } */
function tryLoad(code, timeout = 8000) {
  const cleaned = String(code)
    .replace(/setInterval\s*\(/g, 'void 0;(')
    .replace(/setTimeout\s*\(/g, 'void 0;(');
  const sandbox = {
    module: { exports: {} }, exports: {},
    Buffer, console: { log(){}, warn(){}, error(){}, info(){}, debug(){}, clear(){} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setInterval: () => 0,
    setTimeout: (fn) => { try { if (typeof fn === 'function') fn(); } catch {} return 0; },
    clearInterval(){}, clearTimeout(){},
    URL, URLSearchParams,
    document: { createElement: () => ({ style: {}, setAttribute(){}, appendChild(){} }), addEventListener(){}, body: {}, head: {} },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.exports = sandbox.module.exports;
  try {
    vm.runInNewContext(cleaned + '\n;this.__exports = module.exports;', sandbox, { timeout });
    const ex = sandbox.__exports || sandbox.module.exports || {};
    return { ok: true, exports: ex, error: null };
  } catch (e) {
    return { ok: false, exports: null, error: String(e && e.message || e).slice(0, 300) };
  }
}

/** 运行时等价：双方都能加载；若有 add/greet/sign/result 则对拍；否则至少 deob 可运行且不比 orig 更糟 */
function runtimeEquivalent(origCode, deobCode, log) {
  const a = tryLoad(origCode);
  const b = tryLoad(deobCode);
  if (!b.ok) {
    log('运行时检查：反混淆产物无法执行（' + (b.error || '') + '）');
    return { ok: false, reason: 'deob-load-fail', a, b };
  }
  // 原样也跑不起来时，只要 deob 可运行即接受（仍可能有用）
  if (!a.ok) {
    log('运行时检查：原文也未能在沙箱执行，接受可运行产物');
    return { ok: true, reason: 'orig-unloadable-deob-ok', a, b };
  }
  const ea = a.exports || {}, eb = b.exports || {};
  const checks = [];
  try {
    if (typeof ea.add === 'function' && typeof eb.add === 'function') {
      checks.push(['add', ea.add(20, 22), eb.add(20, 22)]);
    }
    if (typeof ea.greet === 'function' && typeof eb.greet === 'function') {
      checks.push(['greet', ea.greet('world'), eb.greet('world')]);
    }
    if (typeof ea.sign === 'function' && typeof eb.sign === 'function') {
      checks.push(['sign', ea.sign('/api/x', 'tok'), eb.sign('/api/x', 'tok')]);
    }
    if (ea.result && eb.result && typeof ea.result === 'object') {
      checks.push(['result.sum', ea.result.sum, eb.result.sum]);
    }
  } catch (e) {
    log('运行时检查：对拍调用异常 ' + e.message);
    return { ok: false, reason: 'call-fail', a, b, error: e.message };
  }
  if (checks.length) {
    for (const [name, va, vb] of checks) {
      if (JSON.stringify(va) !== JSON.stringify(vb)) {
        log('运行时检查：不等价 @ ' + name + ' orig=' + JSON.stringify(va) + ' deob=' + JSON.stringify(vb));
        return { ok: false, reason: 'mismatch:' + name, checks };
      }
    }
    log('运行时检查：等价 ✓（' + checks.map(c => c[0]).join(',') + '）');
    return { ok: true, reason: 'exports-match', checks };
  }
  // 无已知导出：双方可运行即通过
  log('运行时检查：无对拍导出，双方可运行 → 通过');
  return { ok: true, reason: 'both-runnable' };
}

function applyPasses(ast, b, want, rounds, log) {
  const stats = {};
  if (want.has('sojson')) stats.sojson = sojsonPrep(ast, b, log);
  if (want.has('strings')) { stats.strings = stringArrayPass(ast, b, log); stats.bootstrap = removeStringArrayBootstrap(ast, b, log); }
  for (let round = 0; round < (rounds || 3); round++) {
    if (want.has('opaque')) stats.opaque = (stats.opaque || 0) + opaquePredicates(ast, b, log);
    if (want.has('proxy')) stats.proxy = (stats.proxy || 0) + objectProxyInline(ast, b, log);
    if (want.has('fold')) stats.fold = (stats.fold || 0) + constantFold(ast, b);
    if (want.has('unflatten')) stats.unflatten = (stats.unflatten || 0) + unflatten(ast, b, log);
    if (want.has('dead')) stats.dead = (stats.dead || 0) + deadCode(ast, b);
  }
  if (want.has('rename')) stats.rename = rename(ast, b);
  if (want.has('strings')) stats.bootstrap2 = removeStringArrayBootstrap(ast, b, log);
  return stats;
}

async function deobfuscate(a, ctx) {
  const b = await babel();
  const log = m => { try { ctx.emit?.('log', m); } catch {} };
  let code = readSrc(ctx, a);
  const origLen = code.length;
  const userPasses = a.passes?.length ? true : false;
  // 策略链：激进 → 安全 → 仅剥自防御；必须通过运行时等价，否则不输出损坏代码
  const strategies = userPasses
    ? [ { name: 'user', passes: a.passes } ]
    : [
        { name: 'full', passes: ['sojson', 'strings', 'proxy', 'opaque', 'fold', 'unflatten', 'dead', 'rename'] },
        { name: 'safe', passes: ['sojson', 'strings', 'opaque', 'fold', 'dead', 'rename'] }, // 无 proxy/unflatten
        { name: 'minimal', passes: ['sojson', 'fold', 'dead'] },
      ];
  let chosen = null; let stats = {}; let out = null; let eq = null;
  for (const strat of strategies) {
    const want = new Set(strat.passes);
    let ast;
    try { ast = b.parse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx'] }); }
    catch (e) { return { text: '解析失败：' + e.message, isError: true }; }
    stats = applyPasses(ast, b, want, a.rounds || 3, log);
    let cand = b.generate(ast, { comments: false, jsescOption: { minimal: true } }).code;
    cand = stripSelfDefendSource(cand);
    if ((want.has('webcrack') || a.webcrack === true) && strat.name === 'full') {
      try {
        const { webcrack } = await import('webcrack');
        const r = await webcrack(cand, { sandbox: async c => c, mangle: false, deobfuscate: true, unpack: true, jsx: false });
        const broken = /\[" "\]/.test(r.code) && !/Object\.keys/.test(r.code);
        if (!broken) { cand = r.code; stats.webcrack = 1; } else log('webcrack 结果疑似损坏，已丢弃');
      } catch (e) { log('webcrack：' + String(e.message).slice(0, 80)); }
    }
    eq = runtimeEquivalent(code, cand, log);
    if (eq.ok) { chosen = strat.name; out = cand; break; }
    log('策略 ' + strat.name + ' 未通过运行时检查，尝试下一档（不输出损坏代码）');
  }
  if (!out) {
    // 全部失败：只剥自防御后再检查；通过则输出（即便与原文相同也胜过损坏代码）
    let soft = stripSelfDefendSource(code);
    eq = runtimeEquivalent(code, soft, log);
    if (eq.ok) {
      chosen = soft !== code ? 'strip-only' : 'original-safe';
      out = soft;
      stats = { stripOnly: soft !== code ? 1 : 0, originalSafe: soft === code ? 1 : 0 };
    } else {
      // 原文自身在沙箱也跑不起来时，仍可输出剥自防御版本供人工阅读（标注未验证）
      const origLoad = tryLoad(code);
      if (!origLoad.ok) {
        chosen = 'strip-unverified';
        out = soft;
        stats = { stripOnly: 1, unverified: 1 };
        eq = { ok: false, reason: 'orig-unloadable-strip-emitted' };
        log('原文沙箱不可跑，输出剥自防御版本（未做等价验证）');
      } else {
        return {
          text: '反混淆拒绝输出：所有策略均未通过运行时等价检查（损坏输出不如没有）。最后错误：' + (eq?.reason || '') + ' / ' + (eq?.b?.error || eq?.error || ''),
          isError: true,
          stats: { refused: true, reason: eq?.reason },
        };
      }
    }
  }
  const summary = `反混淆完成（策略=${chosen}，${origLen}→${out.length} 字节，runtime${eq.ok?'✓':'~'} ${eq.reason}）：webcrack ${stats.webcrack ? '✓' : '–'}，sojson ${stats.sojson || 0}，字符串 ${stats.strings || 0}，proxy ${stats.proxy || 0}，opaque ${stats.opaque || 0}，折叠 ${stats.fold || 0}，平坦化 ${stats.unflatten || 0}，死代码 ${stats.dead || 0}，重命名 ${stats.rename || 0}。`;
  if (a.outputFile) {
    const p = path.resolve(ctx.projectDir, a.outputFile);
    if (!p.startsWith(path.resolve(ctx.projectDir))) throw new Error('只能写入项目目录');
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, out);
    return { text: summary + ' 已保存到 ' + a.outputFile + '。预览：\n```js\n' + out.slice(0, 2500) + (out.length > 2500 ? '\n…' : '') + '\n```' };
  }
  return { text: summary + '\n```js\n' + out.slice(0, 8000) + (out.length > 8000 ? '\n…' : '') + '\n```' };
}

export const AST_TOOLS = [
  { name: 'ast_deobfuscate', description: '【AST 反混淆】babel：字符串数组解码（vm 运行时求值，覆盖 rotate/base64/rc4）、控制流平坦化线性化、常量折叠、死代码消除、十六进制标识符重命名、美化。入参 code 或 source；passes 可选 ["sojson","strings","proxy","opaque","fold","unflatten","dead","rename","webcrack"]（默认除 webcrack 外全开；覆盖 obfuscator.io 中高配旋转字符串数组/自防御/object-proxy 平坦化/不透明谓词，及 sojson/jsjiami v6/v7）；rounds 默认 3；outputFile 保存。默认启用运行时等价检查：产物必须可运行且与原文导出对拍，否则自动降级到 safe/minimal；仍失败则拒绝输出（损坏不如没有）。', schema: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' }, passes: { type: 'array', items: { type: 'string' } }, rounds: { type: 'number' }, outputFile: { type: 'string' }, webcrack: { type: 'boolean' } } }, run: deobfuscate },
];
