# oh-my-pi（omp）UI/UX 实现调研 — 可借鉴清单

> 调研对象：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（commit `33cc6b9a`，2026-08-28），
> badlogic/pi-mono 的深度定制 fork（"A coding agent with the IDE wired in"）。
> 与我们相关的是两块：`packages/tui`（~30k 行终端 UI 基础库）和
> `packages/coding-agent/src/modes/`（交互层组件/控制器，~100 个聊天 UI 组件 + 控制器）。
> 本清单只收「能落到 pi 扩展生态）的借鉴点，按借鉴价值排序。
> 全部结论均来自实际读码，标注了 `文件:行号`（相对 /tmp/oh-my-pi）。

---

## 一、直接可借鉴（高价值，与我们现有功能同域）

### 1. 流式平滑渲染：StreamingRevealController ★最值得抄的工程
**是什么**：助手消息流式输出时按 30fps 逐 grapheme 渐进显示（打字机效果），且思考块可单独配置显示策略。

**实现要点**（`packages/coding-agent/src/modes/controllers/streaming-reveal.ts`）：
- 30fps 定时 tick（`STREAMING_REVEAL_FRAME_MS = 1000/30`），每 tick 前进 `max(3, ceil(backlog/8))` 个 grapheme——backlog 大时加速追赶、小时匀速，永不变卡顿（`nextStep()`，:201）。
- **增量 grapheme 计数缓存**（`BlockUnitCounter`，:88）：流式块只追加，缓存 `{text, count, tailStart}`，下次只需从上一末尾 cluster 起重算，避免每帧全文重分词。
- **组件级渲染请求**：tick 只对变化的 message 组件调 `requestComponentRender(component)`，不整树重绘。注释里给了实测数据：全树 30fps 重绘 alone 吃 5% CPU（issue #4377）。
- provider delta 快于 tick 时把多次 delta 合并进下一帧（coalesce），绝不丢字。

**我们的差距/机会**：我们的 footer 有 750ms 心跳，但助手消息/工具结果是"有更新就整屏重绘"。可把「帧率节流 + 组件域渲染 + 追赶步长」这套思想用于工具卡片流式更新（尤其 spinner 与 partial diff）。

### 2. 共享 spinner ticker（N 个并行工具卡共用 1 个 80ms 定时器）★
**是什么**：所有进行中的工具块 spinner 相位全局锁定、同步前进。

**实现要点**（`packages/coding-agent/src/modes/components/tool-execution.ts:270-310`）：
- `sharedSpinnerFrame(frameCount, now)` 纯函数：`floor(now/80) % frameCount`，所有块同相位。
- 全局 `Set` 注册活动块，**单个** 80ms interval 驱动全部块的 `tickSpinner(frame)`；最后一个块注销时才清定时器。
- 注释带 issue 考据：旧实现每块各一个 30fps 定时器，N 块并行（如 parallel subagents）就 N 倍无效唤醒；渲染帧率对齐 glyph 步进率后 paints 减半、视觉无差（issue #4353/#8731）。

**我们的机会**：pi-tui 的工具卡 spinner/图标动画若各自起 timer，并行工具时会放大唤醒开销。这个「一个 ticker + Set 注册 + 空表自动停」的模式代码只有 ~40 行，收益立竿见影；我们的 footer 心跳也可以并入这类注册表。

### 3. 状态行 segment 架构（presets + 左右分组 + 分隔符主题化）★
**是什么**：状态栏拆成带 id 的 segment（model/mode/path/git/pr/context_pct/cost/token_rate/cache_hit/session_name/collab/subagents…），由 preset 组合左/右分组。

**实现要点**（`packages/coding-agent/src/modes/components/status-line/`）：
- 每段独立 `{id, render(ctx) → {content, visible}}`（`segments.ts`，820 行，一段一函数），不可见就整段消失（我们 footer 已有此习惯，但他们是**配置化拼装**）。
- 7 个内置 preset：default/minimal/compact/full/**nerd**/**ascii**（无 Nerd Font 降级）/custom（`presets.ts`）。
- 分隔符可换肤：powerline/powerline-thin/slash/pipe/block/ascii/none，两端 cap 用 `useBgAsFg` 翻转（`separators.ts`）。
- 每段有细粒度 options：`git.showStaged/showUnstaged/showUntracked`、`path.abbreviate/maxLength` 等。
- 实用细节：cache_hit 分母含未缓存 input 保持口径诚实，注明 DeepSeek 把 miss 记为 input 的兼容（`segments.ts:660`）；context 段配色按用量分级 `getContextUsageLevel()`。

