/**
 * 自定义 footer：按 user.md 设计稿替换 Pi 内置 FooterComponent。
 *
 * 渲染层（segment 注册表/preset/分隔符/usage 口径）在 footer-segments.ts；
 * 本文件只做运行时装配：事件接线（实时 TPS）、心跳（共享 ticker）、生命周期。
 *
 * 设计稿（两行式，` | ` 分段）：
 * ```
 * deepseek-v4-flash · high | ██████░░░░ 45.2%/200k (auto)     ← 模型 · 思考级别 | 上下文进度条
 * pi-extensions | main | 🔌 MCP: 6 servers enabled | CH97.8% | TPS:47tok/s | $0.043
 *                                                               ← cwd 目录名 | git 分支 | MCP 服务数 | 缓存命中率 | TPS | 成本
 * ```
 *
 * 数据来源：
 * - 模型/思考：`ctx.model` / `ctx.thinkingLevel`
 * - 上下文占用：`ctx.getContextUsage()`（percent + contextWindow；>70% 黄、>90% 红，对齐官方）
 * - "进度条"：块字符 10 格进度条 + 百分比/窗口；`(auto)` 为自动压缩指示（官方 footer 默认为 true，
 *   扩展 API 不暴露该状态，固定显示）
 * - git 分支：`footerData.getGitBranch()`（扩展唯一取分支的途径），`onBranchChange` 订阅重绘
 * - token 统计：`ctx.sessionManager.getEntries()` 逐条累加 assistant / toolResult /
 *   branch_summary / compaction 的 usage（口径对齐官方 FooterComponent），CH 为最近一条
 *   assistant 消息的 cache hit rate
 * - TPS：最近一条有效 assistant 消息的 output tokens ÷ 生成耗时。耗时优先用同一条消息的
 *   message.timestamp（生成起始）→ entry.timestamp（message_end 落盘）；缺 message.timestamp
 *   时回退为相邻两条有效 assistant 消息的完成间隔。无有效数据（单消息、0 output、时间戳缺失）时隐藏该段
 * - 实时跳动：流式生成期间由扩展事件（message_start / message_update / message_end）追踪
 *   进行中的消息——output 优先取 provider 累计 usage，否则按内容字符数/4 估算；渲染器内每
 *   750ms 心跳请求一次重绘（0.5–1s 档位），流式期间 TPS 段持续刷新，消息落盘后交回 entry 口径
 * - MCP 服务数：读取社区 MCP 配置约定（`~/.pi/agent/mcp.json`、`~/.claude/mcp.json`、
 *   项目 `.mcp.json` / `mcp.json`），统计未 disabled 的服务器；无配置时整段隐藏
 *
 * 开关：`enableCustomFooter`（/tui-style → UI → Custom footer），切换即时生效。
 */
import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";
import { getSharedTicker } from "../utils/shared-ticker.ts";
import {
	countEnabledMcpServers,
	defaultMcpConfigPaths,
	estimateStreamOutputTokens,
	renderFooterLines,
	type FooterPresetId,
	type FooterSeparatorId,
	type FooterSnapshot,
	type FooterTheme,
} from "./footer-segments.ts";

// ---------------------------------------------------------------------------
// 纯函数 re-export（保持既有 import 路径兼容：tests / 外部消费者）
// ---------------------------------------------------------------------------

export {
	computeUsageTotals,
	countEnabledMcpServers,
	defaultMcpConfigPaths,
	estimateStreamOutputTokens,
	formatPercent,
	formatTps,
	formatTokens,
	renderContextBar,
	renderFooterLines,
} from "./footer-segments.ts";
export type {
	FooterPresetId,
	FooterSeparatorId,
	FooterSnapshot,
	FooterTheme,
	UsageTotals,
} from "./footer-segments.ts";

// ---------------------------------------------------------------------------
// 运行时装配层
// ---------------------------------------------------------------------------

/** MCP 服务数发现缓存：配置极少变动，5 秒 TTL 内复用，避免每帧读盘。 */
const MCP_DISCOVER_TTL_MS = 5_000;
let mcpCache = { at: 0, cwd: "", count: 0 };

function discoverMcpCount(cwd: string, home: string): number {
	const now = Date.now();
	if (mcpCache.cwd === cwd && now - mcpCache.at < MCP_DISCOVER_TTL_MS) {
		return mcpCache.count;
	}
	const count = countEnabledMcpServers(defaultMcpConfigPaths(cwd, home));
	mcpCache = { at: now, cwd, count };
	return count;
}

type FooterContext = {
	hasUI?: boolean;
	ui?: { setFooter?(renderer: unknown): void };
	cwd?: string;
	sessionManager?: {
		getEntries?(): readonly unknown[];
	};
	model?: FooterSnapshot["model"];
	thinkingLevel?: string;
	getContextUsage?(): FooterSnapshot["contextUsage"];
};

type FooterDataLike = {
	getGitBranch?(): string | null;
	getExtensionStatuses?(): ReadonlyMap<string, string>;
	onBranchChange?(callback: () => void): () => void;
};

// ---------------------------------------------------------------------------
// 实时 TPS：流式生成期间由扩展事件追踪进行中的消息，心跳驱动重绘。
// ---------------------------------------------------------------------------

/** 实时 TPS 心跳刷新间隔（0.5–1s 档位，取 750ms）。测试可改小以验证节奏。 */
export const liveTpsRefreshSettings = { intervalMs: 750 };

