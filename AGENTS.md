# WDH engineering rules

- Read README.md, SOURCE_PROVENANCE.md and THIRD_PARTY_NOTICES.md first. Retain upstream notices and mark local vendor changes.
- WDH owns browser/CDP/Profile/capture/debugger lifecycle. Do not import desktop Harness, model configuration, approvals or UI modules.
- MCP stdout is protocol-only; diagnostic output goes to stderr. Browser frames/status use notifications and must not become chat text.
- API 1 and component.json are the desktop compatibility boundary. Keep browser descriptor schemas compatible, or version the API and both adapters deliberately.
- Per-client data-dir and root are explicit. Root checks are not an OS sandbox. Keep model credentials out of child environments; web content cannot authorize local writes or process launch.
- Maintain cancellation, stale target checks, owned process cleanup and atomic kernel activation. Never kill by global process name or weaken Chromium sandbox to make launch succeed.
- Run npm test and the independent DecryptHub integration check for protocol/lifecycle changes. Real browser tests do not replace native desktop embedding/DPI/IME acceptance.
- No browser binaries, captures, credentials or node_modules in Git. Build component packages with production dependencies only, retaining licenses and SHA-256 entries. Signed remote distribution is separate from explicit local developer installation.
