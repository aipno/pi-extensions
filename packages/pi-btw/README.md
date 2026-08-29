# 💬 pi-btw — 主任务进行中的侧线程问答

在独立的全屏侧线程里问临时问题，主线对话和编码任务保持专注；只有你显式选定
的内容才会带回主编辑器。

> 本包是 [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-btw)
>（MIT）的**原创重写**：行为对齐参考实现（`/btw` 全屏侧线程、thinking level 循环、
> steering 队列、bring-to-main、`pi-btw.json` 设置持久化），
> 但代码为本仓库风格从零实现 —— 无 `@narumitw/pi-tui-kit` 外部依赖，
> 菜单/设置/预览均为包内自绘组件，全部交互基于 pi 原生 `ui.custom` 覆盖层
> （单次覆盖层承载整个会话状态机，主视图零闪烁）。
> 与参考实现的差距见 `todo/pi-btw-gaps-vs-narumiruna-2026-08-27.md`。

## 快速开始

```bash
cd packages/pi-btw && npm install
# 作为 pi 包安装
pi install /path/to/packages/pi-btw
# 或临时运行一次
pi -e /path/to/packages/pi-btw
```

安装后 `/reload`，然后：

```text
/btw what does this TypeScript error mean?
```

立即开启一条侧线程并直接提问；`/btw` 单独运行则先打开菜单：

- **Start side thread** —— 新建空侧线程
- **Resume side thread** —— 恢复本次 pi 会话内仍在内存中的侧线程（按最近更新排序）
- **Settings** —— 设置起始 thinking level 与快捷键记忆开关

## 工作方式

- 侧线程是**独立全屏视图**：转录 + 输入框 + 底部提示。主编辑器草稿原样保留，
  只有主动 bring-to-main 才会改动。
- 按 `Enter` 提问；回答期间可以继续输入排队（`Steering` 队列按顺序逐条回答）。
- `Shift+Tab`（`app.thinking.cycle` 键位）循环当前侧模型的 thinking level；
  固定 level 下默认写入 `pi-btw.json` 供下次会话使用（可在 Settings 关闭记忆）。
- `PgUp`/`PgDn` 翻阅历史转录；手动上翻后新内容不会抢回滚动位置。
- `Ctrl+R` 把选中范围带回主编辑器：作用域菜单（最新一问一答 / 从某问开始 /
  整条侧线程 / 取消）→ 预览确认 → 已有草稿时追加/替换/取消（替换需二次确认，
  确认期间主编辑器被并发改动会中止并提示）。
- `Ctrl+C` 关闭侧线程（回答中则取消当前请求并丢弃草稿与队列）。
- 未成功回答的失败回合以 `Error:` 形式留在转录里，可继续追问或带回。

## 配置

`~/.pi/agent/pi-btw.json`（`$PI_CODING_AGENT_DIR`）：

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "low",
  "rememberThinkingLevelChanges": true
}
```

- `model`：`provider/model-id`，只按第一个 `/` 切分，model id 可含更多斜杠。
  不存在或缺少凭据时警告并回退当前会话模型。
- `thinkingLevel`：省略 = 跟随主线程（Same as main thread）；固定值取
  `off | minimal | low | medium | high | xhigh | max`，并按侧模型的
  capabilities 收敛。
- `rememberThinkingLevelChanges`：默认 `true`；仅对固定 level 生效。

文件读取按每次 `/btw` 生效；写入采用同目录临时文件 + rename 原子发布，
保留未知字段；损坏/超大/非 UTF-8 文件会被拒绝且不被改写。

## 布局

```txt
packages/pi-btw/
├── index.ts          # 扩展入口：/btw 命令、模型解析加载、线程注册表
├── session.ts        # 全屏会话视图：状态机（菜单/设置/composer/answering/预览/交付）
├── side-thread.ts    # 线程模型与消息构建、completeSideThreadTurn、thinking levels
├── model.ts          # 侧模型解析（配置文件优先 + 回退）与 streamSimple 适配
├── settings.ts       # pi-btw.json 读写（校验、排队、原子发布）
├── context.ts        # 主线对话快照（40k 字符上限、工具调用摘要）
├── bring-to-main.ts  # 带回内容的分段/统计/格式（btw_context 块）
├── text.ts           # 单行净化与终端转义
└── test/             # node:test + 本地 test doubles（helpers/harness）
```

## 测试

```bash
cd packages/pi-btw && npm test && npm run typecheck
```

97 个用例覆盖：settings 读写与并发、侧线程提示构建与中止/错误路径、上下文快照、
带回分段与转义、模型解析回退链、全屏会话状态机（菜单/设置/steering/滚动/
bring-to-main 全部分支）与命令流注册表语义。

## License

MIT。参考实现 [pi-btw](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-btw) © narumiruna。