/** 进行中消息的实时状态：累计 output 与生成起始时刻（ms）。 */
type LiveStreamStats = { output: number; startedAt: number };

type StreamMessageLike = {
	role?: string;
	timestamp?: number;
	content?: unknown;
	usage?: { output?: number } | null;
};

/**
 * 会话级实时流注册表。key 取 ctx.sessionManager：同一会话内该对象稳定，而扩展事件
 * 每次 emit 的 ctx 都是新建对象，不能直接用 ctx 作 key。
 */
const liveStreams = new WeakMap<object, LiveStreamStats>();

function liveKey(ctx: FooterContext): object | undefined {
	return (ctx?.sessionManager as object | undefined) ?? undefined;
}

/** 读取当前会话的实时流快照；无活动流时为 undefined。 */
function liveSnap(ctx: FooterContext): FooterSnapshot["live"] {
	const key = liveKey(ctx);
	const stats = key ? liveStreams.get(key) : undefined;
	if (!stats) return undefined;
	return { output: stats.output, elapsedMs: Math.max(0, Date.now() - stats.startedAt) };
}

type FooterRenderer = (tui: any, theme: Theme, footerData: FooterDataLike) => {
	render(width: number): string[];
	invalidate(): void;
	dispose?: (() => void) | undefined;
};

function snapshot(ctx: FooterContext, footerData: FooterDataLike | undefined): FooterSnapshot {
	const cwd = ctx.cwd ?? "";
	return {
		cwd,
		gitBranch: footerData?.getGitBranch?.() ?? null,
		entries: ctx.sessionManager?.getEntries?.() ?? [],
		contextUsage: ctx.getContextUsage?.(),
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		mcpEnabledCount: discoverMcpCount(cwd, homedir()),
		extensionStatuses: footerData?.getExtensionStatuses?.(),
		live: liveSnap(ctx),
	};
}

/** 读取 footer 布局选项：preset + 分隔符（config 已校验非法值，这里再兜底一次）。 */
function footerLayoutOptions(): { preset: FooterPresetId; separator: FooterSeparatorId } {
	const preset = (config.footerPreset === "minimal" ? "minimal" : "default") as FooterPresetId;
	const separatorId = ["pipe", "slash", "dot", "none"].includes(config.footerSeparator)
		? (config.footerSeparator as FooterSeparatorId)
		: "pipe";
	return { preset, separator: separatorId };
}

/** 按配置应用 footer：on → 自定义渲染器；off → 恢复官方默认 footer。 */
export function applyFooter(ctx: FooterContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setFooter !== "function") return;
	if (!config.enableCustomFooter) {
		ctx.ui.setFooter(undefined);
		return;
	}
	const renderer: FooterRenderer = (tui, theme, footerData) => {
		// git 分支切换（检出/切分支）时重绘 footer。
		const unsubscribe = footerData?.onBranchChange?.(() => tui?.requestRender?.());
		// 实时 TPS 心跳：流式生成期间每 750ms 请求一次重绘（0.5–1s 档位），
		// 让 TPS 在无 token 波动的间隙（如纯思考期）也持续跳动。
		// 并入共享 ticker 注册表：空闲时注销、流式时重新 watch，多个 footer 实例
		// 同频共享单个底层 timer（omp issue #8731 模式）。
		const heartbeatTicker = getSharedTicker(liveTpsRefreshSettings.intervalMs);
		let heartbeat: (() => void) | null = heartbeatTicker.watch(() => {
			const key = liveKey(ctx);
			if (key && liveStreams.has(key)) tui?.requestRender?.();
		});
		const layout = footerLayoutOptions();
		return {
			render(width: number): string[] {
				return renderFooterLines(snapshot(ctx, footerData), theme, width, {
					preset: layout.preset,
					separator: layout.separator,
				});
			},
			invalidate() {},
			dispose() {
				heartbeat?.();
				heartbeat = null;
				unsubscribe?.();
			},
		};
	};
	ctx.ui.setFooter(renderer);
}

/** 会话级生命周期：session_start 挂载自定义 footer，shutdown 恢复官方默认。 */
export function installCustomFooter(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		applyFooter(ctx as FooterContext);
	});

	// 实时 TPS 追踪：assistant 消息开始/更新/结束。
	pi.on("message_start", async (event, ctx) => {
		const msg = (event as unknown as { message?: StreamMessageLike | null }).message;
		if (msg?.role !== "assistant") return;
		const key = liveKey(ctx as FooterContext);
		if (!key) return;
		liveStreams.set(key, {
			output: 0,
			startedAt: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
		});
	});
	pi.on("message_update", async (event, ctx) => {
		const msg = (event as unknown as { message?: StreamMessageLike | null }).message;
		if (msg?.role !== "assistant") return;
		const key = liveKey(ctx as FooterContext);
		const stats = key ? liveStreams.get(key) : undefined;
		if (!stats) return;
		stats.output = Math.max(stats.output, estimateStreamOutputTokens(msg));
	});
	pi.on("message_end", async (event, ctx) => {
		const msg = (event as unknown as { message?: StreamMessageLike | null }).message;
		if (msg?.role !== "assistant") return;
		const key = liveKey(ctx as FooterContext);
		if (key) liveStreams.delete(key);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const footerCtx = ctx as FooterContext;
		const key = liveKey(footerCtx);
		if (key) liveStreams.delete(key);
		if (!footerCtx?.hasUI || typeof footerCtx.ui?.setFooter !== "function") return;
		footerCtx.ui.setFooter(undefined);
	});
}