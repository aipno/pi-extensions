# oh-my-pi 学习记录 — 对 pi-usage 的借鉴（2026-08-29）

> 对照：`packages/pi-usage`（多 provider 订阅用量查询：Codex/Claude/GitHub Copilot/
> OpenRouter/Kimi/Z.AI/xAI/New API，/usage 菜单 + 可选 footer 状态行）。
> omp 的同域实现分散在三处：`ai/src/usage/`（17 个 provider 的用量解析器）+
> `coding-agent/src/` 的 status-line/usage-row/usage-report 渲染 +
> `packages/stats`（SQLite 聚合的仪表盘后端）。
> 另有两个高相关组件：`/usage reset`（Codex 重置积分）与 codex-reset-fireworks。

---

## 1. 多账号用量归因：哪一列配额属于当前账号（高价值，多账号场景的规则书）
omp 支持同一 provider 登多账号自动负载均衡，`/usage` 渲染时**每一列 limit 都要判定
归属**。`slash-commands/helpers/active-oauth-account.ts:18-77` 的注释是一份完整的
匹配规则说明（"Single definition of the matching rules for both /usage renderers"）：
- `orgId` 是**限定词不是替代品**：两个订阅（org）可共用同一邮箱——org 级 identity
  只匹配自己 org 的报告；无 org 的旧 identity 绝不通过共享邮箱认领带 org 的报告；
  Anthropic Team 的共享 org 仍需 base-identity 匹配（per-user pool）。
- 兜底链：`email ↔ metadata.email`、`accountId ↔ metadata.accountId/account_id 或
  limit.scope.accountId`、`projectId ↔ scope.projectId`（Google 按 GCP 项目计）。
- 展示 label：`email (org)` 复合形态——同邮箱多 org 只有 org 后缀能区分配额池。

我们的 pi-usage 是"当前凭证 → 查一份报告"的单账号模型，暂无此问题；但 README
若声明多账号方向，这套判定矩阵是现成规格。

## 2. Codex 双窗口（primary/secondary）解析与阈值口径
`ai/src/usage/openai-codex.ts:26-36,155-156`：Codex 报文有 `primary_window`（5h 滚动）
与 `secondary_window`（7 天周限额）两档，omp 两档都解析、都展示。
`shared.ts:36-46` 的全局状态映射很简单但值得统一：
`usageStatus(fraction) → exhausted(≥1) / warning(≥0.9) / ok`——单一函数收敛所有
provider 的阈值判断，UI 不各自发明"红黄绿"。
另：`parsePositiveTimestamp` 容忍秒/毫秒双格式（<1e12 判为秒 ×1000）——
**provider 时间戳单位不一致是常态**，我们的 New API provider 也应过这一层。

## 3. 用量快照落盘 → 历史窗口分析（stats 的架构思路）
`packages/stats` 的做法：auth 层每次拉到 provider 用量报告就**追加一行**写进
agent.db 的 `usage_history`（usage-windows.ts:1-13 注释），仪表盘从快照序列派生：
- 各账号×各窗口的"已用比例随时间"曲线；
- **窗口等效消耗**（window-equivalents consumed）：一周限额按当前燃烧速度能买
  几个完整 window；
- 峰值并发利用率 → 反推"这个峰值需要几个账号"。
- 缺表/缺库一律返回空结果："the dashboard must keep working for API-key-only
  setups"（API-key-only 用户不记录快照也不炸）。

我们的 pi-usage 每次都是实时查询、无历史。哪怕只落地"`usage_history` 追加 + 最近
7 天 utilization 曲线"，/usage 就从"查余额"升级为"看趋势"，且是 append-only 写入、
零迁移成本。快照数据还能反哺 reset 计划（见下条）。

## 4. `/usage reset`：把"额度事件"做成一等交互（思路借鉴）
omp 的 Codex 周限额烧完时可以从**已保存的重置信用**中花一张立即恢复
（reset-usage.ts）。工程上的亮点不在信用本身，而在交互闭环：
- 账号行排序策略（:32-37）：**活动账号优先 → 余量多者优先 → label 字典序**，
  三级稳定排序。
