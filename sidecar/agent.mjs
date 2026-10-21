// Agent 循环：ReAct + 流式 + 可见工具调用 + 中断。统一工具注册表（MCP 工具 + 本地工具）。
import {chat} from './llm.mjs';
import fsx from 'node:fs';
import {LOCAL_TOOLS} from './localtools.mjs';

const SYSTEM = `你是一个专业的 JavaScript 逆向工程 AI 助手，在一个桌面应用内工作，通过工具操作一个受控的 Chrome 浏览器与本地分析引擎。你的任务是帮助用户分析网页中的签名、加密参数和混淆代码。

工作原则：
1. 使用工具获取真实证据，不要臆测。每一步先说明你要做什么，再调用工具。
2. 典型逆向流程：打开/刷新页面 → 多次触发目标请求 → find_signature_params 找疑似签名 → diff_requests 确认哪些参数每次变化 → get_request_initiator 找调用栈 → search_in_sources/set_breakpoint_on_text 定位生成代码 → get_script_source 取源码 → deobfuscate_code 反混淆 → detect_crypto 识别算法 → run_node(envPatch) 复现验证 → export_code 导出 → generate_report 出报告。
3. 大段代码用 save_script_source/outputFile 落盘，不要把超长内容塞进对话。
4. 断点命中后记得 pause_or_resume 恢复，避免页面卡死。
5. 阶段性发现用 notes_write 记录。
6. 干净环境（重要）：旧登录态、Cookie 中缓存的密钥、localStorage 标记、HTTP 缓存都会污染分析。以下情况先 reset_session(confirm=true) 再重新触发请求：开始抓取某个签名请求前需要“首次加载”的完整链路（例如密钥/票据下发接口）；本地复现与浏览器结果不一致、怀疑密钥来自旧状态时；做“有/无登录态”或“清理前/后”A/B 对比时（先用 get_cookies 记录对比基线）。怀疑设备指纹/风控标记残留或需要完全首次访问时用 restart_browser_fresh(confirm=true)。只想清空抓包而保留状态时用 clear_network_requests。重置后旧 reqid/scriptId 全部失效，需重新列出。
7. 浏览器内存有限：不要在页面里对数 MB 的脚本做整段 fetch/正则/字符串处理；用 search_in_sources 定位后 get_script_source 按 offset/length 小段读取，或 save_script_source（filePath 用相对文件名）落盘后用 grep_file / read_file_slice 在本地检索精读；页面卡死或 evaluate_script 超时时优先走本地文件。
8. JSVMP/强混淆签名（如知乎 x-zse-96、抖音 a_bogus、小红书 x-s、京东 h5st）不要手工还原字节码，走“先调用原函数，再抽离”：
   a) hook_signer(names=[参数名]) → get_hook_records 拿到写入值与调用栈，定位签名入口（模块/全局函数）；webpack 站点用 webpack_expose(search=参数名) 找模块 id。
   b) page_call 在页面主世界直接调用原函数，用真实请求的同一输入复算，与抓包值逐字节一致才算定位成功（有随机/时间因子时先固定 Date.now/Math.random 或比较确定性部分）。
   c) 抽离：webpack_extract(ids) 或 save_script_source 落盘，run_node(envPatch=true) 中 eval(readProjectFile(文件)) 加载，用同样输入复算并比对；按 missing 列表逐步补环境。
   d) 若页面原函数本身输出不确定（含随机数/时间），逐字节对拍改为：①固定随机源后比较，或②“服务端验收”：用本地生成的签名经 page_call 在页面内 fetch 重放同一接口（同 URL/Cookie），应返回正常数据；把签名改坏一位再请求应被拒绝（对照组）。两组结果都要给出。
   d2) 环境差异排查（关键）：若同一份抽离代码“在页面里 eval 执行”生成的签名能通过服务端验收，而 run_node 里生成的被拒（403），说明 VM 内有环境探针（location.toString、history/screen 的 [object X] 标签、canvas.getContext、函数 toString 是否 native、UA 是否含 headless、自动化变量等）。做法：capture_page_env(globals=[页面相关全局变量]) 采集真实环境 → run_node(envPatch=true, env="page-env-xxx.json") 重试；仍失败则对照 missing 列表与页面真实值逐项补齐。自动化/Node 探针（webdriver、$cdc_、phantom、selenium、process 等）保持缺失。
   e) export_code 必须带 selfTest，断言值取自真实抓包。没有逐字节对上的结果一律不得声称“已复现”。
9. 抓包数据：应用从浏览器启动起完整记录所有请求（含请求/响应头、请求体、响应体、时序、发起者），比内核的 list_network_requests 更全。查请求优先用 net_list（可按 param="w_rid"、hasSig、url、types 过滤）→ net_get(id) 看完整请求与响应体 → net_search 在响应体里找密钥/token 来源（如 img_key、salt 由哪个接口下发）→ 大响应体用 net_save_body 落盘后 grep_file。需要交付或离线分析时 net_export_har；用户给了 HAR 文件就 net_load_har。回答“某接口返回了什么”必须引用 net_get 的真实内容，不得编造。

11. 工作区：每个会话有独立 workspace/ 目录。写复现脚本用 workspace_write → workspace_run（捆绑 Node）验证；需要第三方库时 workspace_npm（自动镜像回退）。list 用 workspace_list。
12. 强混淆：优先 ast_deobfuscate（字符串数组/控制流/常量折叠/死代码/重命名）；比 deobfuscate_code 更可控。
13. JSVMP：vmp_trace_install → 触发签名 → vmp_trace_dump 分析 opcode/调用轨迹，辅助定位；仍以 hook_signer + page_call 对拍为主。
14. 反调试：页面一进去就转圈/断点死循环时先 anti_debug_enable；设置里可默认开启。
15. 指纹：补环境前 fingerprint_install → 操作页面 → fingerprint_report，按清单用 capture_page_env / run_node(env=...)。

10. 简洁、用中文回复。完成任务后明确总结结论（参数含义、算法、复现方式、验证证据）。`;

