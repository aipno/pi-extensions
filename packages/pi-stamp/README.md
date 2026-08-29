# 🕒 pi-stamp — 给 Pi 会话记录加时间戳与计时

在 Pi 的交互式转录中，为每条用户/助手消息右侧对齐显示一行暗淡的创建时间；
可选展示响应耗时、助手来源与用量、工具执行耗时与结果。

> 本包移植自 [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-stamp)
>（MIT，npm 包 `@narumitw/pi-stamp`）：行为与数据格式对齐参考实现（时间戳 v1–v4、
> 工具戳 v1、`/stamp` 菜单、`pi-stamp.json` 原子持久化、响应计时/元数据/工具计时），
> 代码按本仓库约定移植 —— 直接以 `.ts` 源码加载（无 esbuild dist 构建步骤）、
> `defineMenu` + `runMenu`（与 pi-chrome-dev-tools 一致）、node:test 测试。
> 未移植参考仓库的 `scripts/build-runtime.mjs`（仅供 npm 发布打包用）及其测试。

## 快速开始

```bash
cd packages/pi-stamp && npm install
# 作为 pi 包安装
pi install /path/to/packages/pi-stamp
# 或临时运行一次
pi -e /path/to/packages/pi-stamp
```

安装后 `/reload`，正常使用 Pi 即可。每条新消息下方出现一行右上对齐的暗淡时间戳：

```text
Your message
                                 14:32:08

Assistant reply
                                 14:32:11
```

## /stamp 命令

运行 `/stamp` 打开菜单（TUI / RPC 模式；print / json 模式拒绝，不带参数）：

- **Settings** —— 全部 8 项设置的取值切换
- **Status** —— 各设置当前值与来源（User / Built-in）、设置文件路径
- **Help** —— 行为说明
- **Close** —— 关闭菜单

## 设置

`~/.pi/agent/pi-stamp.json`（`$PI_CODING_AGENT_DIR` 生效时替换 `~/.pi/agent`）：

| 字段 | 取值 | 默认 | 行为 |
| --- | --- | --- | --- |
| `hourCycle` | `"24h"`, `"12h"` | `"24h"` | 时钟制式 |
| `showSeconds` | boolean | `true` | 是否显示秒 |
| `dateContext` | `"day-change"`, `"always"`, `"never"` | `"day-change"` | 跨天时显示日期 / 总是显示 / 从不 |
| `locale` | `"invariant"`, `"system"` 或 BCP 47 标签 | `"invariant"` | 日期时间本地化（invariant = ISO 日期 + 拉丁数字 + 英文 AM/PM） |
| `timeZone` | `"local"` 或 IANA 时区 | `"local"` | 时间与跨天判定所用时区（`UTC` 可用） |
| `responseTiming` | `"off"`, `"duration"`, `"detailed"` | `"off"` | 无计时 / 总耗时 / 首次内容+总耗时 |
| `assistantMetadata` | `"off"`, `"compact"`, `"expanded"` | `"off"` | 模型/总 token/估算成本摘要，或展开全部上报字段（展开 details 时显示净化的 response id 与诊断摘要） |
| `toolStamps` | boolean | `false` | 是否在新出现的工具块后显示耗时与成功/失败 |

设置立即保存并作用于已挂载与后续的时间戳；文件损坏/超大/符号链接会被拒绝且不被改写。

## 工作方式

- 每条 user/assistant 消息在 `message_*` 生命周期内记一次 `pi-stamp` 自定义 entry；
  **完全在模型上下文之外**，不参与 LLM 上下文构建，会话重载/恢复后仍然存在。
- 响应计时 = 消息 `timestamp` → `message_end`（不含工具执行）；首次内容取首个
  非空 text/thinking/toolcall 流更新。
- 助手元数据仅在开启时捕获，写入前做终端转义净化与长度/数量上界
  （敏感字段如 content、responseId 原文、诊断 message/stack 不落盘）。
- 工具戳按 `toolCallId` 严格配对 start/end，同轮并行工具按工具结果顺序追加，
  观察数上限 256，端点缺失/时钟回拨不产生伪造戳。
- 菜单/设置用 `@narumitw/pi-tui-kit` 的 `runMenu`（与参考实现同一版本族），
  保存采用同目录临时文件 + `rename` 原子发布，写入按调用顺序串行排队。

## 布局

```txt
packages/pi-stamp/
├── src/
│   ├── index.ts     # 扩展入口：re-export stamp.ts
│   ├── stamp.ts     # 生命周期 hook、entry 渲染器、/stamp 命令、时间戳/工具戳装配
│   ├── menu.ts      # /stamp 菜单（defineMenu + runMenu，懒加载）
│   ├── settings.ts  # pi-stamp.json 读写（校验、排队、原子发布、abort 安全）
│   ├── format.ts    # 时间/日期标签格式化与设置值规范化
│   └── metadata.ts  # 助手元数据捕获/净化/格式化、耗时与工具戳标签
└── test/            # node:test + 本地 test doubles（helpers）
```

## 测试

```bash
npm test && npm run typecheck
```

58 个用例覆盖：时间格式化与跨天/时区语义、元数据捕获与净化上界、设置读写并发与
原子发布、菜单屏幕与动作、TUI/RPC 菜单驱动、时间戳生命周期装配、工具戳配对与
有界性、会话重载/替换/关闭语义。

## License

MIT。参考实现 [pi-stamp](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-stamp) © narumiruna。