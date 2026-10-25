# WebDecryptHub (WDH)

独立的浏览器分析 MCP / CLI，作为 [DecryptHub](https://github.com/decrypthub/DecryptHub) 的可选 Web 组件，也可接入其他支持 stdio MCP 的 Agent。

WDH = 可替换 Chromium 内核（可选 CloakBrowser）+ 浏览器控制/抓包/调试能力 + MCP。Harness、模型配置、会话历史和桌面窗口由 DecryptHub 单独维护。

## 快速开始

要求 Node.js 24 或更新版本，以及系统 Chrome / Edge，或用户单独安装的 CloakBrowser。

```sh
npm ci --ignore-scripts
node src/cli.mjs doctor
node src/cli.mjs mcp --browser system --root /absolute/workspace
```

MCP 客户端配置（将路径替换为实际绝对路径）：

```json
{
  "mcpServers": {
    "wdh": {
      "command": "node",
      "args": ["/absolute/WebDecryptHub/src/cli.mjs", "mcp", "--browser", "system", "--root", "/absolute/workspace", "--data-dir", "/absolute/wdh-data"]
    }
  }
}
```

默认 browser 为 cloak。使用系统浏览器时请明确指定 `--browser system`。自定义内核使用 `--browser custom --executable <绝对路径>`，无头模式加 `--headless`。不同 MCP 实例应使用不同 data-dir，避免争用同一个持久化浏览器 Profile。

安装 CloakBrowser：

```sh
node src/cli.mjs kernel install cloak
node src/cli.mjs mcp --browser cloak --root /absolute/workspace
```

内核下载遵循官方 Release 和独立二进制条款；WDH 源码及组件包不附带 Cloak 或 Chromium 二进制。

## 工具

- `browser_*`：导航、页面快照、元素输入、截图、网络记录和响应体。
- `discover_tools`，group 为 `debugger`：加载当前调试器的真实工具 schema；支持搜索脚本、断点、调用栈、变量、单步与恢复、请求发起栈等能力。
- 指纹观测和反调试工具：按需观测站点读取的 API，不自动修改用户的 Agent 权限。

浏览器工具默认可用，调试工具按需加载。复杂 JSVM / WASM 的完整语义还原不是现成保证；采样、追踪限额和证据验证需要按目标单独设计。本轮重点是把已有能力独立运行与维护。

## 测试和组件构建

```sh
npm test
npm run build
```

测试使用本机浏览器和本地 HTTP 样本，覆盖 DOM、抓包、源码搜索、真实断点/单步/恢复、过期目标和文件路径边界。设置 `WDH_TEST_EXECUTABLE` 可使用指定内核重复测试。

构建目录记录在 `dist/latest-component.txt`，包含源码、生产依赖和逐文件 SHA-256。它供 DecryptHub 的显式本地组件安装器使用；不等同于已签名 GitHub 发行版。安装步骤见 [DecryptHub 组件文档](https://github.com/decrypthub/DecryptHub/blob/main/docs/components.md)。

## 安全与来源

MCP 客户端负责审批工具操作。`--root` 限定输出文件，不是操作系统沙箱。不要向模型暴露 `--desktop` 宿主控制通道；它仅供拥有该 stdio 子进程的 DecryptHub 使用。请求和响应可能含敏感信息，按工作项目单独管理 data-dir。

由原 WebDecryptHub 桌面仓库拆分，保留 Git 历史；来源见 [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md)。包含 [js-reverse-mcp](https://github.com/zhizhuodemao/js-reverse-mcp) 的修改版本，保留 Apache-2.0 LICENSE/NOTICE 和 Google LLC 等源文件版权声明。WDH 自有代码采用 MIT，第三方代码遵循各自协议。参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
