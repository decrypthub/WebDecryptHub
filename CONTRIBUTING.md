# Contributing

Thank you for helping improve WebDecryptHub.

## Development

1. Prerequisites: Node 20+, Bun (sidecar compile), Rust stable, platform WebView2 (Windows) or WebKitGTK (Linux).
2. `npm ci` at repo root (UI) and `npm ci --ignore-scripts` in `sidecar/` (uses `isolated-vm` prebuilds).
3. `npm run build:ui`
4. Linux: `cargo run --manifest-path src-tauri/Cargo.toml` (dev) or build sidecar with `bun scripts/build-sidecar.mjs linux`.
5. Windows release packaging is covered by `.github/workflows/release.yml`.

## Guidelines

- Do **not** commit API keys, cookies, HAR files, or third-party site script captures.
- Keep changes focused; update docs when behavior changes.
- Run a quick secret scan before opening a PR (`rg` for tokens / absolute machine paths).
- By contributing, you agree your changes are licensed under the MIT License (project) and you will not add incompatible licensed code without updating `THIRD_PARTY_NOTICES.md`.