**我们的机会**：我们的 footer 是写死的两行 `| ` 分段。迁移到「segment 注册表 + preset + 分隔符主题」后，用户可用 `/tui-style` 直接组合左右分段，且天然消化掉 TPS/CH/MCP 这些已散落的段。

### 4. 逐字 diff + 缩进可视化（intra-line diff）
**实现要点**（`packages/coding-agent/src/modes/components/diff.ts`）：
- 行内 word-level diff（`diffWords` 来自 Rust natives），改动片段用 **inverse 视频反显** 而非红绿底。
- `visualizeIndent()`：行首空白用暗色 `·`（空间）和 ` → `（tab）可视化，仅首段缩进，不影响其余内容（:18-39）。
- **流式 diff 抖动抑制** `stripTrailingUnbalancedRemoval()`（tool-execution.ts:46-73）：流式半截 diff 里"先出来一批 `-old`、`+new` 还没到"时，把尾部未配对的 `-`/`@@` 行暂时剪掉，等下个 tick 配齐再放出来——消除"删除先到、新增追上来"的视觉抖动。**这条我们的 write/edit diff 流式渲染同样会遇到，实现只要 20 行。**

### 5. 终端能力探测与优雅降级
**实现要点**（`packages/tui/src/terminal-capabilities.ts`，1370 行）：
- `detectTerminalId()` 识别 kitty/ghostty/wezterm/iterm2/vscode/alacritty/warp 等并据此开关能力。
- 图片协议枚举 `ImageProtocol { Kitty, Iterm2, Sixel }` + `imageFallback`——不支持时文本降级。
- 通知协议分级：BEL / OSC9 / OSC99，且逐终端有例外表（Ptyxis 的 BEL 会闪屏所以禁用，见 `desktop-notify.ts:7` 注释）；cmux 环境（`CMUX_SURFACE_ID`）走 `cmux notify` 路由。
- tmux passthrough 包装（`tmux.ts`）、异步 SGR 矩形探测 `detectRectangularSgrSupport()`。

**我们的机会**：我们把鼠标 SGR 当唯一增强；至少可补「真彩降级 256 色」与「能力探测失败时关动画/关图标」两层。ascii preset 思路对无 Nerd Font 环境也值得抄。

### 6. Composer 形态注册表（8 种输入框样式 + 扩展注册）
**实现要点**（`packages/tui/src/components/composer/`）：
- `ComposerStyle` 契约：`{id, sideBorders, verticalChrome, renderTop/renderRow/renderBottom, statusAttachment, bottomBar, defaultPromptGutter…}`，box/band/**claude**/pi/borderless/rule/field/rail 八种内置。
- 关键设计：**编辑器、/settings 预览、setup-wizard 预览同一套 style 对象渲染**，三个表面永不漂移（types.ts 顶部注释明说这是设计目标）。
- `registerComposerStyle()` 允许扩展进程内注册新形态（registry.ts:33），冲突/覆盖内建 id 直接抛错。
- `claude` 形态：上下横线 + 无边框 `❯ ` 提示符，右侧状态 chip 骑在顶线上（`────── hi ─`），与我们已有的 footer 风格同源。

**我们的机会**：我们的 `/tui-style` 面板若要加"输入框样式"项，可直接移植这套 registry（~50 行核心）；样式契约束缚住"设置预览"与实际渲染，避免调了参数看不到真实效果。

---

## 二、值得评估后引入（中价值）

### 7. 魔法关键词渐变高亮（ultrathink / orchestrate / workflowz）
- 编辑器里输入 standalone 关键词 → 逐字符 HSL 渐变（红→紫 14 档）；提交后给模型注入一条隐藏 system notice 引导深度推理（`modes/ultrathink.ts` + `gradient-highlight.ts`）。
- `phase ∈ [0,1)` 参数化使编辑器可传 `Date.now()` 做 shimmer 动画、已发送气泡用静态渐变（gradient-highlight.ts:44 注释）。
- 工程细节值得学：**probe 正则短路**（无关键词路径只有 3 次 `indexOf`）→ `maskNonProse` 把代码 span/围栏/XML 掩掉后再 paint，关键词永不误染代码；每次注入零宽 SGR、可见宽度不变，多关键词链式高亮互不干扰（magic-keywords.ts:10 注释）。
- 对我们：门槛在「隐藏 notice 注入」需要宿主事件配合；纯编辑器配色部分可只读仿制。

