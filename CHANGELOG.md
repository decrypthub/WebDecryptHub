# 更新日志

各版本详细说明见 `docs/release-notes/`。

## 1.3.1

- 应用内更新会先显示下载进度和「正在安装」，等侧车进程树退出后再交给安装程序，装完自动重新打开。
- 安装程序只结束安装目录里的 WebDecryptHub、sidecar 和捆绑 Node，文件被占用时会先重试。
- NSIS 安装界面换成产品自己的页眉、侧栏和图标。

详见 [docs/release-notes/1.3.1.md](docs/release-notes/1.3.1.md)。

## 1.3.0

- 工作区精确编辑 `workspace_edit` 与搜索 `workspace_grep`。
- 会话工作区 shell，以及后台任务的输出查看和结束；子进程不再继承 `WDH_LLM_API_KEY`。
- 会话模式：安全（应用内确认）、自主、计划（只读，确认后执行）。默认安全。
- 对话顶部的逆向任务清单，随会话保存。
- 请求、脚本选区和断点调用栈可以一键挂到 AI 对话。

详见 [docs/release-notes/1.3.0.md](docs/release-notes/1.3.0.md)。

## 1.2.2

- 原生嵌入浏览器：Windows / Linux X11 下真实 Chrome 窗口嵌入左侧面板（Wayland 走 XWayland），修复重启后偶发黑屏与 X11 点击聚焦。
- 画面串流更清晰：按 DPR 采集，JPEG q90，静止时 PNG。
- AI 上下文管理：每模型上下文窗口档位（128K–1M / 自定义）、用量明细、两阶段自动压缩、`/compact` 重点说明、压缩标记与摘要展开、消息附件。
- 可选内置 Chromium（Chrome for Testing）内核：下载进度、MD5/SHA-256 校验、删除。
- 应用内确认框替代 `window.confirm`。

详见 [docs/release-notes/1.2.2.md](docs/release-notes/1.2.2.md)。
