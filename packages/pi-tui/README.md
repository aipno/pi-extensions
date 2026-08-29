# pi-tui

Pi 的 Claude Code 风格 TUI 渲染套件：工具卡分组摘要、折叠/展开、rich edit/write diff，以及 `on` / `compact` / `off` 三种渲染模式。

> 本包是 [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)（MIT）的**核心渲染器套件**移植：
> 覆盖其 `/ccstyle` 主体（工具渲染、diff、compact、thinking 概览、working 消息、启动 header），
> 并已移植 `/context` 与 agent 回合摘要；不含 `@` session/subagent 引用、markdown 增强（维持定位决策，
> 详见 `todo/pi-tui-gaps-vs-pi-cc-extensions-2026-08-27.md`）。
> 命名空间完全隔离（命令、配置文件、补丁符号均改为 `pi-tui`），与原插件可共存。

## 快速开始

```bash
# 本地包（本仓库）
cd packages/pi-tui && npm install

# 作为 pi 包安装
pi install git:github.com/earendil-works/pi-extensions # 或在 pi 内 /packages 引用
```

安装后执行 `/reload`。默认 `mode: on`，也可通过 `/tui-style` 切换。

## 功能

| 功能 | 说明 | 入口 |
| ---- | ---- | ---- |
| Claude Code 风格工具 UI | 工具摘要、折叠展开、rich edit/write diff，`on` / `compact` / `off` 三种模式 | `/tui-style` |
| 配置面板 | Style / Diff / Thinking / UI / Feature 五页签 | `/tui-style` |
| Working 消息 | 底部 Working... 附加 token 数 / 耗时 | 自动生效（`enableWorkingMessage`） |
| 启动 header | 圆角边框盒 + 动画 logo + 模型/CWD 信息 + 命令 tips（可关闭） | 自动生效（`showStartupHeader`） |
| 自定义 footer | 替换 Pi 内置页脚：`模型 · 思考 | 上下文进度条`；`cwd | 分支 | 🔌 MCP | CH | 成本` | 自动生效（`enableCustomFooter`） |
| 上下文检查 | 上下文占用分布 + System prompt / Memory / Skills / Tools 预览 | `/context` |
| Agent 回合摘要 | 每回合工具统计（bash/read/edit/write/other）追加为 `> [!TIP]` 引用块 | 自动生效（`enableAgentSummary`） |
| 鼠标交互 | 工具卡/group 单击展开、双击收起、预览、hover 高亮、回到底部按钮 | fullscreen 模式自动生效 |
| 主题 | 随包提供 pi-tui-dark、pi-tui-light | `/theme` |
| 别名 | `/clear`、`/exit` | `enableAliases` |

## 配置

`/tui-style` 的行为由 `~/.pi/agent/pi-tui.json` 配置：

```js
{
  "mode": "on",                            // on / compact / off
  "excludeRenderers": [],                  // 走原生渲染的工具名；Agent 始终保留专用渲染器

  // diff
  "diffViewMode": "auto",                  // 布局：auto / split / unified
  "diffIndicatorMode": "bars",             // 变更指示：bars / classic / none
  "diffSplitMinWidth": 120,                // 左右分栏的最小终端宽度
  "editDiffCollapsedLines": 24,            // Edit 折叠行数，超出显示展开提示
  "writeDiffCollapsedLines": 0,            // write 折叠行数，0 仅显示创建摘要
  "diffWordWrap": true,                    // 长 diff 行换行
  "expandedPreviewMaxLines": 40,           // 展开正文最大行数
  "toolInputNameLength": 100,              // 工具摘要 path/command 折叠字符数

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // 用最新摘要作思考标题
  "previewLines": 3,                       // 预览行数，0 隐藏
  "animationIntervalMs": 90,               // 标题动画间隔（毫秒）
  "dimThinkingText": false,                // thinking 正文用 dim 色

  // ui
  "showStartupHeader": true,               // 启动头（盒式动态 logo + 模型/CWD 信息 + tips）开关
  "enableCustomFooter": true,              // 自定义页脚：模型 · 思考 | 上下文进度条；cwd | 分支 | MCP | CH | 成本
  "scrollStepLines": 3,                    // fullscreen 滚轮步进

  // feature
  "enableWorkingMessage": true,            // Working... 底部 token/耗时
  "enableAliases": true                    // /clear、/exit 别名
}
```

> **Fullscreen**：单击 `click to show more` 展开工具卡、思考、Skill 和 compact 摘要，双击展开面板收起。

## 本地开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test tests/**/*.test.ts
```

## 与参考项目的差异

| 项 | pi-cc-extensions / pi-claude-code-tui | 本包 |
| -- | ------------------------------------- | ---- |
| 命令 | `/ccstyle` | `/tui-style` |
| 配置文件 | `~/.pi/agent/claude-code-style.json` | `~/.pi/agent/pi-tui.json` |
| 补丁符号 | `pi.ccstyle.*`（Symbol.for） | `pi.tui.*`（Symbol.for） |
| 命令/状态文案 | Claude Code style | Pi TUI style |
| 启动 header | 移植 [Phoobobo/pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)（MIT）的盒式动画 logo + tips 样式 | 同左，tips 固定命令换为 `/tui-style` |
| 裁剪模块 | — | `/context`、`@` 引用、markdown 增强、agent-summary、编辑框圆角/工作动词不在本包 |

补丁采用 `Symbol.for` 全局注册表 + 所有权守卫：`/reload` 后旧模块实例不会误删新模块的补丁；若两个包同时安装，`pi.ccstyle.*` 与 `pi.tui.*` 互不干扰。

## 兼容性

- Node.js `>=22.19.0`，Pi `^0.84.0`
- 运行时依赖 `@shikijs/cli`（diff 语法高亮，懒加载，加载失败自动回退无高亮）

## 致谢

- 移植自 [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)（MIT）
- Rich diff 改编自 [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display)（MIT）；详见 [`extensions/renderer/tool/diff/ATTRIBUTION.md`](./extensions/renderer/tool/diff/ATTRIBUTION.md)