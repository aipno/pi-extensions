/**
 * P2(§1) 流式平滑渲染：助手消息文本逐 grapheme 渐进揭示（StreamingRevealController 模式）。
 *
 * 机制（§1 定案伪码的落地）：
 * - 纯扩展补丁：拦截 AssistantMessageComponent.prototype.updateContent，
 *   时间闸 delta 驱动（33ms）+ 断流临时 ticker（250ms 检测）双路径推进；
 * - 拦截范围仅 `content[i].type === "text"`；thinking/toolCall 不占游标、原样透传；
 * - 揭示完成或 isStreaming=false（message_end）时冲刷全量并"交还"（handedBack）——
 *   后续同消息直通，不再管线化；
 * - 与 compact-thinking 链式共存：patch 挂 [PROTOTYPE_ORIGINAL_KEY]（捕获自己的原型），
 *   卸载时若原型上仍是自己的 patch 则还原到该标记指向的原型（§0.1 定案，装序无关）；
 * - 调用链会把组件 lastMessage 覆盖为截断消息，调用后复原为全量（宿主 toolCall
 *   追踪与 invalidate 依赖永远最新的消息）。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getSharedTicker } from "../utils/shared-ticker.ts";
import { patchRegistry, PROTOTYPE_ORIGINAL_KEY } from "../utils/patch-keys.ts";
import {
	BlockUnitCounter,
	revealSteps,
	shouldReveal,
	textSegments,
	truncateMessageToCursor,
} from "../utils/reveal-cursor.ts";
import { isAnimationAllowed } from "../utils/terminal-capabilities.ts";
import { config } from "../config/config.ts";

/** 时间闸：33ms ≈ 30fps（与宿主 16ms 帧合并叠加后视觉平滑）。 */
export const REVEAL_GATE_MS = 33;
/** 断流阈值：delta 停产后 250ms 未见新内容即起 ticker 追赶。 */
export const STALL_CHECK_MS = 250;
/** 独立 widget id（避开 compact-thinking 的 "compact-thinking-render-loop"）。 */
export const WIDGET_ID = "streaming-reveal-render-loop";

export const STREAMING_REVEAL_PATCH_KEY = Symbol.for("pi.tui.streaming-reveal-update");
export const STREAMING_REVEAL_OWNER = Symbol.for("pi.tui.streaming-reveal-owner");

type RenderTui = { requestRender(force?: boolean): void };

type PatchedPrototype = typeof AssistantMessageComponent.prototype & {
	updateContent: (message: AssistantMessage, isStreaming?: boolean) => void;
};

type AssistantInternals = {
	lastMessage?: AssistantMessage;
	isStreaming: boolean;
};

type RevealState = {
	/** 全消息 text 块拼接（跨块连续游标的增量源）。 */
	prevFull: string;
	/** grapheme 增量计数（只重扫 tail，累计文本不全量重扫）。 */
	counter: BlockUnitCounter;
	/** 已揭示的 grapheme 数（全消息统一游标）。 */
	cursor: number;
	/** 上次推进时刻（performance.now()，初始化于首帧推进）。 */
	lastRevealAt: number;
	/** 断流检测定时器（每个 delta 重置）。 */
	stallCheck: ReturnType<typeof setTimeout> | undefined;
	/** 断流追赶 ticker 是否活动。 */
	tickerActive: boolean;
	/** ticker 推进用的最新消息与组件（断流期间增量已停滞）。 */
	message: AssistantMessage;
	self: AssistantInternals;
};

type RevealOwner = {
	owner: object;
	stop(event?: any, ctx?: any): void;
};

type UpstreamHandler = (event: any, ctx: any) => void;

// 进程级状态（同一时刻宿主至多一个流式 assistant 消息；跨安装实例共享，
// /reload 由新实例 activate 时先 stop 旧实例再重建）。
const states = new Map<number, RevealState>();
const handedBack = new Set<number>();
let activeTui: RenderTui | undefined;
let tickerUnwatch: (() => void) | undefined;

function stopTicker(): void {
	if (!tickerUnwatch) return;
	tickerUnwatch();
	tickerUnwatch = undefined;
}

/** 新 delta 到达时全局停表：同一时刻只有一个流式消息，防御性清理其它态的 ticker。 */
function stopAllTickers(): void {
	stopTicker();
	for (const state of states.values()) state.tickerActive = false;
}

function clearState(timestamp: number): void {
	const state = states.get(timestamp);
	if (!state) return;
	if (state.stallCheck) clearTimeout(state.stallCheck);
	stopTicker();
	states.delete(timestamp);
}

