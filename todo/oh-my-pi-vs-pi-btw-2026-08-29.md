# oh-my-pi 学习记录 — 对 pi-btw 的借鉴（2026-08-29）

> 对照：`packages/pi-btw`（全屏侧线程问答，narumitw 参考版的原创重写，pi 原生 `ui.custom`
> 覆盖层实现）vs oh-my-pi 的 `/btw`：`modes/components/btw-panel.ts`（154 行）
> + `modes/controllers/btw-controller.ts`（246 行）+ `session/agent-session.ts:8722 branchFromBtw`。
> omp 的 btw 是同一个功能的"宿主原生版"——它直接跑在主进程内、用会话树分支实现
> "把侧问提升为正经对话分支"，有些能力依赖宿主内核，但交互模式完全可借鉴。

---

## 1. 状态机驱动的面板 footer（高价值，直接可抄）
omp 的 btw 面板是一个显式五态状态机（`btw-panel.ts:15`）：
`running → complete → (branching) → dismissed`，外加 `aborted` / `error`。
**footer 随状态变化**，一行提示讲清当下可做什么（`#footerLine()`，:119-140）：

```
running:   Esc cancel /btw
complete:  c copy · b branch to chat · Esc dismiss
branching: ⏳ Branching to chat…
aborted:   ⚠ Cancelled · Esc dismiss
error:     ✗ Error · Esc dismiss
```

- 状态迁移由 `markComplete()/markBranching()/markAborted()/markError()` 收口，footer 只是状态的函数渲染（纯派生，无双源）。
- 动作可用性也状态机化：`isCopyable()` 仅 `complete` 且有答案时为真；copy/branch 处理函数先查 `canBranch()/canCopy()`（controller:44-77），避免"边分支边复制"的竞态（用 `#branchInFlight` 锁 + finally 解锁）。

我们的侧线程面板同样有 running/done/error 态，但提示是静态字串。改成「状态 → footer 文案 + 动作门」的纯函数派生后，新增状态（如"带到主对话中…"）零成本。

## 2. "branch to chat"：把侧问提升为主对话（高价值，需评估宿主能力）
- 回答完成后按 `b`，把「问题 + 助手回答」整体搬进主会话树：`session.branchFromBtw(question, assistantMessage, leafId, sessionId)`（`agent-session.ts:8722`），本质是**在 btw 的会话叶子处开分支**，用户后续可在主线继续深聊这个侧问题。
- `#branchUnavailableReason()`（controller:71-86）是完整的前置校验清单：分支进行中 / 答案没就绪 / 会话已切换 / `isStreaming`——每条都给出人话理由并 `showStatus(dim)` 提示，而不是静默失败。
- assistantMessage 会先经 `assistantMessageWithReplyText()` 清洗（只保留 thinking + 最终回复文本，去重 text 块、清 providerPayload，controller:16-34）再入树。

pi 扩展侧没有直接的"会话树插入"API；但我们已有 steering 队列（参考实现带来的行为），
可作为降级实现：把 Q/A 作为一条 steering 消息注入。价值在于「侧问结果可以平滑升级为
主线上下文」这个交互概念本身。

## 3. 组件域重绘（我们主 UI 可以直接学）
`#rebuild()` 只对自身调 `requestComponentRender(this)`（btw-panel.ts:126 注释）：
"streaming deltas arrive per token, and a full compose would re-walk the whole transcript
each time. Before the panel is mounted the TUI cannot resolve it and falls back to a full
compose on its own."——**未挂载时退化为全量重绘**，正确性不依赖调用顺序。

我们的 btw 面板在流式回答时刷新整个覆盖层；pi 的 `ui.custom` 若提供组件级重绘，
按此模式改造可以显著降低每 token 的合成成本。

## 4. 操作反馈的一致性模式（可直接抄为包规范）
- 每个动作成功 → `showStatus("Copied /btw answer to clipboard")`；失败 → `showError(e.message)`；不可用 → `showStatus(reason, {dim})`（controller:84-97, 110-113）。三类反馈三种视觉强度（普通/dim/error），全包统一。
- Esc 分层：branch 进行中 Esc 提示"进行中"并吞掉（:136-138），其余状态才真正关闭——操作原子性由 UI 层保证。

## 5. 附带发现：共享 overlay 边框库（对 pi-btw 的全屏面板直接有用）
`modes/components/overlay-box.ts`（~150 行）提供全屏/内联 overlay 的**统一制图**：
- `fit(text, width)`：ANSI 感知的精确填充/截断（:17-26），两侧竖线内内容永不破宽。
- `topBorder(width, title)` 标题嵌在圆角框线上（``╭─ 标题 ─╮`` 风格）、`divider()` tee 分隔、
  `topBorderSplit()/dividerSplit()` 双栏分割（:75-95）、`row()` 单列内容包裹。
- 文件头声明设计目标："all outlined overlays read identically"——omp 的 /copy、plan-review、
  extension-dashboard 全部共用这套。

我们的 btw/菜单组件各自画线、风格略异；把这 ~6 个纯函数抄过来做共享 `overlay-chrome.ts`，
能一次性统一所有全屏面板的外观。

---

## 落地建议（pi-btw）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | footer 状态机化（状态 → 文案/动作门的纯派生） | 低 | ○ 立即 |
| 2 | 操作反馈三分级规范（status/dim status/error） | 低 | ○ 立即 |
| 3 | 共享 overlay 边框工具函数（topBorder/divider/row/split） | 低-中 | ○ 高（可与 pi-todo 面板共享） |
  > 注：本包已有自绘菜单/预览，落地时先盘点现有绘制点，避免与新工具并存两套线条风格 |
| 4 | 流式回答组件域重绘 | 低 | ○ 立即 |
| 5 | "提升为主线"交互 | — | ✖ **作废（2026-08-29核对）**：本包已有 bring-to-main（最新/从某问/整条线程，见 pi-btw-gaps 文档），omp `branch to chat` 的差异仅剩宿主级会话树分支，无扩展侧等价物，不立项 |