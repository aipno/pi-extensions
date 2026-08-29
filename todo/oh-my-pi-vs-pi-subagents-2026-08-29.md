# oh-my-pi 学习记录 — 对 pi-subagents 的借鉴（2026-08-29）

> 对照：`packages/pi-subagents`（子代理委派：child pi session、六类 agent、后台异步）
> vs oh-my-pi 的 task 子代理栈：`packages/coding-agent/src/task/`（executor 3649 行 +
> render 1830 行 + types/parallel/worktree/persisted-revive 等 ~13k 行）
> 和 `registry/agent-registry.ts`（进程级 agent 注册表）。
> omp 子代理是宿主内核级实现（进程内 agent session + 会话树 + worktree 隔离），
> 我们不能照搬内核，但**运行时的守护策略**与**渲染的信息密度**几乎全部可移植。

---

## 1. 软请求预算（soft request budget）：分级收口而不是硬杀（高价值）
`executor.ts:95-135`，对"子代理跑飞"的三级降级：
- soft budget（scout/sonic 100 次、其余 200 次请求）**超线只是注入 wrap-up steering
  通知**："Wrap up now… At 150 requests the run is force-stopped and you will be
  asked to yield whatever you have."（`buildBudgetNotice`，措辞精确告知阈值与后果）。
- 1.5× 预算时停掉自由轮次 + **驱动一次强制 `yield`**，让部分成果以正式报告落地；
- 仍不交卷再给 `BUDGET_STOP_GRACE_REQUESTS = 5` 次宽限，最后才 hard-abort。
- 预算是"天花板"语义（`resolveSoftRequestBudget`）：设置值与 agent 内置值取**较小者**，
  设置只能调低不能调高；0 完全关闭守护。

我们的子代理只有 stop_reason/超时兜底。这套「提醒 → 强制收尾 → 宽限 → 终止」的
阶梯对长跑 agent 是通用解，注入文案模板可直接复用。

## 2. AgentProgress：进度结构是渲染协议（高价值）
`task/types.ts:398 AgentProgress` 是子代理渲染的单一数据源，字段设计有几处讲究：
- **`tokens` 与 `contextTokens` 分离**（注释明说）：前者是"全生命周期计费量"
 （input+output+cacheWrite，**刻意不含 cacheRead**——每轮重读缓存会把累计值虚高），
  后者是"当前 turn 的上下文占用"（最新 assistant 的 totalTokens，与 contextWindow 比
  画 `<curr>/<window>` 表）。**两个数字两种用途，混用是常见错误**。我们的
  pi-subagents 面板/摘要若要画 context gauge，直接按此口径。
- `currentTool/currentToolArgs/currentToolStartMs + recentTools[] + lastIntent`：正在做
  什么、做了多久、刚才做完什么，一张快照全覆盖。
- `requests` 计数独立于 tokens——预算守护（第 1 条）就建立在它上面。

## 3. 状态行渲染：完成是"变色不变形"（UI 细节，直接抄）
`render.ts:905-990` 的行设计原则（每条都有注释讲理由）：
- **running/pending 行静态**，不加 spinner：detached 派生的 async 子代理会长久处于
  pending，转圈会误读为"本回合在等它"；dispatch 图标由 Task 头部承担（:918 注释）。
- **完成行保留圆点但从 accent 色落回前景色**："completion reads as a color change,
  not a new glyph"（:937）——完成态不加新图标、只变色，视觉噪音最小。
- **retry 徽标优先于 running 态**（:944）："we're waiting on a quota window" 才是
  操作上有意义的状态，父级立即看到孩子卡在 429 而非以为在默默推进。
- **当前工具行超 5s 才显示耗时**且用 warning 色（:969-973）；工具间隙显示最近完成的
  工具（:975-985），面板永远有事可读。
- 重试明细行给出下次重试时间（"retrying 2/5 in 3m12s"，:993-1000）："Without this,
  the parent UI would just keep spinning while a child sleeps on a 3-hour
  provider rate-limit."

