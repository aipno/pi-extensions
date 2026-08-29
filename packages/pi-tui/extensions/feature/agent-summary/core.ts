/**
 * Agent 回合摘要：统计一次 agent 运行的工具使用并格式化成摘要文本（移植自
 * minuque/pi-cc-extensions feature/agent-summary/core.ts，MIT）。
 *
 * 分类：bash / read / edit / write / other（精确工具名；MCP 风格名归 other）。
 * 计数：bash/powershell 按调用次数；read/edit/write 按非空 path/file_path 去重；other 按调用次数。
 * 失败单独累计；另记回合耗时。
 *
 * 文案走 i18n（utils/i18n.ts 的 t()）：en 模板与参考实现逐字一致，zh 模板在
 * locales/zh.json 中按同一结构翻译；模板动词以 [a-z] 开头时自动首字母大写
 * （zh 模板以中文字符开头，大写逻辑自然跳过）。
 *
 * 呈现：`summaryLine` 纯文本，`summaryMarkdown` Markdown（可 box 引用块）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { t } from "../../utils/i18n.ts";
import { formatDuration } from "../../utils/format.ts";
export { formatDuration };

/** 工具分类。 */
export type AgentToolCategory = "bash" | "read" | "edit" | "write" | "other";

/** 一次 agent 回合的统计快照。 */
export type AgentSummaryData = {
	commands: number;
	reads: number;
	edits: number;
	writes: number;
	others: number;
	failed: number;
	durationMs: number;
};

export function classifyTool(toolName: string): AgentToolCategory {
	const base = toolName.split(".").pop() ?? toolName;
	if (base === "bash" || base === "powershell") return "bash";
	if (base === "read") return "read";
	if (base === "edit") return "edit";
	if (base === "write") return "write";
	return "other";
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function toolPath(args?: Record<string, unknown> | null): string | undefined {
	const path = args?.path ?? args?.file_path;
	return nonEmptyString(path) ? path : undefined;
}

/** 累积一次 agent 回合的工具统计；agent_start 时新建实例。 */
export class AgentRunSummary {
	toolCount = 0;
	commandCount = 0;
	readFiles = new Set<string>();
	editFiles = new Set<string>();
	writeFiles = new Set<string>();
	otherCount = 0;
	failedCount = 0;

	readonly startedAt: number;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	/** tool_execution_start 时调用。 */
	recordToolStart(toolName: string, args?: Record<string, unknown> | null): void {
		this.toolCount++;
		const path = toolPath(args);
		switch (classifyTool(toolName)) {
			case "bash":
				this.commandCount++;
				break;
			case "read":
				if (path) this.readFiles.add(path);
				break;
			case "edit":
				if (path) this.editFiles.add(path);
				break;
			case "write":
				if (path) this.writeFiles.add(path);
				break;
			default:
				this.otherCount++;
		}
	}

	/** tool_execution_end 时调用；isError 为 true 计入失败。 */
	recordToolResult(isError: boolean): void {
		if (isError) this.failedCount++;
	}

	snapshot(now = Date.now()): AgentSummaryData {
		return {
			commands: this.commandCount,
			reads: this.readFiles.size,
			edits: this.editFiles.size,
			writes: this.writeFiles.size,
			others: this.otherCount,
			failed: this.failedCount,
			durationMs: now - this.startedAt,
		};
	}
}

const plural = (count: number) => (count === 1 ? "" : "s");

type SummaryPart = { text: string; failed: boolean };

/** 输出顺序：bash → read → edit → write → other → failed；文案模板走 i18n。 */
function summaryParts(data: AgentSummaryData): SummaryPart[] {
	const parts: SummaryPart[] = [];
	if (data.commands) {
		parts.push({
			text: t("summary.ranCommands", "ran {n} command{s}", {
				n: data.commands,
				s: plural(data.commands),
			}),
			failed: false,
		});
	}
	if (data.reads) {
		parts.push({
			text: t("summary.readFiles", "read {n} file{s}", { n: data.reads, s: plural(data.reads) }),
			failed: false,
		});
	}
	if (data.edits) {
		parts.push({
			text: t("summary.editedFiles", "edited {n} file{s}", {
				n: data.edits,
				s: plural(data.edits),
			}),
			failed: false,
		});
	}
	if (data.writes) {
		parts.push({
			text: t("summary.wroteFiles", "wrote {n} file{s}", {
				n: data.writes,
				s: plural(data.writes),
			}),
			failed: false,
		});
	}
	if (data.others) {
		parts.push({
			text: t("summary.otherTools", "{n} other tool{s}", {
				n: data.others,
				s: plural(data.others),
			}),
			failed: false,
		});
	}
	if (data.failed) {
		parts.push({ text: t("summary.failed", "{n} failed", { n: data.failed }), failed: true });
	}
	return parts;
}

/** 首段动词大写（仅对 [a-z] 开头的英文模板生效；zh 模板原样保留）。 */
function capitalizeFirst(text: string): string {
	const verb = text.match(/^[a-z]+/)?.[0] ?? "";
	return verb ? verb[0].toUpperCase() + verb.slice(1) + text.slice(verb.length) : text;
}

const separator = (): string => t("summary.separator", ", ");
const durationSeparator = (): string => t("summary.durationSeparator", " · ");

/** 纯文本摘要行：句首大写 + 可选耗时。 */
export function summaryLine(data: AgentSummaryData): string {
	const parts = summaryParts(data);
	if (parts.length === 0) return "";
	const text = parts
		.map((part, index) => (index === 0 ? capitalizeFirst(part.text) : part.text))
		.join(separator());
	const duration = formatDuration(data.durationMs);
	return duration ? `${text}${durationSeparator()}${duration}` : text;
}

/**
 * Markdown 摘要行。
 * `box` 为 true：引用块 `> *斜体*`；false：整体加粗。
 * `colors`：仅数字染色（success / failed）。
 */
export function summaryMarkdown(
	data: AgentSummaryData,
	box = false,
	colors: { success: string; failed: string } = { success: "", failed: "" },
): string {
	const parts = summaryParts(data);
	if (parts.length === 0) return "";
	const paintNumber = (code: string, text: string): string =>
		code ? text.replace(/(\d+)/, `${code}$1\x1b[0m`) : text;
	const text = parts
		.map((part, index) => (index === 0 ? capitalizeFirst(part.text) : part.text))
		.map((part, index) => paintNumber(parts[index]!.failed ? colors.failed : colors.success, part))
		.join(separator());
	const duration = formatDuration(data.durationMs);
	const line = duration ? `${text}${durationSeparator()}${duration}` : text;
	return box ? `> *${line}*` : `**${line}**`;
}

/**
 * 绑定 pi 事件到摘要统计：
 * - agent_start 重置
 * - tool_execution_start / end 累计
 * - agent_end 回调（toolCount < minToolCount 跳过）
 */
export function bindAgentSummary(
	pi: ExtensionAPI,
	onSummary: (data: AgentSummaryData) => void,
	minToolCount = 2,
): () => void {
	let summary = new AgentRunSummary();
	pi.on("agent_start", async () => {
		summary = new AgentRunSummary();
	});
	pi.on("tool_execution_start", async (event) => {
		summary.recordToolStart(event.toolName, event.args);
	});
	pi.on("tool_execution_end", async (event) => {
		summary.recordToolResult(event.isError === true);
	});
	pi.on("agent_end", async () => {
		if (summary.toolCount >= minToolCount) onSummary(summary.snapshot());
	});
	return () => {
		summary = new AgentRunSummary();
	};
}