/**
 * 推进一帧：游标前进 revealSteps(backlog) 个 grapheme，构造截断消息交给链下。
 * 返回是否已覆盖全文（调用方决定是否冲刷清理）。
 */
function advance(state: RevealState, original: Function): boolean {
	const backlog = state.counter.count - state.cursor;
	if (backlog <= 0) {
		return true;
	}
	const steps = revealSteps(backlog);
	state.cursor = Math.min(state.counter.count, state.cursor + steps);
	state.lastRevealAt = performance.now();
	const message = state.message;
	const truncated = truncateMessageToCursor(message, state.cursor);
	try {
		original.call(state.self, truncated, true);
	} finally {
		// 链下（native/compact-thinking）会把 lastMessage 覆盖为截断消息，复原为全量。
		state.self.lastMessage = message;
	}
	return state.cursor >= state.counter.count;
}

function finalize(state: RevealState): void {
	stopTicker();
	handedBack.add(state.message.timestamp);
	clearState(state.message.timestamp);
}

function startStallTicker(state: RevealState, original: Function): void {
	if (state.tickerActive) return;
	state.tickerActive = true;
	tickerUnwatch = getSharedTicker(REVEAL_GATE_MS).watch(() => {
		if (!state.tickerActive) return;
		if (advance(state, original)) {
			finalize(state);
		}
		activeTui?.requestRender();
	});
}

/** 新 delta 到达的主路径：增量入库 → 闸判定 → 立即推进或挂断流检查。 */
function onTextDelta(state: RevealState, message: AssistantMessage, original: Function): void {
	if (state.stallCheck) {
		clearTimeout(state.stallCheck);
		state.stallCheck = undefined;
	}
	// 断流 ticker 活动 → 停表（交还 delta 驱动主路径）。
	if (state.tickerActive) {
		stopTicker();
		state.tickerActive = false;
	}

	const full = textSegments(message).join("");
	if (state.prevFull === "") {
		// 全新消息：全文作为首批增量。
		state.counter.push(full);
	} else if (full.startsWith(state.prevFull)) {
		state.counter.push(full.slice(state.prevFull.length));
	} else {
		// 文本缩短/替换（罕见）：整体重计，游标钳制。
		state.counter.reset();
		state.counter.push(full);
		state.cursor = Math.min(state.cursor, state.counter.count);
	}
	state.prevFull = full;
	state.message = message;

	if (shouldReveal(state.lastRevealAt, performance.now(), REVEAL_GATE_MS)) {
		// 时间闸到点：宿主重绘帧顺带显示。
		if (advance(state, original)) finalize(state);
		return;
	}

	// 闸内合并：backlog 非空且无挂起的断流检查 → 250ms 后若仍无新 delta 则起 ticker。
	if (state.counter.count - state.cursor > 0 && !state.stallCheck) {
		state.stallCheck = setTimeout(() => {
			state.stallCheck = undefined;
			if (
				states.get(state.message.timestamp) === state &&
				state.counter.count - state.cursor > 0 &&
				!state.tickerActive
			) {
				startStallTicker(state, original);
			}
		}, STALL_CHECK_MS);
	}
}

