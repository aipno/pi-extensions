# oh-my-pi 学习记录 — 对 pi-ask-user-question 的借鉴（2026-08-29）

> 对照：`packages/pi-ask-user-question`（4 问终端选项对话框，rpiv 移植版）
> vs oh-my-pi 的 ask 工具：`packages/coding-agent/src/tools/ask.ts`（1467 行）
> + `modes/components/ask-dialog.ts`（1083 行，预览渲染）。
> omp 的 ask 与我们同源（都参考了 Claude Code 的 ask_user_question 交互），
> 但功能层与健壮性层多了不少东西，以下按价值排序。

---

## 1. 超时自动选择推荐项（高价值）
omp 的 ask 支持 `timeout` 参数：超时后**自动选中 recommended 项**返回，不阻塞 agent
（`tools/ask.ts:15`："Questions may time out and auto-select the recommended option
(configurable, disabled in plan mode)"）。
配套细节值得抄：
- `getAutoSelectionOnTimeout()`（:176）：无推荐时回退选第一项，永不返回空答案。
- **超时归因窗口**（:153-155）：deadline 后 1s 内收到的 `undefined` 归因为 UI 超时关闭，
  之外的取消才算用户 Esc——兼容"关闭了对话框但没调 onTimeout"的上层实现。
- `timeoutStartsOnPresentation`（:424）：对话框真正展示后才开始计时（防止工具排队时提前烧掉时限）。
- 结果里带 `timedOut: boolean` 标记（:109），工具结果可向模型说明这是超时代答。

我们当前的问题对话框会无限等待；加超时+推荐回退可以覆盖"无人值守"场景（后台任务、批量询问）。

## 2. preview 侧栏渲染 + 渲染缓存（高价值）
omp 问句的每个选项可带 `preview` 富文本，选中时右侧/下方渲染（对应 Claude Code 的
preview 功能，我们的 README 也声明过）。omp 的实现要点（`ask-dialog.ts:162-353`）：
- `splitPreviewSegments()` 把 preview 解析为 {代码段, 文本段}，代码段整段渲染、文本段走
  markdown 内联渲染（:162-217）。
- **Preview 渲染缓存**：`renderCachedPreview(cache, preview, width)` 以 `preview → byWidth`
  二级 Map 缓存（:234-242），上下键切换选项时同一 preview 重复渲染零成本。
- 渲染行加 `│` 竖线左侧装饰（:243），与选项区视觉分隔。
- 宽度预算：`previewWidth = max(1, width - 8)`，窄终端自动压缩不溢出。

我们尚未实现 preview；这份实现可直接对照（包括"自定义输入行也做 live 预览"）。

## 3. 行预算优先级裁剪（窄终端不破版）
用户选 "Other" 自定义输入时，omp 把问题+选项+说明重组成"标题页"（`tools/ask.ts:218-390`）：
- 每行带 `priority`：问题/光标行 -1（永不裁）、选中说明 2、已勾选说明 1、未选中说明 0。
- `applyCustomInputRowBudget()`（:372）：超出 16 行预算时**先丢低优先级、同优先级丢后面的**，
  保证最早出现的选项说明存活，24 行终端也放得下输入框。
- 选项多时折叠 "… N more options, M checked …" 间隔行（:331），丢失计数不丢失。

我们的 4 问对话框没做任何行预算；这条模式（"行优先级 + 预算裁剪"）同样适用于
长 header 的任何面板。

## 4. 多选（multi）与 radio/checkbox 双标记
- `multi: true` 时选框从 radio 圆点换成 checkbox 勾选（:338-344），且多一行
  "✓ Done selecting" 确认项（:157，动态 label）。
- 自定义输入标题里保留 `checkedIndices` 状态与 markable 数（:190-193），Other 打字时
  依然可见已勾选项。

我们的实现是单选/多选分离的独立问题面板，没有 done 行；参考它把多选确认项做成
**选项列表内的一行动态文案**，交互减少一层。

## 5. 保留标签防注入 + 导航
- 保留选项（"Other (type your own)" / "Chat about this" / "Next →"）做成
  `RESERVED_OPTION_LABELS` 集合（:40-44），模型传入同名 label 会被拒绝——防止模型
  伪造 "Other" 选项诱导用户；我们应对用户自定义选项做同样的防撞处理。
- "Chat about this"（:37）：用户选它时**不返回答案**而是中断工具调用转入自由对话——
  提供"模型问错方向"的逃生门，比 Esc 取消语义更显式。
- 多问问题时支持 back/forward 导航 + 进度文本（:410-416），返回上一题保留已选状态
  （`initialSelection` 回填 :422）。

---

## 落地建议（pi-ask-user-question）

| # | 事项 | 成本 | 优先级 |
|---|---|---|---|
| 1 | 选项 preview 渲染（带 byWidth 缓存） | 中 | ○ 下次功能迭代首先做 |
  > 注（2026-08-29）：落地时应同修 issues Q2（preview 截断展示 vs 回传全文不一致） |
| 2 | 超时 + 推荐自动选择（含归因窗口/timedOut 标记） | 低 | ○ 高 |
| 3 | 行预算优先级裁剪（窄终端保护） | 低 | ○ 顺手 |
| 4 | 多选 done 行 + 保留标签防注入 | 低 | △ |
| 5 | 多问 back/forward 导航 | 中 | △ |
  > 注：第 4 条（保留标签防注入）同时是 issues Q8（大小写绕过保留校验）的修法 |