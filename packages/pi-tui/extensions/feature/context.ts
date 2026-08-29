/**
 * /context 上下文占用命令（移植自 minuque/pi-cc-extensions feature/context.ts，MIT）。
 *
 * - 六分区占用分布：System prompt / Memory / Skills / Tools definition / Tool results / Context
 *   + Other / Free space；capParts 预算守恒（System/Memory/Skills/Tools 固定前缀不压缩）。
 * - TUI：状态行选单 overlay，Enter/点击打开对应分区的 Markdown 全文预览；
 *   预览复用本地 feature/text-preview.ts（showTextPreview / escCloseHitbox /
 *   normalizePreviewText / ensureFullscreenMouseMotion / overlay 计数）。
 * - 非 TUI：notify 文本回退。
 *
 * 文案全部走 utils/i18n.ts 的 t()（en 模板与参考逐字一致）。
 */

import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolInfo,
	estimateTokens,
	formatSkillsForPrompt,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { mouseBaseButton, parseSgrMousePacket } from "../utils/sgr-mouse.ts";
import { padLine } from "../utils/format.ts";
import { t } from "../utils/i18n.ts";
import {
	ensureFullscreenMouseMotion,
	escCloseHitbox,
	normalizePreviewText,
	popActiveOverlay,
	pushActiveOverlay,
	showTextPreview,
	type DialogBounds,
} from "./text-preview.ts";

export type ContextPart = {
	label: string;
	tokens: number;
	color: "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error";
};

type PreviewKey =
	| "systemPrompt"
	| "memoryFiles"
	| "skills"
	| "tools"
	| "toolResults"
	| "contextFiles";

type ContextPreview = {
	key: PreviewKey;
	label: string;
	title: string;
	content: string;
};

export type { DialogBounds };
export { escCloseHitbox, hasActiveTextPreview, normalizePreviewText, showTextPreview } from "./text-preview.ts";

const tokenEstimate = (value: unknown): number => {
	if (!value) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(0, Math.ceil(text.length / 4));
};

/** 只统计确实嵌进 system prompt 的片段，避免源文件预览把占用加两遍。 */
function embeddedTokens(prompt: string, chunk: string): number {
	if (!chunk || !prompt.includes(chunk)) return 0;
	return tokenEstimate(chunk);
}

export function capParts(parts: ContextPart[], target: number, fixedPrefix = 0): ContextPart[] {
	const fixed = parts.slice(0, fixedPrefix);
	const variable = parts.slice(fixedPrefix);
	const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
	const variableTarget = Math.max(0, target - fixedTokens);
	const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
	if (estimated <= variableTarget || estimated === 0) return parts;
	if (variableTarget === 0) {
		return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];
	}

	let previous = 0;
	let cumulative = 0;
	const capped = variable.map((part, index) => {
		cumulative += part.tokens;
		const next =
			index === variable.length - 1
				? variableTarget
				: Math.round((cumulative / estimated) * variableTarget);
		const tokens = next - previous;
		previous = next;
		return { ...part, tokens };
	});
	return [...fixed, ...capped];
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

export function resolveUsedTokens(
	usage: { tokens: number | null; percent: number | null } | undefined,
	estimated: number,
	contextWindow: number,
): number {
	const reported = usage?.tokens;
	const fromPercent =
		usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0
			? Math.round((usage.percent / 100) * contextWindow)
			: undefined;
	let resolved = reported ?? fromPercent ?? estimated;
	if (reported !== null && reported !== undefined && fromPercent !== undefined) {
		// 某些 Provider 会返回异常 totalTokens；百分比与底部状态栏不一致时优先采用百分比。
		const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
		if (Math.abs(reported - fromPercent) > tolerance) resolved = fromPercent;
	}
	// tokens 与 percent 可能同时源自异常 usage；数量级明显偏小时回退到实际内容估算。
	if (estimated > 0 && resolved < estimated * 0.25) return estimated;
	return resolved;
}

type ContextBreakdown = {
	parts: ContextPart[];
	previews: Record<PreviewKey, string>;
};

