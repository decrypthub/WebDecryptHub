// 真实 LLM 长对话：小上下文窗口触发自动压缩，再追问早期事实。用法：WDH_LLM_API_KEY=... node sidecar/live/ctx-live.mjs <dir>
// 覆盖：① 手动压缩 + 用户指令（/compact 关注…）② 自动压缩（microcompact → 结构化摘要，update 模式）③ 压缩后回忆早期事实
import { Agent } from '../agent.mjs';
const dir = process.argv[2] || '/tmp/ctxlive';
const settings = { provider: 'openai', openai: { baseUrl: process.env.WDH_LLM_BASE || 'https://api.b.ai/v1', apiKey: process.env.WDH_LLM_API_KEY, model: process.env.WDH_LLM_MODEL || 'deepseek-v4.1-flash', contextWindow: Number(process.env.CTX || 9000) }, compactAt: 0.8, temperature: 0.2, maxSteps: 3 };
const browser = { requests: [], pages: [], activePage: null, scripts: [], findRequest: () => null };
const mcp = { tools: [], has: () => false };
const log = [];
const agent = new Agent({ mcp, browser, projectDir: dir, getSettings: () => settings, emit: (ev, p) => { if (ev === 'context' && p.event) { log.push(p); console.log('CONTEXT', JSON.stringify({ event: p.event, reason: p.reason, before: p.before, after: p.after, instructions: p.instructions, kept: p.kept, summarized: p.summarized })); } if (ev === 'error') console.log('ERROR', p); if (ev === 'log') console.log('LOG', p); } });
agent.allTools = () => []; // 纯对话
const filler = n => ('这是一段关于签名算法分析的背景材料，用于填充上下文。' + 'abcdefghij'.repeat(30)).repeat(n);
const turns = [
  '请记住三个事实：项目代号是「青鸾-7」，目标参数叫 x-zse-96，密钥种子是 0x5A17。只回复“已记住”。',
  ...Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 段材料（无需复述，回复一句话概括即可）：\n` + filler(6)),
  '不要看材料，直接回答：项目代号、目标参数名、密钥种子分别是什么？',
];
for (const [i, t] of turns.entries()) {
  if (i === 3) { // 手动压缩，带用户指令
    const r = await agent.compress({ reason: 'manual', instructions: '重点保留项目代号、x-zse-96 参数与密钥种子', force: true });
    console.log('MANUAL', r.ok, r.before, '->', r.after); console.log('MANUAL_SUMMARY\n' + r.summary);
  }
  await agent.send(t);
  const last = agent.messages.filter(m => m.role === 'assistant').pop();
  const st = agent.stats();
  console.log(`TURN used=${st.used}/${st.limit} msgs=${st.messages} compressions=${st.compressions} :: ${String(last?.content || '').replace(/\s+/g, ' ').slice(0, 160)}`);
}
const ans = String(agent.messages.filter(m => m.role === 'assistant').pop()?.content || '');
const ok = /青鸾-7/.test(ans) && /x-zse-96/i.test(ans) && /0x5A17/i.test(ans);
console.log('COMPRESSIONS', agent.compressions, 'RECALL_OK', ok);
console.log('FINAL_SUMMARY\n' + String(agent.messages.find(m => m._summary)?.content || ''));
const autos = log.filter(p => p.reason === 'auto').length;
console.log('AUTO_EVENTS', autos);
process.exit(ok && agent.compressions >= 2 && autos > 0 ? 0 : 1);
