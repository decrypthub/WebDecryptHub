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

- `browser_*`：导航、页面快照、元素输入、网络记录和响应体；另有 `browser_state`（URL/标题/挑战页识别）、`browser_reload`、`browser_close`、`browser_har`（导出 HAR）和 `list_console_messages`（CDP 控制台日志）。
- `discover_tools`，group 为 `debugger`：加载当前调试器的真实工具 schema；支持搜索脚本、断点、调用栈、变量、单步与恢复、请求发起栈等能力。
- 指纹观测和反调试工具：按需观测站点读取的 API，不自动修改用户的 Agent 权限。

`browser_requests` 返回的字符串 `id` 可以传给 `browser_request_detail` 的 `id` 查询响应。加载 debugger 后，把同一个值传给 `get_request_initiator` 的 `requestId` 查询浏览器记录的发起调用栈。记录保留期间，切换标签页或重新导航后仍可用原 ID 查询。每段重定向都有独立的 ID。

桌面宿主通过同一条 stdio 连接读取 `capture-list` 和 `capture-detail`。列表给出连接标识与最近 100 条记录，详情按该标识和请求 ID 一次返回响应预览与已捕获的发起栈。

浏览器工具默认可用，调试工具按需加载。复杂 JSVM / WASM 的完整语义还原不是现成保证；采样、追踪限额和证据验证需要按目标单独设计。本轮重点是把已有能力独立运行与维护。

### 工具面设计准则

这些约束来自真实误用案例，不是风格偏好。**调用方用错工具，视为工具设计失败**，不能归因于"没读文档"。

1. **不静默忽略参数。** 未知参数必须报错，不能因为 zod 默认 strip 就当成没传。否则调用方传了 `url`（正确的是 `urlFilter`），会拿到一份"没有任何过滤"的正常结果，并得出"这个工具不支持过滤"的错误结论——比报错更糟。实现见 `strictToolSchema` / `describeUnknownKeys`（`src/vendor/core-build/src/tools/ToolDefinition.js`）。
2. **报错要给下一步。** 参数名错了就说"你是不是想用 X"，并列出全部合法参数名。只说"不认识这个键"会让调用方再猜一次。
3. **超限返回必须结构化。** 内联结果被截断时，除文字提示外还要给 `truncated: true` 和 `nextAction: { tool, arguments, reason }`，并把内容明确标成 PREVIEW。只在散文里写"请改用某工具"，会被略过。
4. **稳定选择器放前面。** 列表结果优先给 reload/导航后仍然有效的定位方式（如脚本 URL），易失效的（scriptId）放后面并标注 `expires on reload`。

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

维护者可在 `npm run build` 后运行 `node scripts/package-component.mjs`，生成以平台命名的 ZIP 和 SHA-256。Desktop 插件目录只识别 `wdh-<版本>-<平台>-<架构>.zip`，不会把旧桌面安装包当作 WDH 插件。

## 桌面 Agent 的命令行兼容

`wdh status --json --browser system` 只探测本机内核文件，并返回版本化的 `connections` / `targets` 状态格式；它不会打开浏览器，也不会把“安装了内核”报告为“浏览器在线”。`browser.state: not-observed` 明确表示没有观测别的进程中的页面。`wdh tools --json` 离线返回默认工具及参数 schema，加上 `--group debugger` 会一并列出调试器工具及参数 schema。这两条查询都无需安装或打开浏览器。实际导航、抓包和调试继续使用每个 Agent 独立的持久 stdio MCP 连接，避免一次性命令丢失浏览器上下文。