function previewValue(value: unknown): string {
	if (typeof value === "string") return value;
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** 按真实请求的 systemPrompt、tools、messages 三部分同步组装计数与预览（label/文案走 i18n）。 */
export function collectContextBreakdown(
	ctx: ExtensionCommandContext,
	allTools: ToolInfo[],
): ContextBreakdown {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as BuildSystemPromptOptions;
	const systemPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
	const selectedTools = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
	const toolDefinitionPreview: string[] = [];
	const toolResultPreview: string[] = [];
	const contextPreview: string[] = [];
	let toolDefinitionTokens = 0;
	let toolResultTokens = 0;
	let contextTokens = 0;

	const memoryPreview: string[] = [];
	let memoryTokens = 0;
	for (const file of options.contextFiles ?? []) {
		memoryTokens += embeddedTokens(systemPrompt, file.content);
		memoryPreview.push(`## ${file.path}\n\n${previewValue(file.content)}`);
	}

	const skillsText = formatSkillsForPrompt(options.skills ?? []).trim();
	const skillsTokens = embeddedTokens(systemPrompt, skillsText);

	for (const tool of allTools) {
		if (!selectedTools.has(tool.name)) continue;
		const definition = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		toolDefinitionTokens += tokenEstimate(definition);
		toolDefinitionPreview.push(
			`${t("context.definition", "## Definition: {name}", { name: tool.name })}\n\n${previewValue(definition)}`,
		);
	}

	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") {
						contextTokens += tokenEstimate(block.name) + tokenEstimate(block.arguments);
						contextPreview.push(
							`${t("context.assistantToolCall", "## Assistant tool call: {name}", {
								name: block.name,
							})}\n\n${previewValue(block.arguments)}`,
						);
					} else if (block.type === "text") {
						contextTokens += tokenEstimate(block.text);
						contextPreview.push(`${t("context.assistant", "## Assistant")}\n\n${block.text}`);
					} else if (block.type === "thinking") {
						contextTokens += tokenEstimate(block.thinking);
						contextPreview.push(
							`${t("context.assistantThinking", "## Assistant thinking")}\n\n${block.thinking}`,
						);
					}
				}
			} else if (message.role === "toolResult") {
				toolResultTokens += estimateTokens(message);
				toolResultPreview.push(
					`${t("context.result", "## Result: {name}", {
						name: message.toolName,
					})}\n\n${previewValue(message.content)}`,
				);
			} else if (message.role === "bashExecution") {
				toolResultTokens += estimateTokens(message);
				toolResultPreview.push(
					`${t("context.bash", "## Bash")}\n\n${t("context.command", "Command:")}\n\n${previewValue(message.command)}\n\n${t("context.output", "Output:")}\n\n${previewValue(message.output)}`,
				);
			} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${message.summary}`);
			} else {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${previewValue(message.content)}`);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			contextTokens += tokenEstimate(entry.summary);
			contextPreview.push(
				`${entry.type === "compaction" ? t("context.compaction", "## Compaction") : t("context.branchSummary", "## Branch summary")}\n\n${entry.summary}`,
			);
		} else if (entry.type === "custom_message") {
			contextTokens += tokenEstimate(entry.content);
			contextPreview.push(
				`${t("context.custom", "## Custom: {type}", { type: entry.customType })}\n\n${previewValue(entry.content)}`,
			);
		}
	}

	const systemTokens = Math.max(0, tokenEstimate(systemPrompt) - memoryTokens - skillsTokens);
	return {
		parts: [
			{ label: t("context.label.systemPrompt", "System prompt"), tokens: systemTokens, color: "accent" },
			{ label: t("context.label.memory", "Memory"), tokens: memoryTokens, color: "error" },
			{ label: t("context.label.skills", "Skills"), tokens: skillsTokens, color: "warning" },
			{
				label: t("context.label.tools", "Tools definition"),
				tokens: toolDefinitionTokens,
				color: "success",
			},
			{
				label: t("context.label.toolResults", "Tool results"),
				tokens: toolResultTokens,
				color: "customMessageLabel",
			},
			{ label: t("context.label.context", "Context"), tokens: contextTokens, color: "warning" },
		] satisfies ContextPart[],
		previews: {
			systemPrompt: systemPrompt || t("context.empty.systemPrompt", "No system prompt."),
			memoryFiles:
				memoryPreview.join("\n\n") || t("context.empty.memory", "No memory files in context."),
			skills: skillsText || t("context.empty.skills", "No skills in context."),
			tools:
				toolDefinitionPreview.join("\n\n") ||
				t("context.empty.tools", "No active tool definitions."),
			toolResults:
				toolResultPreview.join("\n\n") ||
				t("context.empty.toolResults", "No tool results in the current context."),
			contextFiles:
				contextPreview.join("\n\n") || t("context.empty.context", "No conversation context."),
		},
	};
}

