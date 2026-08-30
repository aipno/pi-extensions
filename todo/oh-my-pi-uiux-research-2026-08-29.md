# oh-my-pi（omp）UI/UX 实现调研 — 可借鉴清单

> 调研对象：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（commit `33cc6b9a`，2026-08-28），
> badlogic/pi-mono 的深度定制 fork（"A coding agent with the IDE wired in"）。
> 与我们相关的是两块：`packages/tui`（~30k 行终端 UI 基础库）和
> `packages/coding-agent/src/modes/`（交互层组件/控制器，~100 个聊天 UI 组件 + 控制器）。
> 本清单只收「能落到 pi 扩展生态）的借鉴点，按借鉴价值排序。
> 全部结论均来自实际读码，标注了 `文件:行号`（相对 /tmp/oh-my-pi）。

---

## 一、直接可借鉴（高价值，与我们现有功能同域）

> 本节 1-3 条已抽为独立落地计划：[pi-tui-omp-landing-plan-2026-08-30.md](pi-tui-omp-landing-plan-2026-08-30.md)。概要：
> 1. **流式平滑渲染**（StreamingRevealController）— ⏸ 阻塞：宿主缺 `requestComponentRender` 与 per-delta 事件（2026-08-30 核实）；
> 2. **intra-line diff 反显 + 缩进可视化** — 待实现（`diff-inline.ts` 已有 token 级切分，抖抑制已落地；缺 inverse 与缩进可视化）；
> 3. **Composer 形态注册表** — ⏸ 阻塞/看需求：宿主无扩展可用的 composer 渲染入口。
> 以下小节编号沿用调研原文，4-9 为未抽出的其余条目。

---

## 二、值得评估后引入（中价值）

### 4. 魔法关键词渐变高亮（ultrathink / orchestrate / workflowz）
- 编辑器里输入 standalone 关键词 → 逐字符 HSL 渐变（红→紫 14 档）；提交后给模型注入一条隐藏 system notice 引导深度推理（`modes/ultrathink.ts` + `gradient-highlight.ts`）。
- `phase ∈ [0,1)` 参数化使编辑器可传 `Date.now()` 做 shimmer 动画、已发送气泡用静态渐变（gradient-highlight.ts:44 注释）。
- 工程细节值得学：**probe 正则短路**（无关键词路径只有 3 次 `indexOf`）→ `maskNonProse` 把代码 span/围栏/XML 掩掉后再 paint，关键词永不误染代码；每次注入零宽 SGR、可见宽度不变，多关键词链式高亮互不干扰（magic-keywords.ts:10 注释）。
- 对我们：门槛在「隐藏 notice 注入」需要宿主事件配合；纯编辑器配色部分可只读仿制。

### 5. 队列速记：`->` 前缀与枚举列表即队列
- 以 `->` 或 `=>` 开头的消息进入"生成完自动发送"队列（`modes/queue-input.ts:12`）。
- 更妙的是直接写编号列表 `1. …  2. …`（十进制/罗马/字母均可，`QUEUE_LIST_MARKER_RE`）会被解析成**多条排队消息**逐条投递（`splitQueuedMessages()`，:118）——用户在 agent 干活时把后续指令写成一个清单一次贴入。
- 对我们：纯前端语义，不依赖宿主特殊事件，移植门槛低。

### 6. transcript 视口分配器（append-only 语义行）
- `modes/components/transcript-container.ts`：块生命周期 `active → settled → committed`；提供 `getTranscriptStableRows()` 语义行身份契约，稳定行一旦进入原生终端 scrollback 就**逐字节前缀校验**（`isRowPrefix`/`isStablePrefix`），漂移即冻结该块的后续发布（`stableFrozen`）。
- 视口压力大时按 `renderTranscriptBlockEmergencyRow()` 保关键行。
- 对我们：这是他们最重的基建（配合原生 alternate screen），我们目前走 requestRender 重绘路线，不必整体引入；但「语义行身份 + 前缀不变式」对将来做"长会话不闪烁/不回滚"是正确抽象，先记档。

---

## 三、理念层面（低依赖、高杠杆）

