# oh-my-pi 学习记录 — 对 pi-mcp-adapter 的借鉴（2026-08-29）

> 对照：`packages/pi-mcp-adapter`（MCP 代理工具：单 proxy + 按需 search/call，控制上下文开销）
> vs oh-my-pi 的 MCP 栈：`packages/coding-agent/src/mcp/`（~7.7k 行：manager/loader/client/
> tool-bridge/tool-cache/oauth*/smithery*/timeout）+ extension-dashboard 的 MCP 管理 UI。
> omp 也吃过"工具定义烧上下文"的痛，解法是**定义缓存 + 延迟连接 + 稳定排序 + 仪表盘**，
> 与我们的 proxy 模型正交，多条直接可用。

---

## 1. 工具定义缓存（SQLite 存储 + TTL + 配置哈希）（高价值）
`mcp/tool-cache.ts`（99 行）：
- 以 `MCPToolCache` 把每个 server 的 `tools/list` 结果存进 agent.db（key
  `mcp_tools:<server>`），payload 含 `version + configHash + tools`。
- configHash = `SHA-256(stableStringifyJson(config))`（:33）——**服务器配置一变即失效**，
  配置没变则 30 天 TTL 内直接复用。
- 作用在启动路径上：连接超时/慢的 server，若有缓存定义则立即暴露为**延迟工具**
  （DeferredMCPTool），首次实际调用时才等连接（见下条）。

我们的 search/call 已经省掉了"定义进上下文"，但每次会话仍要等 server 连接完才能
search。此缓存直接消灭冷启动等待，代码量小。

## 2. DeferredMCPTool：连接与工具暴露解耦（高价值）
`mcp/tool-bridge.ts:602`：每个 MCP 工具包成 CustomTool，持有
`getConnection: () => Promise<MCPServerConnection>` 闭包——**工具注册不依赖连接**，
`execute` 时才 `await getConnection()`，失败自动重连（`callToolWithAuthRetry`），
"always worth a reconnect attempt for deferred tools"（:726）。

启动编排（manager.ts:670-728）更是教科书级：
1. 所有连接任务与 `STARTUP_TIMEOUT_MS` `Promise.race`；
2. 超时未达的 server → 查工具缓存 → 有则注册为 DeferredMCPTool 顶上；
3. **绝不同步等待最慢的 server**（issue #2100：单个无响应 server 曾把启动卡满 30s），
留在后台 `toolsPromise.then(...)` 里连接完成后 `#onToolsChanged` 热注册。

对 pi-mcp-adapter 的启示：search 应立刻可用（用缓存/持久化的工具目录），
server 连接放后台，慢 server 只影响它自己的首次 call。

## 3. prompt 缓存友好的工具稳定排序（低成本，收益直接）
`manager.ts:130-142`："Anthropic prompt caching keys on byte-identical tool definitions:
any reorder invalidates the tools cache breakpoint."——MCP server 连接/重连时机天然
非确定，工具数组按**名字稳定排序**，保证任意时刻字节数组一致，避免每次重连都打碎
prompt cache。我们的 proxy 虽然只暴露少量工具，但任何"工具列表/描述"字节的非确定性
（服务发现顺序、哈希序）都应显式排序消除。

## 4. 重连风暴熔断器（健壮性，直接可抄）
`manager.ts:87-101`：stdio server 在 initialize+tools/list 握手后干净退出，会触发
`transport.onClose → reconnectServer` 无限 fork 循环（issue #1592：php shebang
fork-bombing macOS）。解法：
- 30s 滑动窗口内每个 server 最多 5 次重连（`RECONNECT_BURST_WINDOW_MS=30s × BURST_LIMIT=5`，
  总进程数 ≤25），旧崩溃滑出窗口，瞬时故障零成本；
- 手动 `/mcp reconnect` 重置窗口供用户修复后恢复。

我们按需拉起 server 时同样面临反复崩溃的服务；窗口熔断 + 手动重置是标准答案。

## 5. 超时中止的竞态正确性（细节但致命）
`mcp/timeout.ts:33-70` `createMCPTimeout()`：用 `timerFired + callerAborted` 两个标志
区分"谁的 signal 先 abort"。注释点出真实事故：定时器在 `response.json()` 期间触发 +
caller 先 abort → 双方都 aborted，旧的 `!signal?.aborted` 判断为假 → **超时被误报成
`SyntaxError: Unexpected end of JSON input`**。我们 adapter 的 call 超时处理值得对照
补这类归因标志。

## 6. MCP 运行时仪表盘（UI/UX，可与我们的 /usage 面板共用模式）
`modes/components/extensions/extension-dashboard.ts`（653 行）+ `mcp-runtime.ts`：
- 全屏 TabBar 仪表盘：provider 分 tab、左列表右 inspector、**双栏都是鼠标感知的**
 （wheel/hover/click 走单个 SGR handler，`routeSgrMouseInput` + `routeSelectListMouse`）。
- **MCP 连接健康在渲染时 join**（:541 "Live MCP health is joined at render time"）：
 连接状态事件频道推送 → 只标脏不重建；空间键启停 server 直接写回 mcp.json
（`setMcpServerEnabled`）+ 运行时热切换（`applyMcpToggleRuntime`）。
- inspector 面板是"一套语法看所有类型"：identity → runtime/enablement → description →
 origin → contents → config（inspector-panel.ts 顶部注释），MCP/工具/skill/hook 全走同一骨架。

我们的 mcpScript/工具发现若要做状态视图，这个「列表+inspector 双栏 + 渲染时 join 健康
状态 + 空格启停写回配置」是完整模板。

## 7. 其他可摘的点
- **通知有界缓冲**（manager.ts:108-117）：listener 未挂上时到达的 server 通知进
  drop-oldest 100 条 buffer，首个订阅者一次灌入——避免启动竞态丢通知。
- **Smithery registry 集成**（smithery-registry.ts）：`@smithery/cli run` 约定 +
  注册表搜索（10s 超时、`withTimeoutSignal`），可作为我们文档里"快速找 server"的补充说明。
- **per-server OAuth**（oauth-flow.ts）：credential id 按 `mcp_oauth:profile:<profile>:<serverUrl>`
  命名，URL 原样保留（含 query string 的租户选择器）——多 profile 不互踩，注释详尽。

---

## 落地建议（pi-mcp-adapter）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | 工具目录持久化缓存（配置哈希 + TTL），search 先于连接可用 | 中 | ○ 核心价值 |
  > 注（2026-08-29）：落地即重写 metadata-cache 层，应顺带修复 issues B8（顶层校验过浅）与 B9（读-改-写并发丢条目），缓存版本号一并升级 |
| 2 | server 连接后台化：search 永不被最慢 server 阻塞 | 中 | ○ 高 |
| 3 | 工具列表/描述字节稳定排序（prompt cache 友好） | 极低 | ○ 立即 |
| 4 | 重连滑动窗口熔断（30s×5 + 手动重置） | 低 | ○ 立即 |
| 5 | 超时归因标志（timerFired/callerAborted） | 低 | ○ 顺手 |
| 6 | MCP 状态仪表盘（列表+inspector，渲染时 join 健康度） | 中-高 | △ 有 UI 需求时 |