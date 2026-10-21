// LLM Provider：OpenAI 兼容 + Anthropic 原生，统一流式 + 工具调用（仅真实 API）
import http from 'node:http';
import https from 'node:https';
import {URL} from 'node:url';

function post(urlStr, headers, body, onChunk, signal, idleMs = 180000) {
  // 注意：Bun 下 req.destroy(err) 不一定触发 'error' 事件，原实现会导致 Promise 永不结束（Agent 卡死）。
  // 这里所有结束路径都直接 settle，并用 settled 标志防止重复。
  return new Promise((resolve, reject) => {
    let settled = false, idle;
    const ok = () => { if (settled) return; settled = true; clearTimeout(idle); resolve(); };
    const fail = e => { if (settled) return; settled = true; clearTimeout(idle); reject(e); try { req.destroy(); } catch {} };
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'POST', headers }, res => {
      let buf = '';
      if (res.statusCode >= 400) { let e = ''; res.on('data', d => (e += d)); res.on('end', () => { const err = new Error(`HTTP ${res.statusCode}: ${e.slice(0, 500)}`); err.status = res.statusCode; err.retryable = res.statusCode === 429 || res.statusCode >= 500; fail(err); }); return; }
      res.setEncoding('utf8');
      res.on('data', d => { if (settled) return; arm(); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { onChunk(line); } catch (e) { return fail(e); } } });
      res.on('end', () => { try { if (buf) onChunk(buf); ok(); } catch (e) { fail(e); } });
      res.on('error', fail); res.on('aborted', () => fail(Object.assign(new Error('连接被服务器中断'), { retryable: true })));
    });
    function arm() { clearTimeout(idle); idle = setTimeout(() => fail(Object.assign(new Error(`模型响应超时（${Math.round(idleMs / 1000)}s 无数据）`), { retryable: true })), idleMs); }
    arm();
    req.on('error', fail);
    if (signal) { if (signal.aborted) return fail(new Error('已中断')); signal.addEventListener('abort', () => fail(new Error('已中断')), { once: true }); }
    req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function retryable(e) { if (!e || /已中断/.test(e.message)) return false; if (e.retryable) return true; if (e.status) return e.status === 429 || e.status >= 500; return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|ECONNREFUSED/i.test(e.message); }

function toOpenAITools(tools) {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: (t.description || '').slice(0, 1024), parameters: t.schema || t.inputSchema || { type: 'object', properties: {} } } }));
}

// 统一返回 { content, reasoning, toolCalls:[{id,name,args,argError?}], usage, finishReason }
// 兼容 DeepSeek 等返回 reasoning_content 的模型：推理内容单独收集（不混入正文），并在工具循环中原样回传；
// 若服务端拒绝消息中的 reasoning_content（部分官方 reasoner 会 400），自动剥离后重试。
async function chatOpenAI(cfg, messages, tools, { onDelta, onReasoning, signal }) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey };
  let stripReasoning = false, useStreamOpts = true;
  for (let attempt = 0; ; attempt++) {
    const msgs = messages.map(m => {
      if (m.role !== 'assistant') return m;
      const { reasoning_content, ...rest } = m;
      return (!stripReasoning && reasoning_content) ? { ...rest, reasoning_content } : rest;
    });
    const body = { model: cfg.model, messages: msgs, stream: true, temperature: cfg.temperature ?? 0.2 };
    if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
    if (useStreamOpts) body.stream_options = { include_usage: true };
    if (tools.length) { body.tools = toOpenAITools(tools); body.tool_choice = 'auto'; }
    let content = '', reasoning = '', usage = null, finishReason = null, emitted = false; const calls = {};
    try {
      await post(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', headers, body, line => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (data === '[DONE]' || !data) return;
        let j; try { j = JSON.parse(data); } catch { return; }
        if (j.error) { const e = new Error('模型返回错误: ' + (j.error.message || JSON.stringify(j.error)).slice(0, 300)); e.retryable = true; throw e; }
        if (j.usage) usage = j.usage;
        const ch = j.choices?.[0]; if (!ch) return;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch.delta; if (!d) return;
        const rc = d.reasoning_content ?? d.reasoning;
        if (rc) { reasoning += rc; onReasoning && onReasoning(rc); }
        if (d.content) { content += d.content; emitted = true; onDelta(d.content); }
        for (const tc of d.tool_calls || []) {
          const idx = tc.index ?? 0;
          calls[idx] = calls[idx] || { id: tc.id, name: '', args: '' };
          if (tc.id) calls[idx].id = tc.id;
          if (tc.function?.name) calls[idx].name += tc.function.name;
          if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
        }
      }, signal, cfg.idleTimeoutMs || 180000);
    } catch (e) {
      const msg = String(e.message || e);
      if (e.status === 400 && !stripReasoning && /reasoning/i.test(msg)) { stripReasoning = true; continue; }
      if (e.status === 400 && useStreamOpts && /stream_options/i.test(msg)) { useStreamOpts = false; continue; }
      if (!emitted && attempt < 2 && retryable(e)) { await sleep(2000 * (attempt + 1)); continue; }
      throw e;
    }
    const toolCalls = Object.values(calls).filter(c => c.name).map(c => {
      const id = c.id || 'call_' + Math.random().toString(36).slice(2);
      const raw = (c.args || '').trim();
      if (!raw) return { id, name: c.name, args: {}, rawArgs: '' };
      try { return { id, name: c.name, args: JSON.parse(raw), rawArgs: raw }; }
      catch { return { id, name: c.name, args: {}, rawArgs: raw, argError: '工具参数不是合法 JSON：' + raw.slice(0, 200) }; }
    });
    return { content, reasoning, toolCalls, usage, finishReason };
  }
}

