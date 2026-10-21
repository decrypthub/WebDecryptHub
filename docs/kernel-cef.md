# CEF kernel option (design note, not implemented)

Goal: true in-process embedding on macOS, where WebDecryptHub can't reparent another app's
`NSWindow`. Windows and Linux X11 already reparent the real Chrome window (`src-tauri/src/embed.rs`).

## Why macOS needs CEF
- On macOS a window can't host another process's window. The only ways to show Chrome
  inside the app are screencast (current fallback) or rendering Chromium in our own process.
- CEF (Chromium Embedded Framework) renders into an `NSView` that we own. We can add it as a
  subview over the left pane, the same way the Win32 host window works.

## What it would take
1. **Runtime**: ship the CEF binary distribution for mac-arm64 and mac-x64 (about 250 MB per arch).
   It needs the `Chromium Embedded Framework.framework` plus four helper app bundles
   (GPU, Renderer, Plugin, Alerts), each code-signed and notarized with the hardened-runtime
   entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`).
2. **Rust integration**: use `cef-rs` (tauri-apps/cef-rs) or a thin C wrapper around
   `cef_initialize` / `CefBrowserHost::CreateBrowser` in windowed mode with the parent set to an
   `NSView` added to the Tauri window's content view. Run `CefDoMessageLoopWork` from the Tauri
   main loop, or use `external_message_pump`, because Tauri already owns `NSApplication`.
   CEF's `CefAppProtocol` requirement on the `NSApplication` subclass conflicts with tao. This
   is the main integration risk and needs a tao patch or a separate CEF host process plus
   `CALayerHost` / `CARemoteLayer` sharing (no public API).
3. **CDP**: start CEF with `remote_debugging_port` (127.0.0.1, random), write the port like
   `DevToolsActivePort`, and connect Patchright with `chromium.connectOverCDP` instead of
   `launchPersistentContext`. The anti-debug, fingerprint, netcap and injector code
   all go through CDP and should work unchanged. Patchright's launch-time stealth patches
   (args, `--enable-automation` removal) must be reproduced as CEF command-line switches.
4. **Profiles and sessions**: use one `CefRequestContext` per session tab, each with its own
   `cache_path` (current per-session profile dirs). Isolated or temporary profiles map to
   in-memory request contexts.
5. **Fingerprint**: CEF's UA, client hints and `navigator.userAgentData` brands differ from
   stock Chrome. They must be overridden to match a real Chrome version, or sites will treat
   the browser as embedded or automated. CEF also ships without Widevine or proprietary codecs
   unless built with them.
6. **Updates**: tie the CEF version to the app release, about every 4 weeks for security fixes.
   The download size argues for an on-demand download like the current "Bundled Chromium"
   kernel (`sidecar/chrome.mjs`: size, MD5 and sha256 checks, delete).

## Suggested plan
- Phase 1: macOS only, behind `kernel: 'cef'`. Download the CEF runtime on demand and verify
  its sha256 against a manifest we publish (CEF builds have no x-goog-hash).
- Phase 2: run a separate CEF host process that renders into an `IOSurface` and shows it in
  the app via `CALayer` (off-screen rendering with `OnAcceleratedPaint`). This avoids the
  `NSApplication` conflict, with input forwarded through Mojo-free IPC (stdin/stdout or a
  local socket).
- Keep screencast as the fallback for every platform.

Estimate: 3–5 engineer-weeks, mostly signing, notarization and the message-loop integration.