- 每个失败模式一条人话（`describeRedeemOutcome`，:42-52）：`already_redeemed /
  no_credit / credit_list_failed(网络/鉴权，未花钱，可重试) / nothing_to_reset
  (配额本来就没受限，信用没花)`——错误信息带"发生了什么 + 什么没发生 + 下一步"。
- **额度事件驱动视觉**（codex-reset-fireworks.ts）：后台轮询发现"周重置发生了"
  或"重置信用入账"时，状态行放 34 帧 × 85ms 的烟花动画。奖励反馈与使用记录绑定，
  是把枯燥的额度状态变成有情绪反馈的范例。
- 我们暂无"可重置"的 provider，但"错误信息三段式"与"额度事件驱动动画"适用于
   New API（自建网关）场景：网关管理员常常手动重置用户配额，检测到 `used
   → used-回落` 就值得一个视觉事件。

## 5. token_rate 与 CH 的最终口径（与 footer TPS 相互印证）
`utils/token-rate.ts`（omp 的 tok/s 单一算术源，status line 与 vibe worker 共用）：
```
duration 优先级：message.duration（provider 报告）> streaming 时 nowMs - timestamp
               > 两者皆无 → null
rate = output * 1000 / duration；MIN_DURATION_MS = 100 下限
```
与我们的双口径（流式实时 / 落盘均值）互补：omp 多了 **provider duration 优先**，
因为有的 provider（如 Anthropic 流式）在最终 message 里自带可信 duration。
我们 footer 可以在 message_end 后优先用 `message.duration`（若 provider 提供），
entry 差值做兜底——减少一次对落盘时间戳精度的依赖。
cache_hit 口径（status-line/segments.ts:660）与我们已对齐：`cacheRead / (read+write+input)`。

## 6. 其他可摘的点
- **context gauge 十格条**（agent-hub-renderer.ts:148）：`━━━━━───── 45k/200k 23%`
  一行三段（条 + 绝对值 + 百分比），3 行代码。我们 footer 的进度条可对齐这个样式。
- **contextLine: embedded 模式**（settings-schema.ts:788）：左右分段之间的"空隙行"
  本身变成上下文仪表（off/percentage/annotated/embedded 四档）——把"分隔线"变
  "信息面"，是空间紧张时的漂亮解法。
- **usage 行时间戳带 UTC 偏移**（utils/local-date.ts:10，见 pi-stamp 记录）。
- **重置倒计时**（status-line component 对 reset deadline 的处理 + fireworks 检测
  `unscheduled-weekly-reset`）：显示"距重置还有 X 时"且能识别**计划外重置**（网关方
  手动重置）——我们对接 New API 时可用同样方法检测管理员干预。

---

## 落地建议（pi-usage）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | 统一 `usageStatus(fraction)` 阈值函数（exhausted/warning/ok） | 极低 | ○ 立即 |
| 2 | 时间戳解析容错（秒/毫秒双单位）进 shared 层 | 极低 | ○ 立即（New API 已需要） |
| 3 | usage_history 快照落盘 + 简单趋势（append-only，API-key-only 不炸） | 中 | ○ 核心价值 |
| 4 | 错误信息三段式（发生了什么/什么没发生/下一步） | 低 | ○ 顺手 |
| 5 | TPS 口径补强：message.duration 优先于 entry 差值 | 低 | ○ 下次动 footer/usage 时 |
  > 注（2026-08-29 冲突裁定）：pi-stamp 记录曾称现口径"正确"，两文档结论已统一为本优先级（duration 优先、entry 差值回退），与 omp token-rate.ts 一致；与主文档第六节、pi-tui footer 演进专项合并执行 |
| 6 | 检测"计划外重置"（用量回落）触发视觉事件 | 低-中 | △ New API 场景 |
| 7 | 多账号 org/email/projectId 归因矩阵 | 中 | △ 多账号方向时 |