/**
 * pi-tui — Pi 的 Claude Code 风格 TUI 渲染套件（移植自 minuque/pi-cc-extensions，MIT）。
 *
 * 功能：工具卡分组摘要、折叠/展开、rich edit/write diff、`on` / `compact` / `off`
 * 三种渲染模式（/tui-style）、thinking 摘要标题动画、working 消息、启动 header。
 *
 * 启动 header 移植自 Phoobobo/pi-claude-code-tui（MIT）：圆角边框盒 + 动画 logo +
 * 模型/CWD 信息 + 命令 tips。
 *
 * 命名空间与参考项目完全隔离：
 * - 命令 `/tui-style`（原 /ccstyle）
 * - 配置文件 `~/.pi/agent/pi-tui.json`（原 claude-code-style.json）
 * - 补丁符号 `pi.tui.*`（原 pi.ccstyle.*），与原插件可共存
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";

// shell chrome
import piAliases from "./feature/shell/aliases.ts";
import { installFlushDockedBash } from "./feature/shell/flush-docked-bash.ts";
import piStartupHeader from "./feature/shell/startup-header.ts";
import workingMessage from "./feature/shell/working-message.ts";
import { installCustomFooter } from "./feature/footer.ts";

// feature
import { installCompactThinking } from "./feature/compact-thinking.ts";
import agentSummary from "./feature/agent-summary/index.ts";
import contextUsage from "./feature/context.ts";

// renderer
import piTuiStyle, { getCompactThinkingConfig } from "./renderer/index.ts";

export default function (pi: ExtensionAPI): void {
	// shell chrome
	if (config.enableAliases) piAliases(pi);
	installFlushDockedBash();
	piStartupHeader(pi);
	installCustomFooter(pi);
	if (config.enableWorkingMessage) workingMessage(pi);

	// render stack：thinking controller 直接交给 style 作 query
	piTuiStyle(pi, undefined, installCompactThinking(pi, getCompactThinkingConfig()));

	// features
	if (config.enableContextCommand) contextUsage(pi);
	if (config.enableAgentSummary) agentSummary(pi);
}