export default function contextUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: t("context.command.desc", "Show the current context-window distribution"),
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const tools = pi.getAllTools();
			const breakdown = collectContextBreakdown(ctx, tools);
			const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
			// System / Memory / Skills / Tools definition 为固定项，capParts 时保持原值不压缩。
			const fixedTokens = breakdown.parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
			const used = Math.max(resolveUsedTokens(usage, estimated, contextWindow), fixedTokens);
			const parts = capParts(breakdown.parts, used, 4);
			const attributed = parts.reduce((sum, part) => sum + part.tokens, 0);
			const other = Math.max(0, used - attributed);
			const free = Math.max(0, contextWindow - used);
			const allParts = [
				...parts,
				{ label: t("context.other", "Other"), tokens: other, color: "muted" as const },
				{ label: t("context.freeSpace", "Free space"), tokens: free, color: "dim" as const },
			];

			if (ctx.mode !== "tui") {
				const lines = allParts.map((part) =>
					t("context.notify", "{label}: {tokens} tokens", {
						label: part.label,
						tokens: formatTokens(part.tokens),
					}),
				);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const previewLabels: ContextPreview[] = [
				{
					key: "systemPrompt",
					label: t("context.label.systemPrompt", "System prompt"),
					title: t("context.title.systemPrompt", "System Prompt"),
					content: breakdown.previews.systemPrompt,
				},
				{
					key: "memoryFiles",
					label: t("context.label.memory", "Memory"),
					title: t("context.title.memory", "Memory Files"),
					content: breakdown.previews.memoryFiles,
				},
				{
					key: "skills",
					label: t("context.label.skills", "Skills"),
					title: t("context.title.skills", "Skills"),
					content: breakdown.previews.skills,
				},
				{
					key: "tools",
					label: t("context.label.tools", "Tools definition"),
					title: t("context.title.tools", "Tools definition"),
					content: breakdown.previews.tools,
				},
				{
					key: "toolResults",
					label: t("context.label.toolResults", "Tool results"),
					title: t("context.title.toolResults", "Tool Results"),
					content: breakdown.previews.toolResults,
				},
				{
					key: "contextFiles",
					label: t("context.label.context", "Context"),
					title: t("context.title.context", "Context"),
					content: breakdown.previews.contextFiles,
				},
			];
			const previews = previewLabels.map((preview) => ({
				...preview,
				content: normalizePreviewText(preview.content),
			}));
			const previewByKey = new Map(previews.map((preview) => [preview.key, preview]));
			const visiblePreviews = previews.filter((preview) =>
				allParts.some((part) => part.label === preview.label),
			);
			let selectedPreviewIndex = 0;

			while (true) {
				// 主弹框也计入活动 overlay，fullscreen 下官方输入链才会把鼠标包放行给行点击。
				pushActiveOverlay();
				let action;
				try {
					action = await ctx.ui.custom(
						(tui, theme, _keybindings, done) => {
							ensureFullscreenMouseMotion(tui);
							let previewHitboxes: Array<{
								key: PreviewKey;
								row: number;
								startCol: number;
								endCol: number;
							}> = [];
							let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
							let escHovered = false;
							let hoveredKey: PreviewKey | undefined;

							return {
								invalidate() {},
								handleInput(data: string) {
									if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
										done(undefined);
										return;
									}
									if (matchesKey(data, Key.up) && visiblePreviews.length > 0) {
										selectedPreviewIndex =
											(selectedPreviewIndex - 1 + visiblePreviews.length) % visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.down) && visiblePreviews.length > 0) {
										selectedPreviewIndex = (selectedPreviewIndex + 1) % visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.enter)) {
										done(visiblePreviews[selectedPreviewIndex]?.key);
										return;
									}

									const mouse = parseSgrMousePacket(data);
									if (!mouse || mouse.final !== "M") return;
									if ((mouse.code & 32) !== 0) {
										// SGR 1003 的无按键 hover code 为 35，不能按左键事件过滤。
										const overEsc = Boolean(
											escHitbox &&
												mouse.row === escHitbox.row &&
												mouse.col >= escHitbox.startCol &&
												mouse.col <= escHitbox.endCol,
										);
										const hovered = previewHitboxes.find(
											(candidate) =>
												mouse.row === candidate.row &&
												mouse.col >= candidate.startCol &&
												mouse.col <= candidate.endCol,
										);
										if (overEsc !== escHovered || hovered?.key !== hoveredKey) {
											escHovered = overEsc;
											hoveredKey = hovered?.key;
											tui.requestRender();
										}
										return;
									}
									if (mouseBaseButton(mouse.code) !== 0) return;
									if (
										escHitbox &&
										mouse.row === escHitbox.row &&
										mouse.col >= escHitbox.startCol &&
										mouse.col <= escHitbox.endCol
									) {
										done(undefined);
										return;
									}
									const hitbox = previewHitboxes.find(
										(candidate) =>
											mouse.row === candidate.row &&
											mouse.col >= candidate.startCol &&
											mouse.col <= candidate.endCol,
									);
									if (hitbox) {
										selectedPreviewIndex = Math.max(
											0,
											visiblePreviews.findIndex((preview) => preview.key === hitbox.key),
										);
										done(hitbox.key);
									}
								},
								render(width: number) {
									const inner = Math.max(1, width - 2);
									const escWidth = visibleWidth("[esc]");
									const percent = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
									const title = theme.bold(
										theme.fg("accent", t("context.title", "Context Usage")),
									);
									const subtitle = theme.fg(
										"muted",
										t("context.subtitle", "{used} / {total} tokens ({percent}%)", {
											used: formatTokens(used),
											total: formatTokens(contextWindow),
											percent: percent.toFixed(1),
										}),
									);
									const barWidth = Math.max(1, Math.min(60, inner - 2));
									let remaining = barWidth;
									const segments = allParts
										.map((part, index) => {
											const cells =
												index === allParts.length - 1
													? remaining
													: Math.min(
															remaining,
															Math.round((part.tokens / Math.max(1, contextWindow)) * barWidth),
														);
											remaining -= cells;
											return theme.fg(part.color, "█".repeat(Math.max(0, cells)));
										})
										.join("");
									const labelWidth = Math.min(
										24,
										Math.max(...allParts.map((part) => part.label.length)),
									);
									const selectedLabel = visiblePreviews[selectedPreviewIndex]?.label;
									const partRows = allParts.map((part) => {
										const pct = contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
										const swatch = theme.fg(part.color, "■");
										const label = part.label.padEnd(labelWidth);
										const amount = `${formatTokens(part.tokens).padStart(7)}  ${pct.toFixed(1).padStart(5)}%`;
										const selected = part.label === selectedLabel;
										const hoverLabel = visiblePreviews.find((p) => p.key === hoveredKey)?.label;
										const prefix = selected ? "› " : "  ";
										const row = padLine(`${prefix}${swatch} ${label} ${amount}`, inner);
										if (selected) return theme.bg("selectedBg", row);
										return part.label === hoverLabel ? theme.bg("customMessageBg", row) : row;
									});
									const border = (text: string) => theme.fg("border", text);
									const lines = [
										border(`╭${"─".repeat(inner)}╮`),
										`${border("│")}${padLine(` ${title}  ${subtitle}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(` ${segments}`, inner)}${border("│")}`,
										`${border("│")}${" ".repeat(inner)}${border("│")}`,
										...partRows.map((row) => `${border("│")}${row}${border("│")}`),
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(theme.fg("dim", t("context.footer", " ↑↓ select · Click / Enter to preview · [esc] close")), inner)}${border("│")}`,
										border(`╰${"─".repeat(inner)}╯`),
									];

									const terminalHeight = Math.max(1, tui.terminal.rows);
									const maxHeight = Math.min(
										Math.max(1, Math.floor(terminalHeight * 0.9)),
										Math.max(1, terminalHeight - 2),
									);
									const visibleHeight = Math.min(lines.length, maxHeight);
									const overlayTop =
										1 + Math.floor((Math.max(1, terminalHeight - 2) - visibleHeight) / 2);
									const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
									escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
									previewHitboxes = visiblePreviews.flatMap((preview) => {
										const partIndex = allParts.findIndex((part) => part.label === preview.label);
										const line = 5 + partIndex;
										return partIndex >= 0 && line < visibleHeight
											? [
													{
														key: preview.key,
														row: overlayTop + line + 1,
														startCol: overlayLeft + 1,
														endCol: overlayLeft + width,
													},
												]
											: [];
									});

									return lines;
								},
							};
						},
						{
							overlay: true,
							overlayOptions: {
								anchor: "center",
								width: 64,
								minWidth: 44,
								maxHeight: "90%",
								margin: 1,
							},
						},
					);
				} finally {
					popActiveOverlay();
				}

				if (!action) break;
				const preview = previewByKey.get(action as PreviewKey);
				if (!preview) continue;

				await showTextPreview(ctx, preview.title, preview.content);
			}
		},
	});
}