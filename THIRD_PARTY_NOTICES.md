# Third-party notices

WebDecryptHub incorporates or depends on the following major third-party components.
This list is not exhaustive; see each package’s own license in `node_modules` after install.

## Vendored

| Component | Location | License |
|-----------|----------|---------|
| js-reverse-mcp (js-reverse-core) | `sidecar/vendor/core-build/` | Apache-2.0 — see `LICENSE` and `NOTICE` in that directory |

## Runtime / build (selected)

| Package | License (typical) | Role |
|---------|-------------------|------|
| Tauri 2 | MIT / Apache-2.0 | Desktop shell |
| tauri-plugin-dialog | MIT / Apache-2.0 | Save dialogs |
| tauri-plugin-updater | MIT / Apache-2.0 | GitHub Releases updates |
| tauri-plugin-process | MIT / Apache-2.0 | Relaunch after update |
| React / Vite | MIT | UI |
| @zhizhuodemao/patchright | Apache-2.0 | Stealth Chromium automation |
| @babel/* | MIT | AST deobfuscation |
| webcrack | MIT | Bundle unpack / deobfuscation helper |
| jsdom | MIT | Optional Node env mode |
| @modelcontextprotocol/sdk | MIT | MCP protocol types |
| ws | MIT | WebSocket |
| zod | MIT | Schema validation |

Chromium / Google Chrome is **not** redistributed; the app downloads or uses a local browser at runtime.