const AUTO_PROMPT = `请对当前页面执行一键自动分析：按阶段推进——
阶段1 侦察：list_scripts 了解页面；提醒用户在浏览器中触发目标操作（如登录/搜索/翻页）2-3 次。
阶段2 定位目标：net_list(hasSig=true) 浏览带签名的接口与响应，find_signature_params 找疑似签名参数，diff_requests 确认变化字段。
阶段3 追溯：对目标请求 get_request_initiator 找调用栈；search_in_sources 搜索参数名；必要时 set_breakpoint_on_text 下断点。
阶段4 分析：get_script_source 取相关源码，deobfuscate_code 反混淆，detect_crypto 识别算法。
阶段5 复现：run_node(envPatch=true) 尝试复现签名，记录缺失环境并补全。
阶段6 产出：notes_write 记录发现，export_code 导出复现代码，generate_report 生成报告。
每阶段结束用一句话小结。如需用户在浏览器手动操作，请明确提示并暂停等待。`;

class Agent {
  constructor({ mcp, browser, projectDir, getSettings, emit, relaunch }) {
    this.mcp = mcp; this.browser = browser; this.projectDir = projectDir; this.relaunch = relaunch;
    this.getSettings = getSettings; this.emit = emit;
    this.messages = [{ role: 'system', content: SYSTEM }];
    this.running = false; this.abort = null; this.wrapUp = false;
  }

  reset() { this.messages = [{ role: 'system', content: SYSTEM }]; this.persist(); }
  // 对话上下文落盘，重启应用后恢复（系统提示总用最新版本）
  histFile() { return this.projectDir ? this.projectDir + '/.agent-history.json' : null; }
  persist() { const f = this.histFile(); if (!f) return; try { fsx.writeFileSync(f, JSON.stringify(this.messages.slice(1).map(m => m.role === 'tool' ? { ...m, content: String(m.content).slice(0, 4000) } : m))); } catch {} }
  restore() { const f = this.histFile(); try { const m = JSON.parse(fsx.readFileSync(f, 'utf8')); if (Array.isArray(m) && m.length) this.messages = [{ role: 'system', content: SYSTEM }, ...m]; } catch {} }