async function chatAnthropic(cfg, messages, tools, { onDelta, signal }) {
  const headers = { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
  // 转换 messages：system 提取，tool 结果转 content blocks
  let system = '';
  const msgs = [];
  for (const m of messages) {
    if (m.role === 'system') { system += m.content + '\n'; continue; }
    if (m.role === 'tool') { msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] }); continue; }
    if (m.role === 'assistant' && m.tool_calls) {
      const blocks = []; if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
      msgs.push({ role: 'assistant', content: blocks }); continue;
    }
    msgs.push({ role: m.role, content: m.content });
  }
  const body = { model: cfg.model, max_tokens: cfg.maxTokens || 4096, system, messages: msgs, stream: true, temperature: cfg.temperature ?? 0.2 };
  if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: (t.description || '').slice(0, 1024), input_schema: t.schema || t.inputSchema || { type: 'object', properties: {} } }));
  let content = ''; const calls = []; let cur = null;
  await post(cfg.baseUrl.replace(/\/$/, '') + '/v1/messages', headers, body, line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim(); if (!data) return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') cur = { id: j.content_block.id, name: j.content_block.name, args: '' };
    if (j.type === 'content_block_delta') {
      if (j.delta?.type === 'text_delta') { content += j.delta.text; onDelta(j.delta.text); }
      if (j.delta?.type === 'input_json_delta' && cur) cur.args += j.delta.partial_json;
    }
    if (j.type === 'content_block_stop' && cur) { calls.push({ id: cur.id, name: cur.name, args: safeJson(cur.args) }); cur = null; }
  }, signal);
  return { content, toolCalls: calls };
}

function safeJson(s) { if (typeof s === 'object') return s; try { return JSON.parse(s || '{}'); } catch { return {}; } }

async function chat(settings, messages, tools, hooks) {
  const p = settings.provider === 'anthropic' ? 'anthropic' : 'openai';
  const key = p === 'anthropic' ? settings.anthropic.apiKey : settings.openai.apiKey;
  if (!key) throw new Error('尚未配置 API Key，请在「设置」页填写后重试');
  if (p === 'anthropic') return chatAnthropic({ ...settings.anthropic, temperature: settings.temperature, maxTokens: settings.maxTokens }, messages, tools, hooks);
  return chatOpenAI({ ...settings.openai, temperature: settings.temperature, maxTokens: settings.openaiMaxTokens, idleTimeoutMs: settings.idleTimeoutMs }, messages, tools, hooks);
}

export {chat};

// 连接测试：轻量请求，返回友好中文结果
export async function testConnection(settings) {
  const p = settings.provider;
  try {
    if (p === 'anthropic') {
      const c = settings.anthropic;
      if (!c.apiKey) return { ok: false, message: '请先填写 Claude API Key。' };
      const r = await fetch(c.baseUrl.replace(/\/$/, '') + '/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: c.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (r.ok) return { ok: true, message: `连接成功，模型 ${c.model} 可用。` };
      const t = await r.text();
      return { ok: false, message: friendlyHttp(r.status, t) };
    }
    const c = settings.openai;
    if (!c.apiKey) return { ok: false, message: '请先填写 API Key。' };
    const r = await fetch(c.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + c.apiKey } });
    if (r.ok) { const j = await r.json().catch(() => ({})); const n = (j.data || []).length; return { ok: true, message: `连接成功${n ? `，检测到 ${n} 个模型` : ''}。` }; }
    // 某些兼容端点不支持 /models，退化为一次极小对话
    const r2 = await fetch(c.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
      body: JSON.stringify({ model: c.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    if (r2.ok) return { ok: true, message: `连接成功，模型 ${c.model} 可用。` };
    const t = await r2.text();
    return { ok: false, message: friendlyHttp(r2.status, t) };
  } catch (e) {
    return { ok: false, message: '网络错误：' + friendlyNet(e) };
  }
}
function friendlyHttp(status, body) {
  const b = (body || '').slice(0, 160);
  if (status === 401 || status === 403) return 'API Key 无效或无权限（401/403）。请检查密钥是否正确。';
  if (status === 404) return 'Base URL 或模型路径不存在（404）。请检查 Base URL 是否填写完整（通常以 /v1 结尾）。';
  if (status === 429) return '请求过于频繁或额度不足（429）。请稍后重试或检查账户额度。';
  if (status >= 500) return `服务端错误（${status}）。可能是服务商暂时不可用。`;
  return `请求失败（${status}）：${b}`;
}
function friendlyNet(e) {
  const m = String(e && e.message || e);
  if (/ENOTFOUND|getaddrinfo/.test(m)) return '无法解析域名，请检查 Base URL 和网络连接。';
  if (/ECONNREFUSED/.test(m)) return '连接被拒绝，请检查地址/端口或本地服务是否启动。';
  if (/certificate|TLS|SSL/i.test(m)) return '证书/TLS 错误，请检查地址是否为 https 且证书有效。';
  if (/timeout|ETIMEDOUT/i.test(m)) return '连接超时，请检查网络或代理设置。';
  return m;
}
