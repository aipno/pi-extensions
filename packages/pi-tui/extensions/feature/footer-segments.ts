/**
 * footer 纯函数层：segment 注册表 + preset + 分隔符主题（omp status-line 架构的移植）。
 *
 * 设计（对齐 omp status-line segments.ts / presets.ts / separators.ts）：
 *  - 每段独立 `{id, line, render(snapshot, theme) → string | null}`，返回 null/空 时整段消失；
 *  - 内置段注册进 FOOTER_SEGMENTS，扩展可用 registerFooterSegment 注入新段（/reload 清理）；
 *  - preset 从注册表挑段排序（default=全量当前布局，minimal=精简），运行时由 config.footerPreset 选择；
 *  - 分隔符可换肤（pipe/slash/dot/none），由 config.footerSeparator 选择，默认 pipe 兼容旧设计稿。
 *
 * TPS 口径（2026-08-29 决议，合并 pi-stamp #5 与 pi-usage #5 的相反结论）：
 * 三档互补优先级 —— ① provider 报的可信 message.duration；② 同消息
 * message.timestamp → entry.timestamp 落盘差值；③ 相邻两条有效消息的完成间隔。
 * 流式生成期间 snapshot.live 的实时值优先于以上全部（渲染层合并）。
 *
 * 本文件不依赖运行时上下文（无 ctx/session），全部可单测；footer.ts 只做事件接线。
 */
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { t } from "../utils/i18n.ts";

// ---------------------------------------------------------------------------
// 格式化纯函数
// ---------------------------------------------------------------------------

