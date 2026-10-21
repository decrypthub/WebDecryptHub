# Context management and compaction: research and design

Sources were read on 2026-10-21 (shallow clones, commit in brackets).

| Project | Files / URLs read |
|---|---|
| Pi coding-agent (badlogic/pi-mono @8243221) | `packages/coding-agent/docs/compaction.md`, `docs/sessions.md`, `src/core/compaction/compaction.ts` (DEFAULT_COMPACTION_SETTINGS, SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT, `generateSummary`), `src/core/compaction/utils.ts` (TOOL_RESULT_MAX_CHARS, `serializeConversation`) |
| OpenAI Codex CLI (openai/codex @21b1f5f) | `codex-rs/prompts/templates/compact/prompt.md`, `summary_prefix.md`, `codex-rs/core/src/compact.rs` (COMPACT_USER_MESSAGE_MAX_TOKENS, `build_compacted_history`), `codex-rs/protocol/src/openai_models.rs` (`auto_compact_token_limit`), `codex-rs/tui/src/bottom_pane/footer.rs` ("N% context left"), `codex-rs/cli/src/main.rs` (resume / fork) |
| opencode (sst/opencode @4d59657) | `packages/core/src/session/compaction.ts` (RESERVE_SHARE, RESERVE_MIN, SHRINK_STEPS, SUMMARY_TEMPLATE, SUMMARY_RULES, `buildPrompt`) |
| Gemini CLI (google-gemini/gemini-cli @c1740d2) | `packages/core/src/context/chatCompressionService.ts` (DEFAULT_COMPRESSION_TOKEN_THRESHOLD, COMPRESSION_PRESERVE_THRESHOLD, COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET, `truncateHistoryToBudget`), `packages/core/src/prompts/snippets.ts` (`<state_snapshot>`), `context/toolDistillationService.ts` |
| Claude Code (docs, closed source) | https://code.claude.com/docs/en/context-window , https://code.claude.com/docs/en/how-claude-code-works (When context fills up), https://code.claude.com/docs/en/model-config (Default auto-compact thresholds), https://code.claude.com/docs/en/commands (`/compact`, `/context`, `/autocompact`), https://docs.anthropic.com/en/docs/claude-code/costs , https://platform.claude.com/docs/en/build-with-claude/context-editing , issue https://github.com/anthropics/claude-code/issues/42542 (microcompact) |

## Findings

**Thresholds**
- Pi: compacts when `contextTokens > contextWindow - reserveTokens` (reserve 16 384), and once on provider overflow or `stopReason: length` (compact and retry).
- Codex: `auto_compact_token_limit` defaults to 90% of the context window; a config value can only lower it.
- opencode: keeps 15% of the window free, and at least 16k; on overflow it shrinks the retry to 0.7, then 0.5, then 0.35 of the size.
- Gemini CLI: compresses at 50% of the window and preserves the newest 30%.
- Claude Code: compacts near the limit (about 967K on 1M models). `/autocompact 500k` sets an explicit window. It stops after a few attempts when it starts thrashing.

**What stays verbatim**
- Pi: walks back until `keepRecentTokens` (20k) is reached. It never cuts at a tool result, and a too-long single turn is split and gets an extra prefix summary.
- Codex: re-adds recent user messages, up to 20k tokens, after the summary.
- opencode: a `keep` token budget for the tail.
- Claude Code: keeps user requests and key snippets, then re-reads up to 5 recent files (≤5k tokens each) and re-injects system, CLAUDE.md and the plan.

**Summary prompt structure**
- Pi: Goal / Constraints & Preferences / Progress (Done, In Progress, Blocked) / Key Decisions / Next Steps / Critical Context, plus read-files and modified-files lists. With a previous summary it uses an UPDATE prompt (incremental).
- opencode: Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important Context, with rules: terse bullets, preserve exact paths, identifiers and errors, do not mention compaction.
- Gemini CLI: XML `<state_snapshot>` with overall_goal, active_constraints, key_knowledge, artifact_trail, file_system_state, recent_actions, task_state.
- Codex: a short handoff prompt, and the result is prefixed so the next model knows it is a summary from another model.
- All of them serialize the history as plain text (`[User]:` / `[Assistant]:` / `[Tool result]:`) so the summarizer does not continue the conversation.

