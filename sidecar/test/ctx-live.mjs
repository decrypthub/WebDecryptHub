// 真实 LLM 长对话：小上下文窗口触发自动压缩，再追问早期事实。用法：WDH_LLM_API_KEY=... node sidecar/test/ctx-live.mjs <dir>
import { Agent } from '../agent.mjs';
const dir = process.argv[2] || '/tmp/ctxlive';
const settings = { provider: 'openai', openai: { baseUrl: process.env.WDH_LLM_BASE || 'https://api.b.ai/v1', apiKey: process.env.WDH_LLM_API_KEY, model: process.env.WDH_LLM_MODEL || 'deepseek-v4.1-flash' }, temperature: 0.2, maxSteps: 3, contextWindow: Number(process.env.CTX || 9000) };
const browser = { requests: [], pages: [], activePage: null, scripts: [], findRequest: () => null };
const mcp = { tools: [], has: () => false };
const log = [];
const agent = new Agent({ mcp, browser, projectDir: dir, getSettings: () => settings, emit: (ev, p) => { if (ev === 'context' && p.event) { log.push(p); console.log('CONTEXT', JSON.stringify({ event: p.event, reason: p.reason, before: p.before, after: p.after })); } if (ev === 'error') console.log('ERROR', p); if (ev === 'log') console.log('LOG', p); } });
agent.allTools = () => []; // 纯对话
const filler = n => ('这是一段关于签名算法分析的背景材料，用于填充上下文。' + 'abcdefghij'.repeat(30)).repeat(n);
const turns = [
  '请记住三个事实：项目代号是「青鸾-7」，目标参数叫 x-zse-96，密钥种子是 0x5A17。只回复“已记住”。',
  ...Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 段材料（无需复述，回复一句话概括即可）：\n` + filler(6)),
  '不要看材料，直接回答：项目代号、目标参数名、密钥种子分别是什么？',
];
for (const t of turns) {
  await agent.send(t);
  const last = agent.messages.filter(m => m.role === 'assistant').pop();
  const st = agent.stats();
  console.log(`TURN used=${st.used}/${st.limit} msgs=${st.messages} compressions=${st.compressions} :: ${String(last?.content || '').replace(/\s+/g, ' ').slice(0, 160)}`);
}
const ans = String(agent.messages.filter(m => m.role === 'assistant').pop()?.content || '');
const ok = /青鸾-7/.test(ans) && /x-zse-96/i.test(ans) && /0x5A17/i.test(ans);
console.log('COMPRESSIONS', agent.compressions, 'RECALL_OK', ok);
console.log('SUMMARY_MSG', String(agent.messages.find(m => m._summary)?.content || '').slice(0, 400).replace(/\s+/g, ' '));
process.exit(ok && agent.compressions > 0 ? 0 : 1);
