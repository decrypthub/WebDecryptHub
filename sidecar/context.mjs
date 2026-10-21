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

// 模型上下文窗口（tokens）：设置优先，其次按模型名推断
export function modelLimit(settings) {
  const v = Number(settings?.contextWindow);
  if (Number.isFinite(v) && v >= 4000) return Math.round(v);
  const m = String((settings?.provider === 'anthropic' ? settings?.anthropic?.model : settings?.openai?.model) || '').toLowerCase();
  if (/claude/.test(m)) return 200000;
  if (/gpt-4\.1|gemini/.test(m)) return 1000000;
  if (/deepseek|qwen|gpt-4o|gpt-5|kimi|glm/.test(m)) return 128000;
  return 64000;
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

export function transcript(msgs, perMsg = 2500) {
  return msgs.map(m => {
    const c = String(m.content || '');
    if (m.role === 'tool') return `[工具结果 ${m.name || ''}] ${c.slice(0, 1200)}${c.length > 1200 ? '…' : ''}`;
    const calls = (m.tool_calls || []).map(t => `${t.function.name}(${String(t.function.arguments).slice(0, 300)})`).join('; ');
    return `[${m._summary ? '既往摘要' : m.role === 'user' ? '用户' : '助手'}] ${c.slice(0, perMsg)}${calls ? '\n  调用工具: ' + calls : ''}`;
  }).join('\n');
}

export const SUMMARY_PROMPT = '你是对话压缩器。把下面这段 JS 逆向分析对话压缩为一份供后续继续工作的“上下文摘要”。必须保留：用户给出的事实/约束/偏好（原样保留具体数值、名字、口令）、目标站点与参数、已定位的脚本/函数/请求 id、关键结论与证据、已生成的文件路径、未完成的事项。去掉寒暄与重复过程。工具大输出只保留结论和可重新获取的引用（请求 id、文件路径、ctx_ref）。用中文条目输出，不超过 1200 字。';

// 大工具输出 → 存档 + 引用（模型可用 context_ref_read / net_get 重新获取）
export function trimToolOutput(text, { dir, name, limit = 6000, head = 1800 } = {}) {
  text = String(text ?? '');
  if (text.length <= limit) return text;
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