function streamingReveal(pi: ExtensionAPI) {
	const prototype = AssistantMessageComponent.prototype as PatchedPrototype;
	const originalUpdateContent = prototype.updateContent;

	prototype.updateContent = function patchedUpdateContent(
		message: AssistantMessage,
		isStreaming?: boolean,
	) {
		const self = this as unknown as AssistantInternals;
		// 透传条件（§1 定案）：配置关闭 / 动画禁用 / 该消息已交还 / 非流式驱动。
		// isStreaming 缺省（invalidate 等重渲染）视为非流式驱动，原样透传。
		const pipelined =
			config.streamingReveal === "on" &&
			isAnimationAllowed() &&
			isStreaming === true &&
			!handedBack.has(message.timestamp);
		if (!pipelined) {
			originalUpdateContent.call(this, message, isStreaming);
			if (isStreaming === false) {
				// message_end：原样冲刷全量 + 清除揭示态 + 标记已交还（§0.1 消息身份）。
				// 此后的同消息 updateContent 直通，不再管线化。
				clearState(message.timestamp);
				handedBack.add(message.timestamp);
			}
			return;
		}

		let state = states.get(message.timestamp);
		stopAllTickers();
		if (!state) {
			// 无 text 内容可揭示 → 原样透传，不建立揭示态。
			if (textSegments(message).every((segment) => segment.length === 0)) {
				originalUpdateContent.call(this, message, isStreaming);
				return;
			}
			state = {
				prevFull: "",
				counter: new BlockUnitCounter(),
				cursor: 0,
				// 首个 delta 即时推进一次（§0.1）：lastRevealAt=-∞ 使闸立即通过。
				lastRevealAt: -Infinity,
				stallCheck: undefined,
				tickerActive: false,
				message,
				self,
			};
			states.set(message.timestamp, state);
		} else {
			state.self = self;
		}
		onTextDelta(state, message, originalUpdateContent);
	};

	const installedUpdateContent = prototype.updateContent;
	(installedUpdateContent as any)[STREAMING_REVEAL_PATCH_KEY] = true;
	// §0.1 定案：patch 挂自己的捕获原型，卸载时还原到它（与 compact-thinking 链式兼容）。
	(installedUpdateContent as any)[PROTOTYPE_ORIGINAL_KEY] = originalUpdateContent;

	let patchInstalled = true;

	function uninstall(): void {
		if (!patchInstalled) return;
		patchInstalled = false;
		stopTicker();
		states.clear();
		handedBack.clear();
		if (prototype.updateContent === installedUpdateContent) {
			const wrappedOriginal = (installedUpdateContent as any)[PROTOTYPE_ORIGINAL_KEY];
			prototype.updateContent =
				typeof wrappedOriginal === "function" ? wrappedOriginal : originalUpdateContent;
		}
	}

	pi.on("session_start", (event, ctx) => {
		const ui = (ctx as { ui?: any })?.ui;
		if (ctx?.mode !== "tui") return;
		activeTui = ui;
		// 空 widget 给断流 ticker 的 requestRender 通道（与 compact-thinking 同款）。
		ui.setWidget(WIDGET_ID, (tui: any) => {
			activeTui = tui;
			return { render: () => [], invalidate() {} };
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		uninstall();
		if (ctx?.mode === "tui") ctx.ui?.setWidget?.(WIDGET_ID, undefined);
		activeTui = undefined;
	});
}

export function installStreamingReveal(pi: ExtensionAPI): { stop(): void } {
	const owner = {};
	let session: { event: any; ctx: any } | undefined;
	let active = false;
	const delegates = new Map<string, UpstreamHandler>();
	const boundEvents = new Set<string>();

	const bind = (eventName: string) => {
		if (boundEvents.has(eventName)) return;
		boundEvents.add(eventName);
		pi.on(eventName as any, (e: any, ctx: any) => {
			if (!active) return;
			const handler = delegates.get(eventName);
			if (!handler) return;
			handler(e, ctx);
		});
	};

	const stop = (event?: any, ctx?: any) => {
		if (!active) return;
		active = false;
		const shutdown = delegates.get("session_shutdown");
		delegates.clear();
		shutdown?.(event ?? session?.event ?? {}, ctx ?? session?.ctx ?? { mode: "rpc", ui: {} });
		if (patchRegistry.get<RevealOwner>(STREAMING_REVEAL_OWNER)?.owner === owner) {
			patchRegistry.delete(STREAMING_REVEAL_OWNER);
		}
	};

	const activate = (event: any, ctx: any) => {
		if (ctx?.mode !== "tui") return;
		patchRegistry.get<RevealOwner>(STREAMING_REVEAL_OWNER)?.stop(event, ctx);
		session = { event, ctx };

		delegates.clear();
		streamingReveal({
			on(eventName: string, handler: UpstreamHandler) {
				if (eventName === "session_start") {
					// 已在 session_start 内 —— 立即执行。
					handler(event, ctx);
					return;
				}
				if (eventName === "session_shutdown") {
					delegates.set(eventName, handler);
					return;
				}
				delegates.set(eventName, handler);
				bind(eventName);
			},
			appendEntry: (...args: any[]) => (pi.appendEntry as (...a: any[]) => void)?.(...args),
		} as unknown as ExtensionAPI);

		active = true;
		patchRegistry.install(STREAMING_REVEAL_OWNER, { owner, stop });
	};

	pi.on("session_start", (event, ctx) => {
		session = { event, ctx };
		activate(event, ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (patchRegistry.get<RevealOwner>(STREAMING_REVEAL_OWNER)?.owner === owner) {
			stop(event, ctx);
		}
		session = undefined;
	});

	return { stop };
}

/** 测试辅助：当前揭示态消息数。 */
export function revealStateCount(): number {
	return states.size;
}

/** 测试辅助：已交还（直通）消息数（同进程内跨安装实例累计，测试前后归零）。 */
export function handedBackCount(): number {
	return handedBack.size;
}