/** 1k / 12k / 2.5k / 1.2M 风格的 token 缩写，与官方 footer 的 formatTokens 一致。 */
export function formatTokens(value: number): string {
	const n = Math.max(0, Math.floor(value));
	if (n < 1_000) return `${n}`;
	if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** 百分比文本：0 → "0"、45.2 → "45.2"（去掉整数尾巴的 .0，对齐设计稿 "0%"）。 */
export function formatPercent(value: number): string {
	const text = value.toFixed(1);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** TPS 文本：`47tok/s`（四舍五入整数；≥1k 时用 `1.2k tok/s` 保持短促）。 */
export function formatTps(value: number): string {
	const n = Math.max(0, Math.round(value));
	if (n >= 1_000) {
		const k = n >= 10_000 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000).toFixed(1)}k`;
		return `${k} tok/s`;
	}
	return `${n}tok/s`;
}

/**
 * 估算一条 streaming 消息当前的 output token 数：
 * provider 累计 usage 优先（Anthropic 等按 chunk 上报），否则按内容字符数/4 估算（对齐官方
 * estimateTokens）。内容统计 text / thinking / toolCall 各块的字符。
 */
export function estimateStreamOutputTokens(message: {
	content?: unknown;
	usage?: { output?: number } | null;
}): number {
	const usageOutput = message.usage?.output ?? 0;
	if (usageOutput > 0) return usageOutput;
	let chars = 0;
	const content = message.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const b = block as {
				type?: string;
				text?: unknown;
				thinking?: unknown;
				arguments?: unknown;
			} | null;
			if (!b) continue;
			if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
			else if (b.type === "thinking" && typeof b.thinking === "string") {
				chars += b.thinking.length;
			} else if (b.type === "toolCall") {
				try {
					chars += JSON.stringify(b.arguments ?? {}).length;
				} catch {
					// 循环引用等异常参数：该项按 0 计。
				}
			}
		}
	}
	return Math.ceil(chars / 4);
}

/** 块字符进度条（10 格）：`██████░░░░`。pct 未知时全空。 */
export function renderContextBar(percent: number | null | undefined, cells = 10): string {
	const filled =
		percent === null || percent === undefined
			? 0
			: Math.max(0, Math.min(cells, Math.round(percent / (100 / cells))));
	return "█".repeat(filled) + "░".repeat(cells - filled);
}

/** 统计各 mcp 配置文件中未 disabled 的服务器数量（解析失败的文件按 0 计）。 */
export function countEnabledMcpServers(paths: readonly string[]): number {
	let count = 0;
	for (const file of paths) {
		if (!file || !existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as {
				mcpServers?: Record<string, { disabled?: boolean } | undefined>;
			};
			const servers = parsed.mcpServers ?? {};
			for (const [name, definition] of Object.entries(servers)) {
				if (name && definition?.disabled !== true) count += 1;
			}
		} catch {
			// 配置损坏/非 JSON：跳过该文件。
		}
	}
	return count;
}

/** 默认 MCP 配置候选路径：社区约定（~/.pi/agent、~/.claude、项目 .mcp.json / mcp.json）。 */
export function defaultMcpConfigPaths(cwd: string, home = homedir()): string[] {
	return [
		join(home, ".pi", "agent", "mcp.json"),
		join(home, ".claude", "mcp.json"),
		join(cwd, ".mcp.json"),
		join(cwd, "mcp.json"),
	];
}

export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** 最近一条 assistant 消息的 cache hit rate（%），无数据为 undefined。 */
	cacheHitRate: number | undefined;
	/** 最近一条有效 assistant 消息的生成速度（output tok/s），无有效数据为 undefined。 */
	tps: number | undefined;
};

/**
 * 累加所有会话 entry 的 usage，口径与官方 FooterComponent 一致：
 * assistant 消息 + toolResult 带 usage 的消息 + branch_summary/compaction entry。
 * cacheHitRate 取最近一条 assistant 消息：`cacheRead / (input+cacheRead+cacheWrite)`。
 * tps 时长口径三档优先级（见文件头）：message.duration → 同消息起止 → 相邻完成间隔。
 */
export function computeUsageTotals(entries: readonly unknown[]): UsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let cacheHitRate: number | undefined;
	// TPS 追踪：最近/上一条有效 assistant 消息的耗时来源（ms）+ 最近 output。
	let lastOutput = 0;
	/** provider 直接报的生成耗时（message.duration，ms）。 */
	let lastDuration = Number.NaN;
	let lastStart = Number.NaN;
	let lastEnd = Number.NaN;
	let prevEnd = Number.NaN;

	const add = (usage: any) => {
		if (!usage) return;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cacheRead += usage.cacheRead ?? 0;
		cacheWrite += usage.cacheWrite ?? 0;
		cost += usage.cost?.total ?? 0;
	};

	for (const raw of entries) {
		const entry = raw as {
			type?: string;
			message?: any;
			usage?: any;
			timestamp?: unknown;
		} | null | undefined;
		if (!entry) continue;
		if (entry.type === "message") {
			const message = entry.message as {
				role?: string;
				usage?: any;
				stopReason?: string;
				timestamp?: unknown;
				duration?: unknown;
			} | null;
			if (!message) continue;
			if (message.role === "assistant" && message.usage) {
				add(message.usage);
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const latestPromptTokens =
						(message.usage.input ?? 0) +
						(message.usage.cacheRead ?? 0) +
						(message.usage.cacheWrite ?? 0);
					cacheHitRate =
						latestPromptTokens > 0
							? ((message.usage.cacheRead ?? 0) / latestPromptTokens) * 100
							: undefined;
					// 记录最近两条有效消息的完成时刻；entry.timestamp 为 message_end 落盘时刻。
					const entryMs =
						typeof entry.timestamp === "string"
							? Date.parse(entry.timestamp)
							: Number.NaN;
					if (Number.isFinite(entryMs)) {
						prevEnd = lastEnd;
						lastEnd = entryMs;
						// ① provider 报的可信 duration（ms，正数）。
						lastDuration =
							typeof message.duration === "number" && message.duration > 0
								? message.duration
								: Number.NaN;
						// ② 同消息起止：message.timestamp 为生成起始时刻。
						lastStart =
							typeof message.timestamp === "number" && entryMs > message.timestamp
								? message.timestamp
								: Number.NaN;
						lastOutput = message.usage.output ?? 0;
					}
				}
			} else if (message.role === "toolResult" && message.usage) {
				add(message.usage);
			}
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			add(entry.usage);
		}
	}

	// TPS：output ÷ 耗时。① duration → ② 同消息起止 → ③ 相邻完成间隔。
	let tps: number | undefined;
	if (lastOutput > 0) {
		let durationMs = Number.NaN;
		if (Number.isFinite(lastDuration)) {
			durationMs = lastDuration;
		} else if (Number.isFinite(lastStart) && Number.isFinite(lastEnd) && lastEnd > lastStart) {
			durationMs = lastEnd - lastStart;
		} else if (Number.isFinite(prevEnd) && Number.isFinite(lastEnd) && lastEnd > prevEnd) {
			durationMs = lastEnd - prevEnd;
		}
		if (Number.isFinite(durationMs) && durationMs > 0) {
			tps = lastOutput / (durationMs / 1000);
		}
	}

	return { input, output, cacheRead, cacheWrite, cost, cacheHitRate, tps };
}

// ---------------------------------------------------------------------------
// snapshot 类型（渲染所需的最小快照；全部为纯数据，便于单测）
// ---------------------------------------------------------------------------

export type FooterSnapshot = {
	cwd: string;
	gitBranch: string | null;
	entries: readonly unknown[];
	contextUsage?:
		| {
				percent: number | null;
				contextWindow?: number;
		  }
		| null
		| undefined;
	model?:
		| {
				id?: string;
				reasoning?: boolean;
				contextWindow?: number;
		  }
		| null
		| undefined;
	thinkingLevel?: string;
	/** 已启用（未 disabled）的 MCP 服务器数；0 时隐藏 MCP 段。 */
	mcpEnabledCount?: number;
	extensionStatuses?: ReadonlyMap<string, string>;
	/** 流式生成期间为进行中消息的实时状态（累计 output + 已生成时长 ms）；无流时为 undefined。 */
	live?: { output: number; elapsedMs: number } | null;
};

export type FooterTheme = Pick<Theme, "fg">;

// ---------------------------------------------------------------------------
// segment 注册表 + preset + 分隔符
// ---------------------------------------------------------------------------

/** 段渲染上下文：snapshot + theme。返回 null/空串 表示该段本轮不可见。 */
export type FooterSegmentRender = (snapshot: FooterSnapshot, theme: FooterTheme) => string | null;

export interface FooterSegment {
	/** 稳定 id；preset 用它挑段，扩展注入的段用自定义 id。 */
	id: string;
	/** 1 = 模型/上下文行；2 = 状态行（cwd/分支/…）。 */
	line: 1 | 2;
	render: FooterSegmentRender;
}

const dim = (theme: FooterTheme, text: string) => theme.fg("dim", text);

/**
 * usage 汇总按帧缓存：ch/tps/cost 三个段共享同一次 entries 扫描
 * （entries 数组引用未变时直接复用；snapshot 每帧重建但 entries 引用稳定）。
 */
let usageCache: { entries: readonly unknown[]; totals: UsageTotals } | undefined;
function usageTotalsCached(entries: readonly unknown[]): UsageTotals {
	if (usageCache && usageCache.entries === entries) return usageCache.totals;
	const totals = computeUsageTotals(entries);
	usageCache = { entries, totals };
	return totals;
}

/** 内置段（default preset 的顺序即注册顺序）。 */
export const FOOTER_SEGMENTS: FooterSegment[] = [
	{
		id: "model",
		line: 1,
		render(snapshot, theme) {
			const modelId = snapshot.model?.id ?? t("footer.noModel", "no model");
			let segment = modelId;
			if (snapshot.model?.reasoning) {
				const level =
					snapshot.thinkingLevel && snapshot.thinkingLevel !== "off"
						? snapshot.thinkingLevel
						: t("footer.thinkingOff", "off");
				segment = `${modelId} · ${level}`;
			}
			return dim(theme, segment);
		},
	},
	{
		id: "context",
		line: 1,
		render(snapshot, theme) {
			const contextUsage = snapshot.contextUsage;
			const contextWindow = contextUsage?.contextWindow ?? snapshot.model?.contextWindow ?? 0;
			const percent = contextUsage?.percent ?? null;
			const percentText = percent === null ? "" : formatPercent(percent);
			const bar = renderContextBar(percent);
			const windowText = formatTokens(contextWindow);
			// >90% 红、>70% 黄（对齐官方 footer 的阈值配色）；bar 与百分比一起变色，其余 dim。
			const contextColor =
				percent !== null && percent > 90
					? "error"
					: percent !== null && percent > 70
						? "warning"
						: null;
			const paint = (text: string) =>
				contextColor ? theme.fg(contextColor, text) : dim(theme, text);
			return `${paint(bar)} ${
				percent === null
					? dim(theme, `?/${windowText} (auto)`)
					: `${paint(percentText)}${dim(theme, `%/${windowText} (auto)`)}`
			}`;
		},
	},
	{
		id: "cwd",
		line: 2,
		render(snapshot, theme) {
			return dim(theme, basename(snapshot.cwd) || "/");
		},
	},
	{
		id: "git",
		line: 2,
		render(snapshot, theme) {
			return snapshot.gitBranch ? dim(theme, snapshot.gitBranch) : null;
		},
	},
	{
		id: "mcp",
		line: 2,
		render(snapshot, theme) {
			const count = snapshot.mcpEnabledCount ?? 0;
			if (count <= 0) return null;
			return dim(
				theme,
				count === 1
					? t("footer.mcp.one", "🔌 MCP: 1 server enabled")
					: t("footer.mcp.many", "🔌 MCP: {count} servers enabled", { count }),
			);
		},
	},
	{
		id: "ch",
		line: 2,
		render(snapshot, theme) {
			const totals = usageTotalsCached(snapshot.entries);
			if ((totals.cacheRead <= 0 && totals.cacheWrite <= 0) || totals.cacheHitRate === undefined)
				return null;
			return dim(theme, `CH${totals.cacheHitRate.toFixed(1)}%`);
		},
	},
	{
		id: "tps",
		line: 2,
		render(snapshot, theme) {
			const totals = usageTotalsCached(snapshot.entries);
			// 流式生成期间用实时值（output ÷ 已生成时长），否则用已落盘消息的均值。
			const live = snapshot.live;
			const liveTps =
				live && live.elapsedMs > 0 ? live.output / (live.elapsedMs / 1000) : undefined;
			const tps = liveTps !== undefined ? liveTps : totals.tps;
			return tps !== undefined ? dim(theme, `TPS:${formatTps(tps)}`) : null;
		},
	},
	{
		id: "cost",
		line: 2,
		render(snapshot, theme) {
			const totals = usageTotalsCached(snapshot.entries);
			return totals.cost ? dim(theme, `$${totals.cost.toFixed(3)}`) : null;
		},
	},
];

/** preset：按 id 挑段的行布局。line1 未列出的段不渲染；line2 同理。 */
export type FooterPresetId = "default" | "minimal";

export const FOOTER_PRESETS: Record<FooterPresetId, { line1: string[]; line2: string[] }> = {
	default: { line1: ["model", "context"], line2: ["cwd", "git", "mcp", "ch", "tps", "cost"] },
	minimal: { line1: ["model", "context"], line2: ["cwd", "cost"] },
};

export const FOOTER_PRESET_IDS: FooterPresetId[] = ["default", "minimal"];

/** 扩展注入的段（追加到对应行尾）。registerFooterSegment 返回注销函数。 */
const extraSegments: FooterSegment[] = [];

export function registerFooterSegment(segment: FooterSegment): () => void {
	const index = extraSegments.indexOf(segment);
	if (index >= 0) return () => {};
	extraSegments.push(segment);
	return () => {
		const at = extraSegments.indexOf(segment);
		if (at >= 0) extraSegments.splice(at, 1);
	};
}

/** 测试与 /reload 清理：清空扩展注入段。 */
export function resetFooterSegments(): void {
	extraSegments.length = 0;
}

/**
 * 按 preset 解析某行的段列表：default 用注册顺序全量；非 default preset 按
 * preset 列出的 id 过滤；未列入任何 preset 的内置段（向前兼容的新段）全量显示。
 * 扩展注入段不受 preset 裁剪——显式注册即显式展示。
 */
function segmentsForLine(line: 1 | 2, preset: FooterPresetId): FooterSegment[] {
	const inAnyPreset = new Set<string>();
	for (const p of Object.values(FOOTER_PRESETS)) {
		for (const id of line === 1 ? p.line1 : p.line2) inAnyPreset.add(id);
	}
	const presetIds = new Set(FOOTER_PRESETS[preset]?.[line === 1 ? "line1" : "line2"] ?? []);
	const builtin = FOOTER_SEGMENTS.filter(
		(segment) =>
			segment.line === line &&
			(preset === "default" || inAnyPreset.has(segment.id) === false || presetIds.has(segment.id)),
	);
	return line === 1
		? builtin
		: [...builtin, ...extraSegments.filter((segment) => segment.line === 2)];
}

// —— 分隔符主题（omp separators.ts 的轻量版） ——

export type FooterSeparatorId = "pipe" | "slash" | "dot" | "none";

export const FOOTER_SEPARATOR_IDS: FooterSeparatorId[] = ["pipe", "slash", "dot", "none"];

const FOOTER_SEPARATORS: Record<FooterSeparatorId, string> = {
	pipe: " | ",
	slash: " / ",
	dot: " · ",
	none: "  ",
};

export function resolveFooterSeparator(id: FooterSeparatorId | undefined): string {
	return (id !== undefined ? FOOTER_SEPARATORS[id] : undefined) ?? FOOTER_SEPARATORS.pipe!;
}

/**
 * 按 preset + 分隔符生成 footer 行：
 * - line 1：`{model} · {thinking}{sep}{bar} {pct}%/{window} (auto)`
 * - line 2：preset 挑出的段按注册顺序 `sep` 连接（不可见段整段消失）
 * - line 3：其它扩展 setStatus 的文本（仅存在时）
 * 所有行截断到 width。
 */
export function renderFooterLines(
	snapshot: FooterSnapshot,
	theme: FooterTheme,
	width: number,
	options: { preset?: FooterPresetId; separator?: FooterSeparatorId } = {},
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const preset = options.preset ?? "default";
	const separator = FOOTER_SEPARATORS[options.separator ?? "pipe"] ?? FOOTER_SEPARATORS.pipe!;

	const joinLine = (segments: FooterSegment[]): string => {
		const parts: string[] = [];
		for (const segment of segments) {
			let rendered: string | null;
			try {
				rendered = segment.render(snapshot, theme);
			} catch {
				rendered = null; // 段渲染抛错按不可见处理，不拖垮整条状态栏。
			}
			if (rendered) parts.push(rendered);
		}
		return parts.join(theme.fg("dim", separator));
	};

	const line1 = joinLine(segmentsForLine(1, preset));
	const line2 = joinLine(segmentsForLine(2, preset));

	const lines: string[] = [
		truncateToWidth(line1, safeWidth, theme.fg("dim", "…")),
		truncateToWidth(line2, safeWidth, theme.fg("dim", "…")),
	];

	// ── line 3：其它扩展的 status（setStatus），按 key 排序 ──
	const statuses = snapshot.extensionStatuses;
	if (statuses && statuses.size > 0) {
		const statusLine = [...statuses.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => text.replace(/\s+/g, " ").trim())
			.filter(Boolean)
			.join(" ");
		if (statusLine) {
			lines.push(truncateToWidth(statusLine, safeWidth, theme.fg("dim", "…")));
		}
	}

	return lines;
}