**Tool results**
- Pi truncates tool results to 2 000 characters inside the summarization input.
- Gemini keeps a 50k-token budget for function responses: older large ones are truncated and saved to a file first.
- Claude Code clears old tool outputs first ("microcompact" or context-editing `clear_tool_uses`: trigger, keep the last N, exclude tools) and only then summarizes.

**User instructions**
- Pi: `/compact [instructions]` adds "Additional focus: …".
- Claude Code: `/compact focus on …` and a "Compact Instructions" section in CLAUDE.md.

**Showing remaining context**
- Codex footer: "N% context left".
- Claude Code: `/context` gives a per-category breakdown (system, tools, MCP, memory, messages, free space) and the status line.
- Pi: a footer with tokens and percentage of the window.

**Sessions**
- Pi stores a tree with `/tree`, `/fork`, `/clone` and `--resume`; compaction is an appended entry, so the history stays on disk.
- Codex has `resume` and `fork`.
- Claude Code has `/resume`, `/rewind` → "Summarize from / up to here", and `/clear`.

## Our design (WebDecryptHub)
- **Window per model**: `openai.contextWindow` / `anthropic.contextWindow` stored with the model config. Quick chips 128K / 256K / 300K / 500K / 1M plus custom; empty means inferred from the model name. It can be set from Settings and from the meter menu.
- **Threshold**: `compactAt` (default 0.85, range 0.5–0.95), measured against the window minus a 16k output reserve (Pi / opencode). A cooldown, and at most 2 auto attempts per turn (Claude Code thrash guard).
- **Stage 1, microcompact** (Claude Code, Gemini): replace old tool results with refs and keep the last 3 intact. Full outputs stay in `.ctx/` and can be read back with `context_ref_read` or `net_get`. If the context then fits, no LLM call is made.
- **Stage 2, LLM summary** (Pi / opencode):
  - The serialized transcript truncates tool results to 2 000 characters.
  - Structured sections: 目标 / 用户约束与事实 / 关键发现 / 涉及的脚本与文件 / 涉及的请求 / 当前状态 / 下一步 / 关键数据.
  - Update mode when a previous summary exists.
  - Optional user instructions (`/compact 关注签名算法`).
  - The most recent ~20k tokens (capped at 25% of the window) stay verbatim, cut only at user or assistant messages.
- **Chat marker**: a compaction divider showing reason, before → after and the instructions, with an expandable summary.
- **Meter**: used / limit and %, with a popover breakdown (system prompt, tool definitions, history, attachments, tool results, summary).
- **Sessions**: one history per tab, persisted; "新对话" archives to `.chats/`. A branch/fork tree like Pi's is future work.

## 实现状态（1.2.2）

| 项 | 位置 |
|---|---|
| 每模型窗口 `openai/anthropic.contextWindow`，旧全局字段自动迁移；未设置按模型名推断 | `sidecar/context.mjs` `limitInfo` / `sidecar/settings.mjs` |
| 档位 自动 / 128K / 256K / 300K / 500K / 1M / 自定义（设置页与用量弹层共用 `WindowChips`） | `ui/src/forms.jsx` |
| 触发线 `min(compactAt × 窗口, 窗口 − min(16k, 10%))`，`compactAt` 默认 0.85（80/85/90 可选） | `compactTrigger` |
| 第一阶段 microcompact：旧工具结果（保留最近 3 条）落盘 `.ctx/` 换成引用，够用则不调用 LLM | `microcompact` |
| 第二阶段结构化摘要：最近 min(20k, 25% 窗口) tokens 原样保留；已有摘要时走 UPDATE 合并；工具结果在转写中截到 2000 字符；用户指令作为“重点保留” | `splitByTokens` / `buildSummaryRequest` |
| 防抖：每轮最多 2 次自动压缩 + 需再增长 10% 窗口才再次触发；仍逼近 97% 时硬截断兜底 | `agent.mjs` |
| `/compact 重点…` 与弹层输入框 | `ui/src/App.jsx` |
| 用量弹层：used / limit / %、分类条（系统、工具定义、摘要、对话、附件、工具结果）、压缩线 | `ContextMeter` |
| 聊天内压缩分隔线，可展开查看摘要 | `CompactMark` |

真实 LLM 回归：`node sidecar/live/ctx-live.mjs`（手动带指令压缩 → 自动压缩（UPDATE）→ 回忆早期事实）。