  allTools() {
    const mcpTools = (this.mcp.tools || []).map(t => ({ name: t.name, description: t.description, schema: t.inputSchema }));
    const local = LOCAL_TOOLS.map(t => ({ name: t.name, description: t.description, schema: t.schema }));
    return [...mcpTools, ...local];
  }

  async runTool(name, args) {
    const local = LOCAL_TOOLS.find(t => t.name === name);
    const ctx = { projectDir: this.projectDir, browser: this.browser, mcp: this.mcp, relaunch: this.relaunch };
    if (local) return await local.run(args || {}, ctx);
    if (this.mcp.has(name)) return await this.mcp.call(name, args, this.abort?.signal);
    return { text: `未知工具：${name}`, isError: true };
  }

  // 旧的工具输出压缩：保留最近 keep 条完整，其余截断，控制上下文与花费
  compact(keep = 6, limit = 1500) {
    const idx = this.messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
    for (const i of idx.slice(0, Math.max(0, idx.length - keep))) {
      const m = this.messages[i];
      if (m.content && m.content.length > limit && !m._compacted) { m.content = m.content.slice(0, limit) + `\n…[已压缩，原长 ${m.content.length} 字符；如需完整内容请重新调用工具]`; m._compacted = true; }
    }
  }

  // 把应用自身已捕获的状态告诉模型：MCP 内核只能看到它连接之后的请求，避免模型误判"没有请求"而浪费步数
  stateNote() {
    try {
      const b = this.browser; const page = b.activePage ? b.activePage.url() : (b.pages[0]?.url?.() || '');
      const api = (b.requests || []).filter(r => r.type === 'xhr' || r.type === 'fetch');
      const sample = [...new Set(api.map(r => r.method + ' ' + r.url.split('?')[0]))].slice(-15);
      return `【当前状态（应用自动附加）】当前页面：${page || '无'}；应用已捕获请求 ${b.requests?.length || 0} 条（XHR/Fetch ${api.length} 条，find_signature_params / diff_requests 直接使用这些数据）。` +
        `注意：list_network_requests 等浏览器工具只记录内核连接之后的请求，若为空请 navigate_page(reload) 重新触发。` +
        (sample.length ? `\n近期 XHR/Fetch 接口：\n- ${sample.join('\n- ')}` : '');
    } catch { return ''; }
  }

  wire() { return this.messages.map(({ _compacted, ...m }) => m); }