### 7. 渲染性能是一等公民
omp 把perf 当 UI 特性做：组件域渲染代替全树重绘（#4377）、spinner 帧率=渲染帧率（#4353）、N 动画块共享一个 timer（#8731）、markdown fast-tail splice（对 inert 追加增量只重排最后一行，一整套"危险接缝"正则判定何时必须放弃优化回退全量渲染，`packages/tui/src/components/markdown.ts:960-1050`，还导出 `fastTailSplices` 计数器专防优化路径静默失效）。
**可借鉴的不仅是代码，而是习惯**：每处动画/重绘都标注 issue 号、帧成本实测和"何时自动降级"。

### 8. 注释写"为什么"而不是"是什么"
几乎每个文件头部用 5-15 行讲清：设计目标、失败模式、实测数据、相关 issue。例：pause-screen 免中断 gate 的语义（"nothing is aborted"）、cache_hit 分母口径、DeepSeek 兼容、kill-ring 累积策略。这套注释风格本身值得作为我们包内规范。

### 9. 交互功能自带发现机制
tips.txt 轮播 + welcome 常驻 + 「press ← ← 钻入运行中 agent」这类提示文案，把每个深功能都挂了发现入口。我们的 `/context`、自定义 footer、TPS 等功能缺一个统一的 tips 出口（startup-header 已有 tips 栏位，可以复用）。

---

## 四、明确不建议照搬的部分

| 部分 | 理由 |
|---|---|
| transcript 容器整体替换 | 依赖其 Bazel/Bun/原生 scrollback 管线，与我们 requestRender 模型冲突；只借鉴抽象 |
| kitty-graphics / sixel 图片 | 终端覆盖率低，维护重 |
| deccara / tmux passthrough / loop-watchdog | 属宿主级基建，扩展包做不了 |
| collab/stats/mnemopi 等旁支包 | 与 TUI 渲染无关 |

---

## 五、建议落地顺序（对应我们仓库）

> 2026-08-29 第一批已落地（pi-tui 237 tests 全绿），以下条目已从清单移除：
> #1 流式 diff 抖动抑制 + partial 渐进预览（diff-stream-guard.ts / diff-partial.ts，接入 default-mode）；
> #2 共享 ticker（shared-ticker.ts，grouping/footer 心跳/startup-header 并入）；
> #3 footer segment 注册表 + preset + 可换分隔符 + TPS 三档口径（footer-segments.ts：
> message.duration → 同消息起止 → 相邻间隔）；#6 面板 type-to-filter（panel.ts）；
> #8 keyHint（key-hint.ts）；#9 startup-header deadline 化；另补终端能力降级
> （terminal-capabilities.ts，接入 diff-palette/tool-loading-icon）。下表仅剩未落地项。

| # | 事项 | 预估成本 | 优先级 |
|---|---|---|---|
| 1-2 | 流式 reveal 评估 / composer 形态注册表（已抽为独立计划，见一节指引） | – | △ 见计划 |
| 3 | `->` 队列速记 | 低 | △ 看需求 |

---

## 六、与其他计划的冲突/重复核对（2026-08-29 补）

与 `pi-tui-gaps…`、`pi-btw-gaps…` 及各 per-package oh-my-pi 记录交叉核对后的发现：

**重复/应合并（3 处）：**
1. **pi-todo**：本清单第 4 条（selectWithinCap）正是 issues T3（溢出摘要误报 "N pending"）
   的修法，应合并处理；第 7 条（显示层 sanitize）pi-todo 已有 sanitize.ts，
   实际事项是补全 issues T6 指出的 7-bit DCS/PM/APC 剥离缺口，而非新做。
2. **pi-mcp-adapter**：本表第 1 条（工具目录持久化缓存）与 issues B8/B9（metadata-cache
   校验过浅/并发丢条目）同域，重写缓存时应一并修复。
3. **pi-ask-user-question**：本表第 4 条（保留标签防注入）同时解决 issues Q8
  （大小写绕过）；第 1 条（preview 渲染）落地时应顺带解决 issues Q2（preview 截断 vs
   全文回传不一致）。