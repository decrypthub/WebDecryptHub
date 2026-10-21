// 对话上下文管理：token 估算、超限自动压缩（真实 LLM 摘要）、大工具输出转引用、附件解析
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 粗略 tokenizer：CJK 每字约 1 token，其它约 3.6 字符 1 token（偏保守）；真实 usage 到达后再校准
export function estimateTokens(s) {
  if (!s) return 0; s = String(s);
  let cjk = 0; for (const ch of s) { const c = ch.codePointAt(0); if (c >= 0x2e80 && c <= 0x9fff || c >= 0xac00 && c <= 0xd7af || c >= 0xff00 && c <= 0xffef) cjk++; }
  return Math.ceil(cjk + (s.length - cjk) / 3.6);
}
export function messageTokens(m) {
  let n = 4 + estimateTokens(m.content);
  if (m.reasoning_content) n += estimateTokens(m.reasoning_content);
  for (const t of m.tool_calls || []) n += 8 + estimateTokens(t.function?.name) + estimateTokens(t.function?.arguments);
  return n;
}
export function contextTokens(messages, tools = []) {
  let n = 0; for (const m of messages) n += messageTokens(m);
  if (tools.length) n += estimateTokens(JSON.stringify(tools));
  return n;
}

// 模型上下文窗口（tokens）：随模型配置保存（openai.contextWindow / anthropic.contextWindow）；未设置则按模型名推断
export const WINDOW_PRESETS = [128000, 256000, 300000, 500000, 1000000];
export function providerCfg(settings) { return (settings?.provider === 'anthropic' ? settings?.anthropic : settings?.openai) || {}; }
export function inferLimit(model) {
  const m = String(model || '').toLowerCase();
  if (/\[1m\]|-1m\b|gemini|gpt-4\.1|gpt-5\.[1-9]|qwen.*(long|turbo)|kimi-k2/.test(m)) return 1000000;
  if (/claude/.test(m)) return 200000;
  if (/deepseek|qwen|gpt-4o|gpt-5|glm|kimi|doubao|minimax/.test(m)) return 128000;
  return 128000;
}
export function modelLimit(settings) { return limitInfo(settings).limit; }
export function limitInfo(settings) {
  const cfg = providerCfg(settings);
  const v = Number(cfg.contextWindow) || Number(settings?.contextWindow); // 旧版全局字段兼容
  if (Number.isFinite(v) && v >= 4000) return { limit: Math.round(v), inferred: false };
  return { limit: inferLimit(cfg.model), inferred: true };
}
// 触发线：min(阈值×窗口, 窗口−输出预留)；预留 = min(16k, 10% 窗口)（参考 Pi reserveTokens / opencode RESERVE_MIN）
export function compactTrigger(limit, compactAt = 0.85) {
  const at = Math.min(0.95, Math.max(0.5, Number(compactAt) || 0.85));
  return Math.round(Math.min(limit * at, limit - Math.min(16000, limit * 0.1)));
}

// 用量分类（参考 Claude Code /context）
export function breakdown(messages, tools = []) {
  const b = { system: 0, tools: tools.length ? estimateTokens(JSON.stringify(tools)) : 0, history: 0, attachments: 0, toolResults: 0, summary: 0 };
  for (const m of messages) {
    const t = messageTokens(m);
    if (m.role === 'system') b.system += t;
    else if (m._summary) b.summary += t;
    else if (m.role === 'tool') b.toolResults += t;
    else if (m._attTok) { const a = Math.min(t, m._attTok); b.attachments += a; b.history += t - a; }
    else b.history += t;
  }
  return b;
}

// 第一阶段（microcompact）：旧工具结果换成引用，最近 keep 条原样（参考 Claude Code 清理旧工具输出 / Gemini 函数响应预算）
export function microcompact(messages, { dir, keep = 3, minChars = 1200 } = {}) {
  const idx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
  let saved = 0, n = 0;
  for (const i of idx.slice(0, Math.max(0, idx.length - keep))) {
    const m = messages[i]; const c = String(m.content || '');
    if (m._pruned || c.length < minChars) continue;
    const before = estimateTokens(c);
    m.content = trimToolOutput(c, { dir, name: m.name, limit: 0, head: 300 }).replace('输出过长已截断', '旧工具结果已收起');
    m._pruned = true; m._compacted = true; saved += before - estimateTokens(m.content); n++;
  }
  return { saved, count: n };
}