### 8. 队列速记：`->` 前缀与枚举列表即队列
- 以 `->` 或 `=>` 开头的消息进入"生成完自动发送"队列（`modes/queue-input.ts:12`）。
- 更妙的是直接写编号列表 `1. …  2. …`（十进制/罗马/字母均可，`QUEUE_LIST_MARKER_RE`）会被解析成**多条排队消息**逐条投递（`splitQueuedMessages()`，:118）——用户在 agent 干活时把后续指令写成一个清单一次贴入。
- 对我们：纯前端语义，不依赖宿主特殊事件，移植门槛低。

### 9. transcript 视口分配器（append-only 语义行）
- `modes/components/transcript-container.ts`：块生命周期 `active → settled → committed`；提供 `getTranscriptStableRows()` 语义行身份契约，稳定行一旦进入原生终端 scrollback 就**逐字节前缀校验**（`isRowPrefix`/`isStablePrefix`），漂移即冻结该块的后续发布（`stableFrozen`）。
- 视口压力大时按 `renderTranscriptBlockEmergencyRow()` 保关键行。
- 对我们：这是他们最重的基建（配合原生 alternate screen），我们目前走 requestRender 重绘路线，不必整体引入；但「语义行身份 + 前缀不变式」对将来做"长会话不闪烁/不回滚"是正确抽象，先记档。

### 10. 历史/设置列表的通用化交互
- **Ctrl+R 历史搜索**（`components/history-search.ts`）：分词高亮（token 与存储侧同一套分词器保证对齐 :17）、相对时间列（`now/5m/2h/3d/2w/6mo/1y` :54）、PageUp/PageDown 翻 10 行。
- **SettingsList type-to-filter**（`packages/tui/src/components/settings-list.ts`）：fuzzyFilter 用「词局部匹配」打分——`image provider` 不会因 i-m-a-g-e 散落在长描述里而误中（fuzzy.ts:1 注释）；`heading` 项跳过导航与搜索（settings-list.ts:33）。
- 我们的 `/tui-style`/`/context` 面板项目正变多，type-to-filter + 词级 fuzzy 可直接复用。

### 11. 键位提示一致性系统
- `keybinding-hints.ts` 全部 56 行：`keyHint(action, description)` 统一输出 dim(按键) + muted(说明)，全部提示从 keybindings manager 取（改键后 UI 自动跟随）。所有组件共用，杜绝硬编码。
- 我们的面板/footer 提示文案分散，抄这个模块成本低。

### 12. 精细的动画工程细节（可局部借鉴）
- **shimmer 速度按 cell/s 常速**而非固定时长：字符串再长，30fps 下每帧位移 ≤1 格，永不跳帧（`modes/theme/shimmer.ts:10-14` 注释）。
- welcome 面板固定行数插槽（会话 4 行 / LSP 4 行，溢出切片）保证盒子高度稳定（`welcome.ts:25-40`）。
- tips 单独 `tips.txt` 构建期内嵌，`[NEW]` 标记加权 4 倍抽样（`pickWeightedTip`）；渲染为渐变 NEW! 徽标。
- CountdownTimer 以 deadline 计算而非累计 tick（`countdown-timer.ts:26`），休眠后不漂移。
- 我们 startup-header 的动画 logo 正好缺「速度常量化」；`/tui-style` 面板可加 tips。

---

## 三、理念层面（低依赖、高杠杆）

### 13. 渲染性能是一等公民
omp 把perf 当 UI 特性做：组件域渲染代替全树重绘（#4377）、spinner 帧率=渲染帧率（#4353）、N 动画块共享一个 timer（#8731）、markdown fast-tail splice（对 inert 追加增量只重排最后一行，一整套"危险接缝"正则判定何时必须放弃优化回退全量渲染，`packages/tui/src/components/markdown.ts:960-1050`，还导出 `fastTailSplices` 计数器专防优化路径静默失效）。
**可借鉴的不仅是代码，而是习惯**：每处动画/重绘都标注 issue 号、帧成本实测和"何时自动降级"。

### 14. 注释写"为什么"而不是"是什么"
几乎每个文件头部用 5-15 行讲清：设计目标、失败模式、实测数据、相关 issue。例：pause-screen 免中断 gate 的语义（"nothing is aborted"）、cache_hit 分母口径、DeepSeek 兼容、kill-ring 累积策略。这套注释风格本身值得作为我们包内规范。

### 15. 交互功能自带发现机制
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

