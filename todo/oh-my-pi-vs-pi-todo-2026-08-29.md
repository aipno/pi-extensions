# oh-my-pi 学习记录 — 对 pi-todo 的借鉴（2026-08-29）

> 对照：`packages/pi-todo`（todo 工具 + /todos 命令 + 编辑器上方实时面板，
> 从会话重建以幸存于 /reload 与压缩）vs oh-my-pi 的 todo 栈：
> `tools/todo.ts`（1273 行）+ `session/todo-tracker.ts`（394 行，完成提醒/中途对账的
> 宿主侧大脑）+ `modes/components/todo-reminder.ts`。
> omp 的 todo 有**阶段（phase）概念**、五种任务状态、完成时的划线动画与
> 「停机时提醒、跑动中悄悄对账」的双通道守护，是最接近我们 pi-todo 的对标物。

---

## 1. 双通道 todo 守护：停机提醒 + 中途对账（高价值，核心借鉴)
`session/todo-tracker.ts` 把"agent 会忘 todo"拆成两个互补机制：

**A. 完成提醒（checkCompletion，:194-287）**——agent 停机时检查：
- 守卫链依次跳过：工具被 user-force 调用 / plan 模式 / **上一次提醒尚未被行动**
 （`#reminderAwaitingProgress`，防 reminder 风暴）/ 设置关闭 / 已达 `todo.remindersMax`
  上限 / 列表为空 / 全部完成（此时清零计数）；
- **两个聪明的静默条件**：assistant 尾问在等用户回答（`isAwaitingUserAnswer`）不提醒；
 有 async job 在飞、loop 即将被唤醒的不提醒（"async jobs in flight will re-wake the loop"）。
- 提醒本体是 `<system-reminder>` developer 消息，列阶段式未完成清单 +
  `(Reminder 2/3)` 计数，append 到对话后 `scheduleAgentContinue` 自动续跑。

**B. 中途对账（takeMidRunNudge，:290-324）**——agent 还在跑时：
- 连续 ≥12 次变更类工具调用（bash/edit/write/ast_edit）未触碰 todo → 注入一条
  **隐藏消息**（`display: false`，UI 不可见），提醒同步状态；每个 cycle 最多 2 次
 （`MID_RUN_NUDGE_MUTATION_THRESHOLD` / `MID_RUN_NUDGE_MAX_PER_CYCLE`）。

我们的 todo 只有"agent 自己维护列表"，没有完成守门与漂移对账。A+B 的守卫条件
（每条都有"为什么静默"的 logger.debug 理由）是一份完整的提醒策略说明书。

## 2. 任务状态五态 + in_progress 唯一不变式（直接可抄）
- `TodoStatus = pending | in_progress | completed | abandoned | blocked`（todo.ts:21），
  **abandoned**（主动放弃）与 **blocked**（附 `blocker` 原因字段）是我们没有的——
  "放弃后不被算作未完成的噪音"（`isTodoSettled`，:239-243）。
- `normalizeInProgressTask()`（:146-159）：任何写操作后强制**至多一个 in_progress**；
  多个则把多余的降回 pending；一个都没有则把第一个 pending 升为 in_progress。
  一个不变式收口所有 op（init/start/done/rm/drop/block/unblock/append/view 九个 op
  共用），面板永远只有一行"正在做"。
- blocked 任务的 `blocker` 备注在 block 时写入、unblock 时清除（:28 类型注释）——
  待办列表因此能表达"为什么停着"，而不只是停着。

## 3. 完成划线动画（轻量、有品）
`tools/todo.ts:985-1007`：
- `strikethroughText` 用 SGR `9m/29m`（不碰前景色）；完成瞬间 `hold 2 帧 → 12 帧内
  逐字符揭开划线`（`partialStrikethrough` 按字符数线性推进）——**划线从左扫到右**，
  比瞬间消失更有"完成感"；帧数常量导出可测。
- 帧驱动复用父渲染循环（`TODO_STRIKE_TOTAL_FRAMES` 传给 spinner frame 通道），
  不自起 timer。

## 4. 折叠窗口选择算法 `selectWithinCap`（面板空间不足时的取舍法则）
`tools/todo.ts:285-320` 的注释即规格，值得逐条抄：
1. **活动任务（in_progress + 被活动子代理匹配的 pending）置顶，永不被窗口裁掉**；
2. 剩余行用"当前活动任务的**后继 pending**"填满（无活动则从头取）——刚被提升的任务
   领跑预览；
3. 活动任务自己超 cap 时只显示前 cap 个、摘要里计数隐藏的**活动** todo，
   "never replacing them with unrelated pending rows"（宁缺毋滥，不拿不相关行凑数）。

我们的顶部面板折叠是简单截断；这套"活动优先、后继填充、隐藏活动计数"直接可移植。

## 5. TodoReminder 组件：锚进转录而非浮在编辑器上（UI 架构决策）
`modes/components/todo-reminder.ts:6-9`："committed into the transcript like a TTSR
notification so it **stays anchored in history rather than floating above the editor**"。
- agent 停机且有未完成 todo 时插一条 **warning 反色 Box**（`theme.inverse(warning)`）：
 `⚠ 2 incomplete todos - reminder 1/3` + 斜体清单；
- 计入工具活动开关（`setToolActivityVisible`，隐藏工具活动时一并隐藏，:28-40）；
- 带 attempt/maxAttempts——提醒是会耗尽的资源，不是无限骚扰。

我们的 todo 面板固定在编辑器上方；「停机提醒锚进转录」能让长会话回看时也看得到
"当时为什么继续跑"，且天然随上下文折叠。可作为面板之外的补充通道。

## 6. 其他可摘的点
- **展示 sanitize 与身份键分离**（:1013-1019 注释）：`content` 原样保存/作为查找
  身份键，仅 `forDisplay()` 时剥 ANSI/C0——"a label holding ANSI would otherwise
  rewrite the terminal every time the list renders or replays"。我们的 todo 也应
  在显示层剥控制符。
- **阶段名罗马数字展示** `formatPhaseDisplayName`（:985）："1. 阶段名"→ `Ⅰ.` 风格。
- **compaction 后的提醒重建**：tracker 提供"compaction 后仅提醒式的 eager prelude"
 （:188 `buildReminderOnlyPreludes`）——压缩之后不重建完整清单注入，只提醒"你有
  未完成 todo"，控制上下文成本。

---

## 落地建议（pi-todo）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | in_progress 唯一不变式（写操作后归一化） | 低 | ○ 立即 |
| 2 | blocked（带原因）/ abandoned 两态 + `isTodoSettled` | 低 | ○ 高 |
| 3 | stopped 提醒：maxAttempts 上限 + 静默守卫（等用户输入/async 在飞不提醒） | 中 | ○ 核心价值 |
| 4 | 中途对账 nudge（12 次变更未同步、隐藏消息、每轮≤2） | 中 | ○ 高 |
  > 注（2026-08-29 核对）：第 5 条（selectWithinCap）正是 issues T3（溢出摘要误报 "N pending"）的修法，应合并处理；第 7 条（sanitize）实际上限是补全 issues T6 指出的 7-bit DCS/PM/APC 剥离缺口，而非从零新做 |
| 5 | 面板折叠换 selectWithinCap 算法 | 低 | ○ 下次动面板 |
| 6 | 完成划线逐字动画（hold+reveal 帧常量） | 低 | △ 锦上添花 |
| 7 | 显示层 sanitize（content 原样存储为身份键） | 低 | ○ 顺手 → 实际事项为补全 issues T6 |