# pi-tui 与 pi-cc-extensions 的差距清单（2026-08-27）

> 对比对象：本仓库 `packages/pi-tui`（v0.1.0，移植套件）与 [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)（参考项目，MIT）。
> 方法：克隆参考仓库后逐文件比对（9 文件缺失 MISS、15 文件差异 DIFF），并核对 config/panel/命令/测试/主题。
> 结论：**核心渲染主体是 1:1 移植（纯命名空间改名）**，差距全部集中在 4 个未移植的功能模块 + 1 个设计分歧 + 附属测试/文档。
>
> **状态更新（2026-08-27 二轮）**：4 大块中 **2 块已移植落地**（`/context`、agent 回合摘要，见各节 ✅ 标注），
> 配置/面板差距随之收窄为 2 个开关；剩余 2 块（`@` 引用、markdown 增强）经评估**维持不移植**（README 定位声明，见第五节）；
> 本地新增 2 项参考项目没有的独有改进（自定义 footer、双语 i18n）。
> **当前与参考的实际剩余差距：只有"不移植"与"可选工程产出"两类，无规划内的功能缺口。**

---

## 一、功能缺失（4 大块，参照代码约 2300 行）

| 缺失模块 | 参考代码量 | 职责 | 状态 |
|---|---|---|---|
| `/context` 命令 | `feature/context.ts` ~714 行 | 上下文分析器：systemPrompt / memoryFiles / skills / tools / toolResults / contextFiles 各部分 token 估算、预览 dialog | ✅ **已移植**（`267c979`）：`feature/context.ts` + `registerCommand("context")` + `enableContextCommand` 开关 + `context-dialog.test.ts` |
| `@` session/subagent 引用 | `feature/reference/` 3 文件 ~1050 行 | session.ts + index.ts：`@session` 引用贴片渲染（SessionManager）；subagent.ts：`@subagent` 自动补全（读 ~/.pi/agent/subagents + fuzzyFilter） | ⏸ **不移植**（决策）：依赖宿主的 autocomplete 契约，移植风险最高；README 定位明确不含 |
| agent 回合摘要 | `feature/agent-summary/` 2 文件 ~250 行 | `agent_end` 时把本回合工具统计（bash/read/edit/write/other）写入会话条目，渲染为 `> [!TIP] *斜体*` 引用块；appendEntry 不进 LLM 上下文 | ✅ **已移植**（`11fed2a`）：`feature/agent-summary/` + `enableAgentSummary` 开关 + `agent-summary.test.ts` |
| markdown 增强 | `renderer/markdown-enhance.ts` ~297 行 | mermaid 等 diagram 方言渲染（依赖 grok-mermaid） | ⏸ **不移植**（决策）：需引入 grok-mermaid 依赖；与"渲染套件"定位不符 |

> 注：README 的排除项声明已同步更新——现在只剩 `@` 引用与 markdown 增强两项未含（见第五节）。

---

## 二、配置 / 面板差距

- ~~缺 4 个 `enable*` 开关~~ → **已补齐 2 个，剩 2 个**（`enableSessionReference`、`enableSubagentAutocomplete`，随 `@` 引用一起不移植）：
  - ✅ `enableContextCommand`（`267c979`）、✅ `enableAgentSummary`（`11fed2a`）
  - 原有：`enableWorkingMessage` / `enableAliases`；本地另有独有开关 `enableCustomFooter`（见第四节）
- `/tui-style` 的 **Feature 页签**：~~2 项~~ → 现为 4 项（context / agentSummary / workingMessage / aliases），另有 UI 页签的 Custom footer 开关（本地独有，参考无此页签项）。
- config 解析层其余（diff / thinking / UI / startupHeader 等）与参考完全一致。

## 三、启动 header 设计分歧（不是缺失，是两代设计）

- **本地**（465 行）：移植自 Phoobobo/pi-claude-code-tui——圆角边框盒 + install.sh **动画 logo**
  （红/青/绿滑入 → 灼烧闪白 → 定格为 accent 色）+ 左栏居中 + 右侧 tips。
- **参考**（316 行）：新版设计——官方 install.sh **静态 logo**（4 行）+ hero 文案
  *"There are many agent harnesses, but this one is **yours**."* + accent **真彩渐变** + 左右双栏。
- 视觉完全不同，属纯偏好选择，无对错。**维持本地动画版**（无替换计划）。

## 四、本地独有的东西（不算差距，是主动改进）

- `feature/text-preview.ts`：鼠标文字预览被**拆成独立 feature**——参考里它藏在 context.ts 内部，
  只在 `/context` 开启时生效；本地拆出后鼠标悬停预览始终可用。
- `feature/footer.ts`（**新增**）：自定义 footer 替换 Pi 内置页脚——`模型 · 思考 | 上下文进度条`；
  `cwd | 分支 | 🔌 MCP | CH | 成本`，按 user.md 设计稿实现；参考项目无此功能。
- 双语 i18n（**新增**）：`locales/en.json` + `locales/zh.json`，`/tui-style → UI → Language` 切换
  （`991d596`）；参考项目所有 UI 文案均为英文硬编码。
- 主题内容与参考一致，仅改名（cc-dark → pi-tui-dark、cc-light → pi-tui-light）。

## 五、测试 / 文档

- 测试数：**本地 185+（28 个测试文件）远超参考 27 个**；随两个功能移植补齐了
  `agent-summary.test.ts`、`context-dialog.test.ts`；与参考差距只剩 `@` 引用/markdown 的对应测试
  （`session-reference.test.ts`、`autocomplete-compat.test.ts`、`markdown-enhance.test.ts`，随功能不移植）。
- 参考有 `docs/tool-render-examples-{compact,default}.md` + 生成脚本
  （scripts/generate-tool-render-examples.{mjs,ts}，渲染快照文档），本地没有——**可选工程产出，暂不做**。

---

## 剩余 backlog（全部为"决策不移植"或"可选工程产出"，无规划缺口）

| 项 | 成本 | 决定 | 触发条件 |
|---|---|---|---|
| `@` session/subagent 引用 | 中高（1050 行 + 2 测试） | 不移植 | 仅当宿主 autocomplete 契约稳定且用户明确需要时重估 |
| markdown 增强（mermaid） | 低（297 行，但依赖 grok-mermaid） | 不移植 | 用户明确愿意为 diagram 渲染加依赖时 |
| startup-header 换新版 | 中 | 维持动画版 | 纯视觉偏好，物色到更喜欢的样式再说 |
| 渲染快照文档 + 生成脚本 | 低-中 | 暂不做 | 可选工程产出，非功能 |