> 2026-08-29 第一批已落地（pi-tui 236 tests 全绿）：#1/#2/#3/#8/#9 + footer segment 重构（#3）
> + 终端能力降级（新勘入项）+ 面板 type-to-filter（#6，条件已触发）。TPS 口径决议：
> `message.duration` 优先 → 同消息起止 → 相邻间隔（三档互补，已实现在 footer-segments.ts）。

| # | 事项 | 预估成本 | 优先级 |
|---|---|---|---|
| 1 | ✅ 流式 diff 抖动抑制 + partial 渐进预览（diff-stream-guard.ts / diff-partial.ts，已接入 default-mode） | 极低 | ○ 已完成 |
| 2 | ✅ 共享 spinner ticker（shared-ticker.ts；grouping + footer 心跳已并入） | 低 | ○ 已完成 |
| 3 | ✅ footer 重构为 segment 注册表 + preset(minimal) + 可换分隔符 + TPS/心跳收编（footer-segments.ts） | 中 | ○ 已完成 |
| 4 | 流式 reveal（30fps 渐进 + 组件域渲染）评估 | 中高，需宿主事件配合 | △ 观望（宿主 API 探测未做） |
| 5 | composer 形态注册表 → /tui-style 增加输入框样式项 | 中 | △ 看需求（宿主无 composer 渲染入口） |
| 6 | ✅ 面板 type-to-filter + 词级 fuzzy（宿主 SettingsList fuzzyFilter 启用，>5 项页签） | 低-中 | ○ 已完成 |
| 7 | `->` 队列速记 | 低 | △ 看需求 |
| 8 | ✅ keyHint 统一提示样式（utils/key-hint.ts；面板 footer/数字子面板已接入） | 低 | ○ 已完成 |
| 9 | ✅ startup-header 动画 deadline 化 + 井入共享 ticker | 极低 | ○ 已完成 |
| — | ✅ 终端能力降级（terminal-capabilities.ts：truecolor→256/16 量化、NO_COLOR/dumb/CI 关动画；diff-palette/工具 spinner 已接入） | 中 | ○ 已补入（原表勘漏） |

---

## 六、与其他计划的冲突/重复核对（2026-08-29 补）

与 `issues-2026-08-26.md`、`pi-tui-gaps…`、`pi-btw-gaps…` 及各 per-package oh-my-pi 记录交叉核对后的发现：

**语义冲突（2 处，需定夺）：**
1. **TPS 口径打架**：pi-stamp 记录 #5 称现口径（message.timestamp→entry 落盘差值）"正确"，
   pi-usage 记录 #5 建议"message.duration 优先于 entry 差值"。同一份 pi-tui footer 代码
   两个相反结论。**建议合并为一个决策**：provider 报了可信 `message.duration` 则优先，
   否则保留现有 entry 差值回退——两者实为互补而非二选一（omp token-rate.ts 即此优先级）。
2. **pi-btw 落地表 #5 作废**："提升为主线（steering 降级版）"与 pi-btw 已实现的
   bring-to-main（最新/从某问/整条线程）重复。omp `branch to chat` 的真实差异只剩
   宿主级会话树分支，扩展侧无等价物，维持 △ 记录即可，不再作为独立事项。

**重复/应合并（4 处）：**
2. **footer 演进分散三份文档**：本文 #2（心跳并入共享 ticker）/ #3（segment 重构）、
   pi-stamp #5、pi-usage #5 都要动 pi-tui footer。应合并为一次 "footer 演进" 专项：
   segment 注册表重构时同步收编 TPS 段与 750ms 心跳，避免三次触碰同一文件。
3. **pi-todo**：本清单第 4 条（selectWithinCap）正是 issues T3（溢出摘要误报 "N pending"）
   的修法，应合并处理；第 7 条（显示层 sanitize）pi-todo 已有 sanitize.ts，
   实际事项是补全 issues T6 指出的 7-bit DCS/PM/APC 剥离缺口，而非新做。
4. **pi-mcp-adapter**：本表第 1 条（工具目录持久化缓存）与 issues B8/B9（metadata-cache
   校验过浅/并发丢条目）同域，重写缓存时应一并修复。
5. **pi-ask-user-question**：本表第 4 条（保留标签防注入）同时解决 issues Q8
  （大小写绕过）；第 1 条（preview 渲染）落地时应顺带解决 issues Q2（preview 截断 vs
   全文回传不一致）。

**附带更正**：issues-2026-08-26 P1（pi-mcp-adapter 未入库）已过时——该包现已提交且持续维护。
pi-tui-gaps 文档的"startup-header 维持动画版"决策与本清单 #12（shimmer 速度常量化）不冲突：
优化动画节奏 ≠ 更换设计，维持决策不变。