// 第二阶段切分：从尾部按 token 预算保留原文（Pi keepRecentTokens），切点只落在 user/assistant 上，绝不切在 tool 结果
export function splitByTokens(messages, keepTokens) {
  const body = messages.slice(1);
  let prev = null; const rest = [];
  for (const m of body) { if (m._summary) prev = m; else rest.push(m); }
  // 旧摘要后面紧跟的“已了解”确认也不进入摘要
  while (rest.length && rest[0]._ack) rest.shift();
  let acc = 0, cut = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) { acc += messageTokens(rest[i]); if (acc > keepTokens) break; cut = i; }
  while (cut < rest.length && rest[cut].role === 'tool') cut++;
  if (cut >= rest.length) { cut = rest.length - 1; while (cut > 0 && rest[cut].role === 'tool') cut--; }
  // 至少保留最后一条 user 消息原文
  const lastUser = rest.map(m => m.role).lastIndexOf('user');
  if (lastUser >= 0 && cut > lastUser && acc <= keepTokens * 3) cut = lastUser;
  return { previousSummary: prev ? String(prev.content).replace(/^【[^】]*】\n?/, '') : '', old: rest.slice(0, cut), recent: rest.slice(cut) };
}

// 切分：保留最近 keepTurns 个用户回合原样，之前的进入摘要；切点总在 user 消息上，tool_call/tool 成对不被拆开
export function splitForCompress(messages, keepTurns = 2) {
  const body = messages.slice(1);
  const userIdx = body.map((m, i) => (m.role === 'user' && !m._summary ? i : -1)).filter(i => i >= 0);
  if (userIdx.length <= keepTurns) {
    // 回合太少（单回合内大量工具调用）：在最近的 assistant(无未完成 tool) 边界处切，保留最后 ~8 条
    let cut = Math.max(0, body.length - 8);
    while (cut > 0 && body[cut].role === 'tool') cut--;
    if (cut <= 1) return { old: [], recent: body };
    return { old: body.slice(0, cut), recent: body.slice(cut) };
  }
  const cut = userIdx[userIdx.length - keepTurns];
  return { old: body.slice(0, cut), recent: body.slice(cut) };
}

export function transcript(msgs, perMsg = 4000) {
  return msgs.map(m => {
    const c = String(m.content || '');
    if (m.role === 'tool') return `[工具结果 ${m.name || ''}]: ${c.slice(0, 2000)}${c.length > 2000 ? `\n[… 其余 ${c.length - 2000} 字符已省略]` : ''}`;
    const calls = (m.tool_calls || []).map(t => `${t.function.name}(${String(t.function.arguments).slice(0, 300)})`).join('; ');
    return `[${m.role === 'user' ? '用户' : '助手'}]: ${c.slice(0, perMsg)}${c.length > perMsg ? '…' : ''}${calls ? `\n[助手调用工具]: ${calls}` : ''}`;
  }).join('\n');
}

// 结构化摘要模板（综合 Pi SUMMARIZATION_PROMPT、opencode SUMMARY_TEMPLATE/RULES、Gemini state_snapshot，面向 JS 逆向）
const SECTIONS = `## 目标
- 用户要逆向/复现什么（站点、参数、接口），一两句

## 用户约束与事实
- 用户明确给出的事实、偏好、限制；数值/名字/口令原样保留

## 关键发现
- 已确认的结论与证据（算法、密钥来源、调用链、环境探针等）

## 涉及的脚本与文件
- \`路径或脚本 id\`：作用（最多 15 条）

## 涉及的请求
- 请求 id / 方法 / URL：与目标的关系（签名参数、密钥下发等）

## 当前状态
- 已完成 / 进行中 / 受阻（及原因）

## 下一步
1. 有序的下一步动作

## 关键数据
- 继续工作必需且不易重新获取的数据（ctx_ref、样例值、报错原文）`;
const RULES = `规则：
- 每节用简短单行要点，没有内容写“（无）”
- 原样保留路径、函数名、请求 id、URL、参数名、错误信息、数值
- 工具大输出只写结论与可重新获取的引用（请求 id 用 net_get，ctx_ref 用 context_ref_read），不要抄原文
- 只保留仍未回答或仍需处理的用户问题
- 不要提及“摘要/压缩”过程本身；直接输出 Markdown，不要前言`;
export function summaryPrompt({ update, instructions } = {}) {
  const head = update
    ? '上面 <conversation> 中是【新增】对话，<previous-summary> 中是已有检查点。把新增内容合并进已有检查点，输出一份完整的、更新后的检查点（保留仍然有效的旧信息，更新状态与下一步）。'
    : '上面 <conversation> 中是一段 JS 逆向分析对话。为另一个将接手继续工作的模型生成一份结构化“上下文检查点”。';
  return `${head}\n\n必须使用以下格式：\n${SECTIONS}\n\n${RULES}${instructions ? `\n\n用户额外要求重点保留：${String(instructions).slice(0, 500)}` : ''}`;
}
export function buildSummaryRequest(old, { previousSummary, instructions } = {}) {
  let user = `<conversation>\n${transcript(old)}\n</conversation>\n\n`;
  if (previousSummary) user += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  user += summaryPrompt({ update: !!previousSummary, instructions });
  return [{ role: 'system', content: '你是上下文检查点生成器，只输出检查点内容，不调用工具，不继续对话。' }, { role: 'user', content: user }];
}
export const SUMMARY_PREFIX = '【上下文检查点：以下是较早对话的结构化摘要，由之前的工作生成；在此基础上继续，避免重复已完成的工作】\n';
export const SUMMARY_PROMPT = summaryPrompt(); // 兼容旧导出

