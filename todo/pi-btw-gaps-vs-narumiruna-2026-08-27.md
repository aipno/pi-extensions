# pi-btw gaps vs narumiruna/pi-btw (2026-08-27)

本包为 narumiruna/pi-extensions 的 pi-btw 的原创重写，行为尽量对齐，
但有意为之的差距如下（维持定位决策，非缺陷）。

## 已实现（对齐参考）

- `/btw <question>` 立即开侧线程；`/btw` 打开菜单（Start / Resume / Settings）
- 全屏侧线程视图：转录 + 输入框 + footer 提示 + thinking level 头部
- thinking level 循环（app.thinking.cycle 键位），固定 level 记忆写入 pi-btw.json
- Steering 队列：回答中继续输入排队，失败回合不丢弃队列，逐条回答
- Ctrl+C 取消当前请求并关闭；非空线程保留在内存，Resume 按 updatedAt 排序
- bring-to-main：最新 / 从某问开始 / 整条线程 → 预览 → 追加/替换（二次确认）/取消
  - 主编辑器已有草稿时自动询问；替换确认期间并发改动会中止
- pi-btw.json：model/thinkingLevel/rememberThinkingLevelChanges，
  读取校验、64KiB 上限、UTF-8 fatal、临时文件 + rename 原子发布、写队列
- 模型解析：配置文件优先，缺失/无凭据回退当前模型并警告
- 主线对话上下文快照（40k 字符，工具调用/结果摘要）
- 主题搜索（Ctrl+Shift+F）、鼠标滚轮、鼠标选择复制：**无**（见下）

## 差距（v1 不做，后续可补）

| 参考实现 | 本包 v1 | 说明 |
| ---- | ---- | ---- |
| TuiAltScreen 二次 TUI（alt screen 独占终端） | 单次 `ui.custom` 覆盖层 + 状态机 | 主 TUI 内全屏覆盖：更简单、无终端闪烁风险；但失去 TuiAltScreen 的搜索/鼠标能力 |
| Ctrl+Shift+F 转录搜索（主题高亮、Enter/Ctrl+G 下一条） | 无 | 需自绘搜索状态或迁移 altscreen |
| 鼠标滚轮滚动转录历史 | 仅 PgUp/PgDn 键盘滚动 | 主 TUI 覆盖层不接鼠标事件；可后续用 pi 的 `onTerminalInput` + SGR 解析 |
| 鼠标拖选复制到系统剪贴板（Copied!/Copy failed 反馈） | 无 | 同上 |
| 文本区间选择器（行选 + 字符选、token 预估、● 标记、水平滚动） | 仅"从某问开始"这一粗粒度起点 | 带回粒度：最新 / from / entire 三档 |
| 主线程树选择器（native TreeSelectorComponent、复制整条入口、Shift+L 改 label） | 无 "Start from main thread tree…" | 依赖 pi 的 TreeSelectorComponent 与 Label 写入；后续可加 |
| pi-tui-kit 菜单（搜索、可配置键位、每屏记忆） | 自绘菜单（固定 ↑/↓/Enter/Esc，记住每菜单选中项） | 键位不可重绑 |
| Answering 转圈 Loader 动画 | 静态 "Answering…" | 避免测试进程事件循环悬挂 |
| flash 通知（alt screen flash 栈） | 通知走主 footer；会话内警告以状态行呈现 | 覆盖层打开时主 notify 不可见 |

## 行为等价说明

- 主编辑器草稿在会话期间原样保留（覆盖层不触碰编辑器，关闭后焦点还原）。
- 会话内 settings 展示的是会话启动快照 + 本会话保存结果，不重读文件。
- steering 编辑器草稿在连续 answering → answering 之间保留（参考实现每次新建）。
- 新建线程 id 为 `btw-N` 自增；Resume 复用原 id，注册表仅在新增回合时重排。