## 4. 失败消息的 provider 归因（低成本，直接抄）
`task/error-attribution.ts`（39 行）：子代理可能被 modelRoles/agent frontmatter/
catalog fallback 路由到与父会话不同的 provider；spawn 失败若只透原始流错误，
**错在哪个 transport 是不可见的**（issue #4813：Claude OAuth 会话报 Cursor 错误）。
修正：失败消息打上 `[provider/model]` 前缀，但**消息本身已含 provider 名时跳过**
（避免 `[cursor] cursor error ...` 的重复）。我们的 subagents 错误转发建议加同一层。

## 5. 只读判定的 fail-safe 集
`task/read-only-policy.ts`：agent 是否只读 = 声明的工具是**非空真子集**且全部在
`READ_ONLY_TOOL_NAMES` 白名单内；**任何未知工具即判非只读**（fail-safe 向权限收紧
方向倾斜）。我们的 agent 定义（scout/worker/reviewer…）同样需要"该 agent 能不能
写盘"的判定，这个白名单 + 未知即否的模式值得复用。

## 6. spawn 白名单策略
`task/spawn-policy.ts`：agent frontmatter `spawns: false | true | "a,b"`
→ 解析为 `{enabled, defaultAgent, allowedAgents|null, allowedErrorText}`，
拒绝文案随策略生成（"none (spawns disabled for this agent)"）。配合
`canSpawnAtDepth`（types.ts:330，`maxRecursionDepth < 0` 表示无限制）形成
"谁能生、生谁、生多深"的完整策略面。我们目前只有固定一层子代理；做嵌套时这是
现成蓝本。

## 7. parked/revive 生命周期（概念储备）
`registry/agent-registry.ts`：进程级注册表把 agent 状态分为
`running / idle / parked / aborted`：
- **parked**：session 已释放，但 AgentRef + sessionFile 保留，可复活（revive）——
  "finished agents stay registered, not removed"。
- 显式 kill 留 `.tombstone` 边车文件（:23）防止复活。
- `task/persisted-revive.ts`：重启后从会话文件恢复 parked agent，且上下文引用是
 **活的引用**（cwd/artifact manager 按需读，注释："a later /new or cwd move is
 followed rather than snapshotted"）。

我们的 async 子代理结束即弃。parked + revive 模型（尤其是"历史子代理可被
继续询问/唤醒"的交互，见 agent-hub 的 `r` 键）是子代理体验的下一个台阶，
值得作为 roadmap 记录。

## 8. 渲染防跳动细节（可移植到我们的 agent-summary/工具卡）
- **流式 call 预览的布局镜像**（render.ts:838-860 注释）：call 预览刻意复用 result
  框的 section 顺序（context → assignment → agent rows），且与 schema 字段流序一致
  （context 先流），保证**首个进度快照替换 call 视图时行不跳动**、追加式增长不回顶。
- Markdown brief（子任务描述）从 call 到 result **全程保留**（:800 注释），不像一般
  工具卡结果替换调用视图——委派的"任务书"是父级用户最需要持续看到的信息。
- 子代理 settings 用 `Settings.isolated()` 派生而非共享（executor.ts:948）：
  子代理强制 yolo 审批（无 UI 可确认，**父级 task 批准即授权边界**，注释原话），advisor
  默认关——"子代理默认无 UI、无二次询问、父批准即全权"是个明确的授权模型声明。

---

## 落地建议（pi-subagents）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | 软请求预算阶梯（提醒文案 + 强制收尾 + 宽限 + 终止） | 中 | ○ 核心价值 |
| 2 | 失败消息 provider/model 归因前缀 | 极低 | ○ 立即 |
| 3 | context tokens 与累计 tokens 分口径展示（含 cacheRead 刻意剔除的理由） | 低 | ○ 下次动摘要时 |
| 4 | 状态行设计：running 不转圈、完成只变色、retry 徽标、>5s 耗时 | 低 | ○ 高 |
| 5 | 只读白名单 fail-safe 判定 | 低 | △ 有新 agent 类型时 |
| 6 | spawn 白名单 + 递归深度策略 | 中 | △ 做嵌套子代理时 |
| 7 | parked/revive 生命周期 | 高 | △ roadmap |