// 大工具输出 → 存档 + 引用（模型可用 context_ref_read / net_get 重新获取）
export function trimToolOutput(text, { dir, name, limit = 6000, head = 1800 } = {}) {
  text = String(text ?? '');
  if (limit > 0 && text.length <= limit) return text;
  let ref = '';
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      ref = 'ctx_' + crypto.createHash('md5').update(text).digest('hex').slice(0, 10);
      fs.writeFileSync(path.join(dir, ref + '.txt'), text);
    } catch { ref = ''; }
  }
  const ids = [...new Set((text.match(/\b(?:r|h)\d{1,6}\b/g) || []))].slice(0, 12);
  return text.slice(0, head) + `\n…[输出过长已截断：原 ${text.length} 字符${ref ? `；完整内容 context_ref_read(ref="${ref}", offset, length)` : ''}${ids.length && /^net_/.test(name || '') ? `；或 net_get(id) 重新获取：${ids.join(', ')}` : ''}]`;
}

export function readRef(dir, ref, offset = 0, length = 6000) {
  if (!/^ctx_[0-9a-f]{10}$/.test(String(ref))) return { text: '无效 ref', isError: true };
  try {
    const t = fs.readFileSync(path.join(dir, ref + '.txt'), 'utf8');
    const o = Math.max(0, offset | 0), l = Math.min(20000, Math.max(200, length | 0 || 6000));
    return { text: `[${ref} ${o}-${Math.min(t.length, o + l)}/${t.length}]\n` + t.slice(o, o + l) };
  } catch { return { text: 'ref 不存在或已清理：' + ref, isError: true }; }
}

// 附件 → 文本块（发送时展开进用户消息）
export async function resolveAttachments(list, { browser, projectDir }) {
  const out = [];
  for (const a of (list || []).slice(0, 12)) {
    try {
      if (a.kind === 'page') {
        const p = browser?.activePage; const url = p ? p.url() : a.url; const title = p ? await p.title().catch(() => '') : a.title;
        out.push(`【附件·当前页面】URL: ${url}\n标题: ${title || '(无)'}`);
      } else if (a.kind === 'request') {
        const r = browser?.findRequest(a.id);
        if (!r) { out.push(`【附件·请求 ${a.id}】已不在捕获列表中`); continue; }
        const hdr = o => Object.entries(o || {}).slice(0, 40).map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`).join('\n');
        let body = ''; try { if (r.bodyFile && !r.bodyBinary) body = fs.readFileSync(r.bodyFile, 'utf8').slice(0, 1500); } catch {}
        out.push(`【附件·请求 ${r.id}】${r.method} ${r.url}\n状态: ${r.status ?? '-'} 类型: ${r.type || '-'}\n请求头:\n${hdr(r.headers)}` +
          (r.postData ? `\n请求体: ${String(r.postData).slice(0, 2000)}` : '') +
          (r.respHeaders ? `\n响应头:\n${hdr(r.respHeaders)}` : '') +
          (body ? `\n响应体(前 1500 字符，完整用 net_get("${r.id}")): ${body.slice(0, 1500)}` : `\n响应体用 net_get("${r.id}") 获取`));
      } else if (a.kind === 'script') {
        const s = (browser?.scripts || []).find(x => x.id === a.id);
        if (!s) { out.push(`【附件·脚本 ${a.id}】不存在`); continue; }
        const src = fs.readFileSync(s.file, 'utf8');
        out.push(`【附件·脚本 ${s.id}】${s.url}（${src.length} 字符，文件 ${path.relative(projectDir, s.file)}，可用 grep_file/read_file_slice 读取）\n前 2000 字符:\n${src.slice(0, 2000)}`);
      } else if (a.kind === 'snippet') {
        out.push(`【附件·代码片段${a.label ? ' ' + a.label : ''}】\n${String(a.text || '').slice(0, 8000)}`);
      } else if (a.kind === 'file') {
        const p = path.resolve(projectDir, String(a.file || ''));
        if (!p.startsWith(path.resolve(projectDir) + path.sep)) { out.push('【附件·文件】拒绝：仅允许会话项目目录'); continue; }
        const t = fs.readFileSync(p, 'utf8');
        out.push(`【附件·文件 ${a.file}】（${t.length} 字符）\n${t.slice(0, 6000)}${t.length > 6000 ? '\n…[已截断，完整内容 read_file_slice]' : ''}`);
      }
    } catch (e) { out.push(`【附件·${a.kind}】读取失败: ${e.message}`); }
  }
  return out.join('\n\n');
}
