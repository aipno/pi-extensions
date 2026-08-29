# oh-my-pi 学习记录 — 对 pi-stamp 的借鉴（2026-08-29）

> 对照：`packages/pi-stamp`（转录右侧暗淡时间戳 / 响应耗时 / 工具执行时长，narumitw 版移植）
> vs oh-my-pi 的同域实现：`modes/components/usage-row.ts`（每轮用量行：本地时间戳 +
> Δturn 耗时 + TTFT + tok/s）+ `session/agent-session.ts` 的 completedAt 落盘机制 +
> `utils/local-date.ts` 时区偏移格式化。
> omp 没有独立的"时间戳"功能——时间信息被融合进 usage-row（transcript 内每轮一条
> 指标行）。这本身就是最大的借鉴：**stamp 不是独立装饰，而是用量行的一个组成部分**。

---

## 1. completedAt 由宿主在 message_end 落盘（口径核心，直接对应我们的做法）
`session/agent-session.ts:2748-2752`：
```ts
// Local completion time for prompt→yield timing: stamped here, not by the
// provider, so the usage row's Δ is exact and provider-independent — some
// providers never report `duration` (gitlab-duo) or stamp `timestamp` at
// request start. Persisted with the message and read on rebuild.
if (event.type === "message_end" && event.message.role === "assistant") {
    event.message.completedAt = Date.now();
}
```
关键决策：
- **本地打点而非 provider 报告**：provider 的 `duration` 不可靠（有的不给、有的把
  timestamp 打在请求起点），自己的 `Date.now()` 才能保证 Δ 精确且跨 provider 一致。
- **随消息持久化**，resume/rebuild 后 usage 行仍可复算（旧消息无 stamp 就显示为无跨度，
  不报错）。
- `turnElapsedMs()`（usage-row.ts:19-32）是**纯函数**：`message.completedAt - turnStartedAt`，
  任一端未知返回 undefined，`elapsed > 0` 才有效。我们的 stamp 已有类似实现；
  这份注释口径（"prompt→yield wall time, no provider-reported duration involved"）
  值得抄进我们代码作为口径声明。

## 2. usage-row：时间戳 + 计时 + 用量一行化（融合方向）
`formatUsageRow(usage, durationMs, ttftMs, timestamp, turnElapsedMs)`（usage-row.ts:35-75）
拼装顺序（带图标，全部可选段按"有数据才显示"）：
```
2026-08-29 14:05:33  ⏱Δ34.2s  ↑ 12.3k  ↓ 890  ⧉ 45.2k  ⏱ 1.2s  ⚡ 26.1/s
        ↑本地时间戳        ↑turn墙钟   ↑input  ↑output  ↑cache  ↑TTFT  ↑tok/s
```
两个口径决策值得照抄：
- **Δ（prompt→yield）与 TTFT 分开标**（:46-49 注释）：Δ 是"用户等了多久"，TTFT 是
 "首字节延迟"，都借用 clock 图标但 Δ 加 `Δ` 前缀以免混淆；duration 来自
 `performance.now()`（分数浮点），**先取整再 formatDuration**，杜绝
 `347.28381699998863ms` 这类原始浮点漏印。
- **tok/s 分母用总时长而非去 TTFT 时长**（:67-71 注释）："the post-TTFT window
  undercounts generation time when reasoning tokens are hidden before the first
  visible byte, inflating the rate"——隐藏 reasoning 时后 TTFT 窗口会低估生成时间、
  虚高速率；直接除总时长更诚实。**我们 footer 的 TPS 恰好按 message.timestamp→entry
  落盘计（同口径，正确），此注释可作为我们 README/代码里的论据**。
- `MIN_DURATION_MS = 100`（:9）：低于 100ms 的"速率"是缓存命中/瞬回，直接不显示——
 防止 footer/戳里出现离谱的 tok/s。我们也应给 TPS/耗时戳加同样的下限。

## 3. 时间格式细节（低成本，直接抄）
- `formatLocalDateTimeWithOffset()`（utils/local-date.ts:10）：`2026-08-29 14:05 +08:00`
  ——本地日期时间后带**数字 UTC 偏移**。跨时区协作/回溯会话日志时，只有本地时间无法
  对齐；带偏移既可读又可换算。我们的 stamp 可在设置里加"带偏移"档。
- 秒级精度（usage-row.ts:11-16 手写 pad，不依赖 toISOString 的时区转换）。

## 4. display vs payload 的去混淆分界（架构决策，与 stamp 相关）
`agent-session.ts:2754+`：model 回显的混淆占位符（`$$HASH$$`）在**事件出口做一层
解混淆供展示**（TUI/exporter 看到真值），持久化路径仍写原 token，下轮出站再混淆。
对我们的启示：时间戳若未来要与隐私清理（sanitize）共存，应遵循同一分界——
**展示层解、存储层原样**，而不是改变落盘数据。

---

## 落地建议（pi-stamp）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | 耗时戳口径注释化（prompt→yield、不依赖 provider duration） | 极低 | ○ 立即 |
  > 注（2026-08-29 冲突裁定）：stamp 用本地差值，但 footer TPS 口径已裁定为 message.duration 优先（见 pi-usage 记录 #5 注）——两者不矛盾：stamp 侧重无 provider duration 时的可复现性，TPS 在 provider 报告可信时用它 |
| 2 | `MIN_DURATION_MS=100` 下限：过短耗时/速率不显示 | 极低 | ○ 立即 |
| 3 | duration 取整后再格式化（防浮点漏印） | 极低 | ○ 立即（查我们是否已有） |
| 4 | 可选"本地时间 + UTC 偏移"格式档 | 低 | △ |
| 5 | 代码注释抄录 tok/s 分母口径论据（供 TPS/stamp 共用） | 极低 | ○ 顺手 |