  async send(userText, { auto, maxSteps: stepsOverride, tokenBudget } = {}) {
    if (this.running) throw new Error('Agent 正在运行');
    this.running = true; this.abort = new AbortController();
    const settings = this.getSettings();
    const content = auto ? AUTO_PROMPT : userText;
    const note = this.stateNote();
    this.messages.push({ role: 'user', content: note ? content + '\n\n' + note : content });
    this.emit('user', content);
    const usage = { prompt: 0, completion: 0, reasoning: 0, cached: 0, calls: 0, ms: 0 };
    const budget = tokenBudget || settings.tokenBudget || 0;
    let stop = '';
    try {
      let steps = 0; const maxSteps = stepsOverride || settings.maxSteps || 40;
      while (true) {
        if (this.abort.signal.aborted) { stop = 'interrupted'; break; }
        const final = this.wrapUp || steps >= maxSteps || (budget && usage.prompt + usage.completion >= budget);
        if (final) {
          stop = this.wrapUp ? 'time-limit' : steps >= maxSteps ? 'max-steps' : 'budget';
          this.messages.push({ role: 'user', content: `【系统】已达${stop === 'max-steps' ? `步数上限（${maxSteps} 步）` : stop === 'time-limit' ? '时间上限' : 'Token 预算上限'}，请不要再调用工具，直接用中文总结目前的全部发现：目标参数、所在脚本与函数、算法判断、复现进度与缺口。` });
        }
        steps++;
        this.compact();
        this.emit('assistant-start', { step: steps });
        const t0 = Date.now();
        let res;
        // 网络抖动（流中途 ETIMEDOUT/ECONNRESET 等）不应终止整个分析：丢弃本步部分输出，退避后重做本步，最多 3 次
        for (let att = 0; ; att++) {
          try {
            res = await chat(settings, this.wire(), final ? [] : this.allTools(), { onDelta: d => this.emit('delta', d), onReasoning: d => this.emit('reasoning', d), signal: this.abort.signal });
            break;
          } catch (e) {
            const msg = String(e?.message || e);
            if (this.abort.signal.aborted || att >= 3 || !/ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|EAI_AGAIN|timed out|空闲|idle|terminated|429|5\d\d/i.test(msg)) throw e;
            this.emit('log', `模型连接中断（${msg.slice(0, 80)}），${5 * (att + 1)}s 后重试本步（${att + 1}/3）`);
            this.emit('retry', { step: steps, attempt: att + 1, error: msg.slice(0, 200) });
            await new Promise(r => setTimeout(r, 5000 * (att + 1)));
            this.emit('assistant-start', { step: steps });
          }
        }
        const ms = Date.now() - t0;
        usage.calls++; usage.ms += ms;
        if (res.usage) {
          usage.prompt += res.usage.prompt_tokens || 0; usage.completion += res.usage.completion_tokens || 0;
          usage.reasoning += res.usage.completion_tokens_details?.reasoning_tokens || 0; usage.cached += res.usage.prompt_tokens_details?.cached_tokens || 0;
        }
        this.emit('usage', { step: steps, ms, last: res.usage || null, total: { ...usage } });
        this.emit('assistant-end', { content: res.content, reasoning: res.reasoning || '', finishReason: res.finishReason || null });
        const asMsg = { role: 'assistant', content: res.content || '' };
        if (res.reasoning) asMsg.reasoning_content = res.reasoning;
        if (res.toolCalls?.length) asMsg.tool_calls = res.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argError ? (tc.rawArgs || '{}') : JSON.stringify(tc.args) } }));
        if (asMsg.tool_calls) { for (const t of asMsg.tool_calls) { try { JSON.parse(t.function.arguments); } catch { t.function.arguments = '{}'; } } }
        this.messages.push(asMsg);
        if (final || !res.toolCalls?.length) { if (!stop) stop = 'completed'; break; }
        for (const tc of res.toolCalls) {
          if (this.abort.signal.aborted) break;
          this.emit('tool-start', { id: tc.id, name: tc.name, args: tc.args, step: steps });
          let r; const tt = Date.now();
          if (tc.argError) r = { text: '[参数错误] ' + tc.argError + '。请用合法 JSON 重新调用。', isError: true };
          else {
            try { r = await this.runTool(tc.name, tc.args); }
            catch (e) { r = { text: '[工具错误] ' + (e.message || e), isError: true }; }
          }
          const text = typeof r?.text === 'string' ? r.text : JSON.stringify(r ?? '(空)');
          this.emit('tool-end', { id: tc.id, name: tc.name, text, isError: !!r?.isError, ms: Date.now() - tt });
          this.messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: (text || '(空)').slice(0, 12000) });
        }
        // 中断时补齐未执行的工具结果，避免下一轮出现缺失 tool_call_id 的 400
        const last = this.messages.filter(m => m.role === 'assistant').pop();
        for (const t of last?.tool_calls || []) if (!this.messages.some(m => m.role === 'tool' && m.tool_call_id === t.id)) this.messages.push({ role: 'tool', tool_call_id: t.id, name: t.function.name, content: '[已中断，未执行]' });
      }
    } catch (e) {
      stop = 'error';
      this.emit('error', e.message || String(e));
    } finally {
      this.running = false; this.abort = null; this.wrapUp = false;
      this.persist();
      this.emit('done', { stop, usage });
    }
  }

  // 软停止：下一轮不再给工具，让模型总结
  finishSoon() { if (this.running) this.wrapUp = true; }

  interrupt() { if (this.abort) this.abort.abort(); }
}

export {Agent};
