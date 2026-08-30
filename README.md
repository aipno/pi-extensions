# pi-extensions

pi 插件集合

- [pi-subagents](packages/pi-subagents) — 让 Pi 委派任务给子代理
- [pi-ask-user-question](packages/pi-ask-user-question) — 结构化问卷工具：模型在需要决策时向用户提出带选项的问题
- [pi-todo](packages/pi-todo) — 实时任务看板：`todo` 工具 + `/todos` 命令 + 编辑器上方的持久化面板，会话重载/压缩后任务不丢失
- [pi-mcp-adapter](packages/pi-mcp-adapter) — MCP 适配器：用一个代理工具按需发现并调用 MCP server，避免把数百个 tool schema 塞进 context
- [pi-tui](packages/pi-tui) — Claude Code 风格 TUI 渲染套件：工具卡分组、折叠/展开、rich diff、compact 模式，`/tui-style` 命令 + 配置面板
- [pi-btw](packages/pi-btw) — 侧线程问答：`/btw` 全屏侧线程（菜单/设置/steering 队列/thinking level 循环/bring-to-main 预览与追加/替换），主线对话零干扰
- [pi-chrome-dev-tools](packages/pi-chrome-dev-tools) — Chrome DevTools 协议集成：`chrome_devtools_*` 工具（列页面/选页面/导航/执行 JS/截图）+ 按需加载器 + 浏览器自启动，`/chrome-devtools` 命令管理工具可用性与连接设置
- [pi-stamp](packages/pi-stamp) — 会话转录时间戳 + 计时：每条消息右下暗淡时间戳、响应耗时/助手元数据/工具耗时可选项，`/stamp` 菜单 + `pi-stamp.json` 原子持久化，时间戳不进模型上下文
- [pi-tools](packages/pi-tools) — 自研文件工具套件覆盖 pi 内置：纯 TS 搜索引擎（gitignore 感知、可选 rg 快路径）、SQLite/ZIP/TAR 读取、原子写入、fuzzy 多编辑，grep/read/write/find/ls/edit 六件套同名注册即替换原版
- [pi-usage](packages/pi-usage) — 用量查询：`/usage` 菜单查看当前账号在 Codex/Kimi Coding/GitHub Copilot/OpenRouter/OpenCode Zen/xAI/Z.AI 的额度与用量，`/fast` 切换 Codex Fast、Codex 重置安全赎回，statusline 每 5 分钟刷新（node:test 直跑、无 dist 预构建）

## CI

GitHub Actions（`.github/workflows/ci.yml`）在 **Ubuntu / Windows / macOS** 三平台 × Node 24 上对全部插件运行 `npm install` + `typecheck` + 单元测试，任一平台失败即标红（`fail-fast: false`，各平台结果互不掩盖）。

本地复现同一流程：

```bash
node scripts/ci.mjs                        # install + typecheck + test（全部包，并行 3）
node scripts/ci.mjs --stages typecheck     # 只跑 typecheck
node scripts/ci.mjs --only pi-mcp-adapter  # 只跑某个包
```

MCP conformance 套件（bash 依赖）单独在 Ubuntu 上运行且 `continue-on-error`，不阻塞合并。

## 致谢

以下项目的优秀实现为本仓库各个插件提供了设计灵感，在此表示感谢：

- [pi-ask-user-question](packages/pi-ask-user-question) 与 [pi-todo](packages/pi-todo) 仿照 [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) 的 rpiv-ask-user-question 与 rpiv-todo
- [pi-mcp-adapter](packages/pi-mcp-adapter) 参考 [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)
- [pi-tui](packages/pi-tui) 参考 [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 的核心渲染器套件
- [pi-btw](packages/pi-btw)、[pi-chrome-dev-tools](packages/pi-chrome-dev-tools)、[pi-stamp](packages/pi-stamp)、[pi-usage](packages/pi-usage) 仿照 [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) 的同名插件（pi-btw 为原创重写，无外部 kit 依赖）
