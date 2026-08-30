# pi-tui omp 借鉴落地计划（直接可借鉴三件套）

> 从 [oh-my-pi-uiux-research-2026-08-29.md](oh-my-pi-uiux-research-2026-08-29.md) 一节 1-3 条抽出，
> 转为可执行的独立计划。每条含：目标 / 现状 / 阻塞 / 实施步骤 / 验收 / 状态。
> 创建日期 2026-08-30；阻塞性结论均来自当日对宿主 dist 与 pi-tui 源码的核实。

---

## 1. 流式平滑渲染（StreamingRevealController 模式）

**优先级**：△ 观望　**预估成本**：中高　**状态**：⏸ 阻塞（宿主 API）

**目标**：助手消息/工具卡片更新从"有更新就整屏重绘"升级为 30fps 逐 grapheme 渐进 +
组件域渲染，消除流式输出的整树闪烁与无效重绘。

**灵感来源**（omp `packages/coding-agent/src/modes/controllers/streaming-reveal.ts`）：
- 30fps tick，每 tick 前进 `max(3, ceil(backlog/8))` 个 grapheme——backlog 大时加速追赶；
- `BlockUnitCounter` 增量计数缓存 `{text, count, tailStart}`，只从上一末尾 cluster 重算，
  避免每帧全文重分词；
- 组件级渲染请求 `requestComponentRender(component)`，不整树重绘（omp 实测：全树 30fps ≈ 5% CPU）；
- provider delta 快于 tick 时合并进下一帧（coalesce），绝不丢字。

**前置条件（阻塞，2026-08-30 核实）**：
- [x] 宿主扩展 API 无 `requestComponentRender`——只有整树 `requestRender`；
- [x] 宿主无 per-delta 流式消息事件暴露给扩展（`core/extensions/` 无 delta 事件）。
→ 两者缺一，30fps 组件域渲染在扩展侧无法落地。

**实施步骤**（前置条件解除后）：
1. 确认宿主侧开放 per-component render 原语或 per-delta 事件（向宿主提案）；
2. 或降级方案：借用现有 `requestRender` + 限帧节流（本包 shared-ticker 已有 80ms 心跳框架），
   只对"正在流式"的卡片做部分内容更新（diff-partial.ts 已有 partial 渐进基础）；
3. BlockUnitCounter 增量 grapheme 计数落地到消息渲染增量追加路径。

**验收标准**：
- 长回复流式期间无整树闪烁，CPU 增量保持低位；
- delta 突增/断流时字不丢（coalesce）。

---

## 2. 行内 word 级 diff 反显 + 缩进可视化

**优先级**：待评估（抖动抑制已先期落地）　**预估成本**：低-中　**状态**：待实现

**目标**：write/edit 工具卡 diff 从"红绿底色块"升级为 omp 式呈现：
改动片段 inverse 视频反显 + 行首缩进可视化。

**现状（2026-08-30 核实）**：
- diff 管线 `extensions/renderer/tool/diff/`：`diff-inline.ts` **已有 token 级切分**
  （`tokenizeInlineDiff`：`(\s+|[A-Za-z0-9_]+|[^A-Za-z0-9_\s])`，MAX 700 字符/行）；
- 着色走 `diff-palette.ts` 的 fg/bg 主题（背景色方案），未用 inverse；
- `visualizeIndent` 不存在；
- 流式抖动抑制已落地：`diff-stream-guard.ts` + `diff-partial.ts`（接入 default-mode）。

**实施步骤**：
1. `diff-inline.ts` 增加行首缩进 span 识别（首段空白），可视化 `·`（空格）/ ` → `（tab），
   仅首段、不影响其余内容；
2. `diff-palette.ts` 增 inverse 渲染路径（SGR 7），红绿底作为降级后备：
   接入 `terminal-capabilities.ts`（已有 truecolor→256/16 量化框架）；
3. 单测：缩进可视化不触碰非首段内容；inverse 在 256/16 色降级终端下仍可读。

**验收标准**：
- 改动片段定位效率不依赖终端配色（反显 vs 底色双路径）；
- 低色深/无 Nerd Font 终端可读（不引入新依赖）。

---

## 3. composer 形态注册表

**优先级**：△ 看需求　**预估成本**：中　**状态**：⏸ 阻塞/待需求（宿主无渲染入口）

**目标**：`/tui-style` 面板增加"输入框样式"项：形态注册 + 设置预览与实际输入框同一 style 对象。

**灵感来源**（omp `packages/tui/src/components/composer/`）：
- `ComposerStyle` 契约：`{id, sideBorders, verticalChrome, renderTop/renderRow/renderBottom,
  statusAttachment, bottomBar, defaultPromptGutter…}`，box/band/claude/pi/borderless/rule/field/rail 八种内置；
- `registerComposerStyle()` 扩展注册（registry.ts:33），冲突/覆盖内建 id 直接抛错；
- 核心设计：编辑器、/settings 预览、setup-wizard 预览同一套 style 对象渲染，三个表面永不漂移。

**前置条件（阻塞，2026-08-30 核实）**：
- [x] 宿主无扩展可用的 composer 渲染/样式 API（`modes/`、`core/` 无注册形态口子；
      `provider-composer.js` 为模型 provider 无关）。
→ 扩展无法替换输入框渲染；先探测宿主是否开放，否则维持"看需求"。

**实施步骤**：
1. 探测宿主 composer 扩展点（如开放）→ 移植 registry 核心（~50 行）；
2. `/tui-style` 增加输入框样式项，预览与真实输入框共用同一 style 对象；
3. 同名 id 冲突/覆盖直接抛错。

**验收标准**：改参数后设置预览与实际渲染一致；并行扩展注册同名 id 冲突可见报错。