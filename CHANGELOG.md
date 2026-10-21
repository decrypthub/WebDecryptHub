# 更新日志

各版本详细说明见 `docs/release-notes/`。

## 1.2.2

- 原生嵌入浏览器：Windows / Linux X11 下真实 Chrome 窗口嵌入左侧面板（Wayland 走 XWayland），修复重启后偶发黑屏与 X11 点击聚焦。
- 画面串流更清晰：按 DPR 采集，JPEG q90，静止时 PNG。
- AI 上下文管理：每模型上下文窗口档位（128K–1M / 自定义）、用量明细、两阶段自动压缩、`/compact` 重点说明、压缩标记与摘要展开、消息附件。
- 可选内置 Chromium（Chrome for Testing）内核：下载进度、MD5/SHA-256 校验、删除。
- 应用内确认框替代 `window.confirm`。

详见 [docs/release-notes/1.2.2.md](docs/release-notes/1.2.2.md)。
