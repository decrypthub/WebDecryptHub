// 工具契约：一份声明同时产出「喂给模型的 JSON Schema」和「宿主边界的运行时校验」。
//
// 为什么要这一层：工具注册表曾有 55+ 个工具，每个 run() 各自防御式解析入参，
// 模型传错类型/拼错枚举值时大多被静默忽略（或抛 TypeError），模型只能靠猜。
// 这里把校验收到唯一边界（Agent.runTool），错误以 isError 回传给模型让它自我修正。
//
// 刻意不引入 zod：校验只依赖 JSON Schema 子集，所以 MCP 内核工具（自带 inputSchema）
// 和手写的旧 schema 走同一条路径，零新增依赖、可被 bun --compile 打包。

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

// ---------------------------------------------------------------- schema 构造
// 用法：{ type:'object', properties:{ path: str('文件相对路径'), depth: num({ int: true }) }, required:['path'] }
function field(type, opts = {}) {
  const { desc, description, enum: en, min, max, int, items, pattern, default: def, ...rest } = opts;
  const s = { type: type === 'integer' || int ? 'integer' : type };
  if (type === 'integer') s.type = 'integer';
  const text = desc || description;
  if (text) s.description = text;
  if (en) s.enum = en;
  if (min != null) s.minimum = min;
  if (max != null) s.maximum = max;
  if (pattern) s.pattern = pattern instanceof RegExp ? pattern.source : String(pattern);
  if (items) s.items = items;
  if (def !== undefined) s.default = def;
  return Object.assign(s, rest);
}
export const str = (descOrOpts, opts) => field('string', typeof descOrOpts === 'string' ? { desc: descOrOpts, ...(opts || {}) } : descOrOpts);
export const num = (descOrOpts, opts) => field('number', typeof descOrOpts === 'string' ? { desc: descOrOpts, ...(opts || {}) } : descOrOpts);
export const int = (descOrOpts, opts) => field('integer', typeof descOrOpts === 'string' ? { desc: descOrOpts, ...(opts || {}) } : descOrOpts);
export const bool = (descOrOpts, opts) => field('boolean', typeof descOrOpts === 'string' ? { desc: descOrOpts, ...(opts || {}) } : descOrOpts);
export const arr = (items, desc) => ({ type: 'array', items, ...(desc ? { description: desc } : {}) });
/** @param {Record<string, object>} properties @param {string[]} [required] */
export const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

// ---------------------------------------------------------------- 校验
const quote = v => { try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 60 ? s.slice(0, 60) + '…' : s; } catch { return String(v); } };
const typeOf = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;

function coerce(value, schema) {
  const t = schema.type;
  if (t === 'number' || t === 'integer') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return value;
  }
  if (t === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return value;
  }
  if (t === 'string' && typeof value === 'number') return String(value);
  return value;
}

function check(value, schema, path) {
  if (!schema || typeof schema !== 'object') return null;
  // 不支持的组合关键字（oneOf/anyOf/allOf/$ref）：宁可放过，不要误杀 MCP / 手写 schema
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.$ref) return null;
  const t = schema.type;
  if (t && TYPES.has(t)) {
    const want = t === 'integer' ? 'integer' : t;
    const got = typeOf(value);
    const okType = want === 'integer'
      ? got === 'integer' || (got === 'number' && Number.isInteger(value))
      : want === 'number' ? got === 'number' || got === 'integer' : want === got;
    if (!okType) return `${path || '参数'} 类型应为 ${t}，收到 ${got}（${quote(value)}）`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path || '参数'} 只能是 ${schema.enum.map(quote).join(' / ')}，收到 ${quote(value)}`;
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return `${path} 不能小于 ${schema.minimum}（收到 ${value}）`;
    if (schema.maximum != null && value > schema.maximum) return `${path} 不能大于 ${schema.maximum}（收到 ${value}）`;
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return `${path} 至少 ${schema.minLength} 个字符`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} 最多 ${schema.maxLength} 个字符`;
    if (schema.pattern) { let re; try { re = new RegExp(schema.pattern); } catch { re = null; } if (re && !re.test(value)) return `${path} 格式不匹配 ${schema.pattern}（收到 ${quote(value)}）`; }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) { const e = check(value[i], schema.items, `${path}[${i}]`); if (e) return e; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (value[k] === undefined || value[k] === null) return `缺少必填参数 ${path ? path + '.' : ''}${k}`;
    for (const [k, sub] of Object.entries(props)) {
      if (value[k] === undefined || value[k] === null) continue;
      const e = check(value[k], sub, `${path ? path + '.' : ''}${k}`);
      if (e) return e;
    }
  }
  return null;
}

/**
 * 校验并规范化一次工具调用参数。
 * - 已声明的字段按 schema 校验（类型不符会先做安全强转，例如 "5" → 5）
 * - 未声明的字段默认原样保留（不改变现有工具的宽松语义）；tool.strict=true 时剔除
 * - 返回 { ok, value, dropped } 或 { ok:false, error }
 */
export function validateArgs(schema, args, { strict = false } = {}) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!schema || schema.type !== 'object') return { ok: true, value: input, dropped: [] };
  const value = {};
  const dropped = [];
  for (const [k, v] of Object.entries(input)) {
    if (schema.properties && !(k in schema.properties) && strict) { dropped.push(k); continue; }
    value[k] = schema.properties && k in schema.properties ? coerce(v, schema.properties[k]) : v;
  }
  const error = check(value, schema, '');
  if (error) return { ok: false, error };
  return { ok: true, value, dropped };
}

// ---------------------------------------------------------------- 注册表
/** 去掉内部字段，得到可发给模型的工具清单 */
export function toWire(tool) { return { name: tool.name, description: tool.description, schema: tool.schema || tool.inputSchema || { type: 'object', properties: {} } }; }

/**
 * 启动期体检：重名、缺 schema、缺 run、缺风险等级。
 * 由 index.mjs 记录日志、由 test/contract.test.mjs 断言为 0，避免新增工具时漏登记。
 */
export function registryIssues(tools, riskOf) {
  const issues = [];
  const seen = new Map();
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !t.name) { issues.push('存在没有 name 的工具'); continue; }
    if (seen.has(t.name)) issues.push(`工具名重复：${t.name}`);
    seen.set(t.name, t);
    if (typeof t.run !== 'function') issues.push(`工具 ${t.name} 没有 run()`);
    if (!t.schema || t.schema.type !== 'object') issues.push(`工具 ${t.name} 没有 object 型 schema`);
    if (typeof riskOf === 'function') { const r = riskOf(t.name, {}); if (!r) issues.push(`工具 ${t.name} 没有风险等级`); }
  }
  return issues;
}
