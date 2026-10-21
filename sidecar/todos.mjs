// 会话内逆向清单。状态随会话落盘，上下文压缩时由 Agent 重新附上。
export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const STATUS = new Set(TODO_STATUSES);

export const DEFAULT_TODOS = [
  { id: 'locate', content: '定位参数', status: 'pending' },
  { id: 'signer', content: '找到签名函数', status: 'pending' },
  { id: 'extract', content: '抠代码 / 补环境', status: 'pending' },
  { id: 'repro', content: '本地复现', status: 'pending' },
  { id: 'compare', content: '与浏览器结果对比', status: 'pending' },
];

export function normalizeSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps 必须是非空数组');
  if (steps.length > 30) throw new Error('清单最多 30 步');
  const seen = new Set();
  return steps.map(s => {
    const id = String(s?.id || '').trim().slice(0, 40);
    const content = String(s?.content || '').trim().slice(0, 200);
    const status = String(s?.status || '');
    if (!id || !content) throw new Error('每个步骤都需要 id 和 content');
    if (!STATUS.has(status)) throw new Error('非法 status: ' + status + '（可用 pending / in_progress / completed / cancelled）');
    if (seen.has(id)) throw new Error('重复的步骤 id: ' + id);
    seen.add(id);
    return { id, content, status };
  });
}

export function applyTodos(prev, steps, merge) {
  const incoming = normalizeSteps(steps);
  if (!merge) return incoming;
  const map = new Map((prev || []).map(t => [t.id, { ...t }]));
  for (const s of incoming) map.set(s.id, { ...(map.get(s.id) || {}), ...s });
  const seen = new Set();
  const out = [];
  for (const t of prev || []) if (map.has(t.id)) { out.push(map.get(t.id)); seen.add(t.id); }
  for (const s of incoming) if (!seen.has(s.id)) out.push(map.get(s.id));
  return out;
}

export function formatTodos(list) {
  return '任务清单：\n' + (list || []).map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n');
}

export function todoWrite(a, ctx) {
  try {
    const prev = ctx.getTodos?.() || [];
    const next = applyTodos(prev, a?.steps, !!a?.merge);
    ctx.setTodos?.(next);
    return { text: '已更新。\n' + formatTodos(next) };
  } catch (e) { return { text: String(e.message || e), isError: true }; }
}

const S = { type: 'object', properties: {
  merge: { type: 'boolean', description: 'true 按 id 合并到现有清单；false 整体替换' },
  steps: { type: 'array', description: '步骤。每项含 id、content、status（pending|in_progress|completed|cancelled）', items: { type: 'object', properties: {
    id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string', enum: TODO_STATUSES },
  }, required: ['id', 'content', 'status'] } },
}, required: ['steps'] };

export const TODO_TOOLS = [
  { name: 'todo_write', description: '更新本会话顶部的逆向任务清单（定位参数 → 找到签名函数 → 抠代码/补环境 → 本地复现 → 与浏览器对比，也可自定步骤）。同一时刻尽量只有一个 in_progress。计划模式下也可用。清单会随会话保存，上下文压缩后仍然保留。', schema: S, run: todoWrite },
];
