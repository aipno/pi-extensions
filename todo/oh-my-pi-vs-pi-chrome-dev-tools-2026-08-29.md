# oh-my-pi 学习记录 — 对 pi-chrome-dev-tools 的借鉴（2026-08-29）

> 对照：`packages/pi-chrome-dev-tools`（原生 CDP 直连 Chrome，WebSocket + Domain 消息)
> vs oh-my-pi 的 browser 工具：`packages/coding-agent/src/tools/browser/`（~6.4k 行，
> Puppeteer + worker 进程隔离 + ARIA 快照 + Chrome extension relay）。
> 两者架构差异大（我们走裸 CDP、omp 走 Puppeteer worker），不换架构，摘可移植的机制。

---

## 1. ARIA 快照作为"可寻址页面视图"（高价值，解决 DOM dump 上下文爆炸）
omp 的页面观察不走"innerHTML dump"，而是 **Playwright 格式 ARIA 快照**：
- `aria/aria-snapshot.ts`：把 Playwright 的 ARIA-snapshot 注入源（固定 pin 版本 +
  生成脚本再生成，`scripts/generate-aria-snapshot.ts`）打进 `Runtime.evaluate`，
  每个节点带 `[ref=eN]` 短 id，输出是紧凑的可访问性树。
- 后续操作以 `aria-ref=e12` 这样的短选择器定位（`ARIA_REF_PREFIXES`，:70），
  `resolveAriaRefHandle()` 把 ref 解析回 ElementHandle——**模型每次回传 10 字节
  而不是整个 CSS 选择器**，且 id 失效时报错引导重新 observe。
- `Observation` 结构化返回（tab-protocol.ts:15）：url/title/viewport/scroll 状态 +
  元素数组（id/role/name/value/states），与截图互为补充。

对比我们的 `chrome_devtools_evaluate` 返回整页 JS 结果/HTML：ARIA 快照对模型是
更省 token、更抗噪音的中间表示。即使不引入完整 Playwright bundle，"observe → ref eN →
短选择器操作"的交互链路也值得完整移植。

## 2. 超时分层 + 永无未封顶等待（高价值，健壮性）
- `resolveOpTimeouts(cellTimeoutMs)`（tab-worker.ts:184）：把工具 cell 总预算切成
  `quickOpMs / actionOpMs / budgetBound` 三档；**任何显式 timeout 都会被 clamp 进预算**
  （`resolveWaitTimeout` :216）——`explicit === 0 || Infinity` 视为禁用哨兵但仍给 budgetBound
  上限，负数/NaN 垃圾输入回退默认值。注释原话："the harness never permits an unbounded wait"。
- 每个 ElementHandle 的交互方法都过 `withGuard()`（:370-402）：操作超时 → 标记
  `state.invalidatedBy` → 立即 dispose + invalidate 掉旧 handle → 抛出**点名错误**
  （"handle.click() timed out after …ms"），而不是拖到整个 cell 超时；注释里明确
  "catching it cannot dispatch a duplicate retry through the stale handle"。handle 失效后
  再调用会得到"run tab.observe() to resolve a fresh handle"的修复指引。

我们的页面操作用固定超时；这套"预算封顶 + 垃圾输入归一 + 失效句柄 fail-fast +
错误里带修复路径"的做法整体可移植。

## 3. 卡住诊断：describeInflight
超时错误不只说"超时了"：`describeInflight(inflight)`（tab-worker.ts:949）把仍在跑的
辅助操作**按最老优先**列出来，"cell timeout names what stalled"。低成本高体验，
可以加到我们的长操作错误信息里。

## 4. 浏览器接力（browser-relay）：驱动用户真实 Chrome（思路储备）
Chrome 136+ 默认 profile 禁止 `--remote-debugging-port`；omp 的方案（relay/）：
- 一个 MV3 Chrome 扩展 + 本地 relay 守护进程：扩展内 `chrome.debugger` 每标签页
 只能一个附件，bridge 就垄断这个附件，再**冒充 CDP discovery 端点**
 （合成 `/json/version`、`Target.*` 层级），把多个下游 Puppeteer 连接多路复用上去
 （bridge.ts 文件头，会话 id 三层命名空间 :19-23）。
- 守护进程由"broker 租约"管理：第一个用时懒启动，最后一个消费者退出才停（daemon.ts）；
  端口已被占用就"adopt, never fight over"。
- 驱动中的 tab 自动收进青色 "omp" 分组标签，松手即还；不偷焦点。

我们的 pi-chrome-dev-tools 只支持自带调试端口的 Chrome。这个"MV3 扩展 + CDP façade
伪装"模式成本高但解决的是独一档的问题（用户已登录态）；README 明说 Chrome 136 的
限制，值得作为远期方向记录。

## 5. 其他可摘的点
- **截图前置检查** `preparePageForScreenshot()`（tab-worker.ts:931）：attached 模式下
  页面不可见（`document.visibilityState`）直接报"switch to it before taking a screenshot"，
  而不是截出一张空白图让模型困惑。
- **Puppeteer-only 选择器友好报错**（`normalizeSelector` :277）：模型写 Playwright 选择器
  （`text=…` 等）时直接拦截并给出支持的四种写法示例。
- worker 进程隔离：浏览器跑在独立 worker（`tab-worker-entry.ts` 走 CLI 隐藏 argv 复用入口），
  崩溃不伤主进程；我们若做长生命周期浏览器会话可参考。

---

## 落地建议（pi-chrome-dev-tools）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | observe 工具：ARIA/结构化快照 + `[ref=eN]` 短选择器闭环 | 中-高 | ○ 核心价值 |
| 2 | 超时预算三档化 + 显式 timeout clamp + 垃圾输入归一 | 低 | ○ 立即 |
| 3 | 长操作错误附 describeInflight 风格的"谁在卡"清单 | 低 | ○ 顺手 |
| 4 | 截图前 visibility 检查 | 极低 | ○ 顺手 |
| 5 | browser-relay（MV3 扩展 + CDP façade） | 高 | △ 远期方向，先记录 |