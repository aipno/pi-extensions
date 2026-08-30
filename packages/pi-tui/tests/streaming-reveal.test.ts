/**
 * P2(§1) streaming-reveal 集成测试：原型补丁生命周期、链式共存（compact-thinking）、
 * 揭示时序（首帧即时 / 33ms 闸 / 250ms 断流追赶 / 停表）、消息身份（冲刷/交还/
 * 直通）、透传条件（配置关闭 / 动画禁用）、CPU 调用计数对比。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { config, normalizeConfig } from "../extensions/config/config.ts";
import { t } from "../extensions/utils/i18n.ts";
import { installCompactThinking } from "../extensions/feature/compact-thinking.ts";
import {
	handedBackCount,
	installStreamingReveal,
	revealStateCount,
	WIDGET_ID,
} from "../extensions/feature/streaming-reveal.ts";
import { resetSharedTickers, getSharedTicker } from "../extensions/utils/shared-ticker.ts";
import { resetTerminalCapabilityCache } from "../extensions/utils/terminal-capabilities.ts";
import { PROTOTYPE_ORIGINAL_KEY } from "../extensions/utils/patch-keys.ts";

initTheme("dark");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 合成流式文本消息：text 块随 content 拼接。 */
function streamMessage(
	text: string,
	timestamp: number,
	stopReason: "pending" | "stop" = "pending",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

const TUI_UI = {
	theme: {},
	setWidget() {},
	requestRender() {},
};

function runtime() {
	const handlers = new Map<string, Function[]>();
	return {
		handlers,
		pi: {
			on(name: string, handler: Function) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			appendEntry() {},
		} as any,
		emit(name: string, event: any = {}, ctx: any = {}) {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}

const tuiCtx = {
	mode: "tui",
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { ...TUI_UI },
};

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const keys = ["COLORTERM", "TERM", "NO_COLOR", "PI_TUI_COLOR", "PI_TUI_ANIMATIONS", "TERM_PROGRAM", "TMUX", "CI"];
	const previous: Record<string, string | undefined> = {};
	for (const key of [...keys, ...Object.keys(env)]) {
		previous[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	resetTerminalCapabilityCache();
	try {
		fn();
	} finally {
		for (const key of Object.keys(previous)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key]!;
		}
		resetTerminalCapabilityCache();
	}
}

// 动画强制开启（CI/dumb 环境会关动画 → reveal 透传，测试无法驱动）。
function forceAnimation() {
	process.env.PI_TUI_ANIMATIONS = "1";
	resetTerminalCapabilityCache();
}

// ── 补丁生命周期与链式还原 ─────────────────────────────────────────────────

test("补丁生命周期：session_start 惰性安装，shutdown 还原到原始原型", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	const { emit, pi } = runtime();
	const original = AssistantMessageComponent.prototype.updateContent;
	try {
		installStreamingReveal(pi);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original, "惰性：session_start 前不装");
		emit("session_start", {}, tuiCtx);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, original, "session_start 后装上补丁");
		assert.equal(revealStateCount(), 0);
	} finally {
		emit("session_shutdown", {}, tuiCtx);
		config.streamingReveal = previousMode;
		assert.equal(AssistantMessageComponent.prototype.updateContent, original, "还原到原始原型");
		resetSharedTickers();
	}
});

test("reload 所有权：新实例替换旧补丁，旧实例 shutdown 不破坏", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	const original = AssistantMessageComponent.prototype.updateContent;
	const first = runtime();
	const second = runtime();
	try {
		installStreamingReveal(first.pi);
		first.emit("session_start", {}, tuiCtx);
		const firstPatch = AssistantMessageComponent.prototype.updateContent;

		installStreamingReveal(second.pi);
		second.emit("session_start", {}, tuiCtx);
		const replacementPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(replacementPatch, firstPatch, "新实例的补丁替换旧补丁");

		first.emit("session_shutdown", {}, tuiCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			replacementPatch,
			"旧实例 shutdown 不得拆掉新补丁",
		);

		second.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original, "新实例 shutdown 还原原生");
	} finally {
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

test("与 compact-thinking 链式共存：SR 外层，卸载顺序无关还原", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	const original = AssistantMessageComponent.prototype.updateContent;
	const ctRuntime = runtime();
	const srRuntime = runtime();
	try {
		// 仓库顺序：compact-thinking 先装（内层），streaming-reveal 后装（外层）。
		installCompactThinking(ctRuntime.pi, { useSummaryTitlesAsThinkingTitle: false, previewLines: 0, animationIntervalMs: 30 });
		ctRuntime.emit("session_start", {}, tuiCtx);
		const ctPatch = AssistantMessageComponent.prototype.updateContent;

		installStreamingReveal(srRuntime.pi);
		srRuntime.emit("session_start", {}, tuiCtx);
		const srPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(srPatch, ctPatch, "SR 补丁盖在 CT 之上");
		assert.equal(
			(srPatch as any)[PROTOTYPE_ORIGINAL_KEY],
			ctPatch,
			"SR patch 在自己的标记上挂捕获的 CT 补丁（§0.1 链式还原）",
		);

		// 先卸 SR → 原型还原到 CT 补丁。
		srRuntime.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, ctPatch);

		// 再卸 CT → 还原原生。
		ctRuntime.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

test("链式数据流：CT 补丁收到 SR 的截断消息并按其渲染", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	forceAnimation();
	const original = AssistantMessageComponent.prototype.updateContent;
	const ctRuntime = runtime();
	const srRuntime = runtime();
	try {
		installCompactThinking(ctRuntime.pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines: 0,
			animationIntervalMs: 30,
		});
		ctRuntime.emit("session_start", {}, tuiCtx);
		installStreamingReveal(srRuntime.pi);
		srRuntime.emit("session_start", {}, tuiCtx);

		const component = new AssistantMessageComponent(undefined, true) as any;
		const ts = Date.now() + 8000;
		const text = "long streaming answer that keeps growing and growing and growing";
		component.updateContent(streamMessage(text, ts), true);
		// native 渲染的是截断文本（SR 在链条最外层先截断）→ CT/native 的输出以文本前缀呈现。
		const rendered = component.render(200).map((l: string) => l.replace(/\x1b\[[0-9;.]*m/g, ""));
		const joined = rendered.join("\n");
		assert.ok(joined.includes(text.slice(0, 5)), "渲染内容以截断前缀呈现");
		assert.ok(!joined.includes("keeps"), "渲染内容尚未达全文（首帧截断）");
		// 组件 lastMessage 保持全量（SR 复原），供宿主 toolCall 追踪/invalidate。
		assert.equal((component as any).lastMessage.content[0].text, text);
	} finally {
		srRuntime.emit("session_shutdown", {}, tuiCtx);
		ctRuntime.emit("session_shutdown", {}, tuiCtx);
		if (AssistantMessageComponent.prototype.updateContent !== original) {
			AssistantMessageComponent.prototype.updateContent = original;
		}
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

test("与 compact-thinking 反序共存：无破坏，最终还原原生", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	const original = AssistantMessageComponent.prototype.updateContent;
	const ctRuntime = runtime();
	const srRuntime = runtime();
	try {
		installStreamingReveal(srRuntime.pi);
		srRuntime.emit("session_start", {}, tuiCtx);
		const srPatch = AssistantMessageComponent.prototype.updateContent;

		installCompactThinking(ctRuntime.pi, { useSummaryTitlesAsThinkingTitle: false, previewLines: 0, animationIntervalMs: 30 });
		ctRuntime.emit("session_start", {}, tuiCtx);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, srPatch, "CT 盖在 SR 之上");

		ctRuntime.emit("session_shutdown", {}, tuiCtx);
		srRuntime.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original, "双卸后还原原生，无残留");
		assert.equal(revealStateCount(), 0);
	} finally {
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

// ── 揭示时序 ───────────────────────────────────────────────────────────────

function installRevealWithSpy(): {
	emit: (name: string, event?: any, ctx?: any) => void;
	stop: () => void;
	/** 模拟宿主 message_update/message_end → 组件 updateContent 的驱动。 */
	send: (message: AssistantMessage, isStreaming?: boolean) => void;
	component: any;
	calls: Array<{ message: AssistantMessage; isStreaming: boolean; at: number }>;
	uninstall: () => void;
} {
	const { emit, pi } = runtime();
	const original = AssistantMessageComponent.prototype.updateContent;
	const calls: Array<{ message: AssistantMessage; isStreaming: boolean; at: number }> = [];
	// spy 模拟"链下真实渲染"（记录入参并转发原生渲染）。
	AssistantMessageComponent.prototype.updateContent = function (message: any, isStreaming?: boolean) {
		calls.push({ message, isStreaming: isStreaming ?? false, at: performance.now() });
		original.call(this, message, isStreaming);
	};
	const spy = AssistantMessageComponent.prototype.updateContent;
	const component = new AssistantMessageComponent(undefined, true) as any;
	installStreamingReveal(pi);
	emit("session_start", {}, tuiCtx);
	return {
		emit,
		stop: () => {
			emit("session_shutdown", {}, tuiCtx);
		},
		send: (message: AssistantMessage, isStreaming = true) => {
			// 宿主在 message_update 时调用 updateContent(message, true)；message_end 传 false。
			component.updateContent(message, isStreaming);
		},
		component,
		calls,
		uninstall: () => {
			// 直接还原原型（SR patch 卸载守卫走不到 spy 时的兜底）。
			if (AssistantMessageComponent.prototype.updateContent === spy) {
				AssistantMessageComponent.prototype.updateContent = original;
			}
		},
	};
}

const textOf = (calls: Array<{ message: AssistantMessage; isStreaming: boolean; at: number }>, index: number) =>
	((calls[index]?.message.content[0] as { text: string })?.text ?? "");

test("揭示时序：首帧即时推进 + 33ms 闸内合并 + 断流追赶 + 冲刷", async () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	forceAnimation();
	const reveal = installRevealWithSpy();
	try {
		const ts = Date.now();
		// 8 个 2ms 间隔的密集 delta（同消息，文本递增）。
		let text = "";
		for (let i = 1; i <= 8; i++) {
			text += `chunk${i} `.repeat(5);
			reveal.send(streamMessage(text, ts));
			await sleep(2);
		}
		// 首帧即时推进：第一个 delta 立即产生一次截断调用。
		assert.ok(reveal.calls.length >= 1, "首帧即时推进");
		const firstText = textOf(reveal.calls, 0);
		assert.ok(firstText.length > 0 && firstText.length < text.length, "首帧是截断文本");
		assert.equal(reveal.calls[0]!.isStreaming, true);
		// 闸内合并：密集 delta 期间推进帧数远小于 delta 数（≤1 帧 + 偶发闸边界）。
		assert.ok(
			reveal.calls.length <= 3,
			`33ms 闸内密集 delta 不应逐帧推进，实际 ${reveal.calls.length} 次`,
		);

		// 断流追赶：250ms 检测 + ~26 帧 × 33ms（尾步最小 3 grapheme 爬行），1600ms 留足余量。
		await sleep(1600);
		const finalCall = reveal.calls.at(-1)!;
		assert.equal(
			((finalCall.message.content[0] as { text: string }).text),
			text,
			"断流追赶后最终以全量文本收尾",
		);
		assert.equal(revealStateCount(), 0, "推进完成后揭示态清除");
		assert.ok(handedBackCount() >= 1, "消息标记已交还");
		assert.equal(getSharedTicker(33).size, 0, "backlog 清空后 ticker 停表");

		// 推进帧间隔（delta 驱动 + ticker 帧）≥ 约 30fps 语义。
		for (let i = 2; i < reveal.calls.length; i++) {
			assert.ok(reveal.calls[i]!.at - reveal.calls[i - 1]!.at >= 25, `第 ${i} 帧间隔过密`);
		}

		// message_end 冲刷：直通全量（不再截断），且该消息"已交还"。
		const beforeEnd = reveal.calls.length;
		reveal.send(streamMessage(text, ts, "stop"), false);
		assert.equal(reveal.calls.length, beforeEnd + 1, "message_end 也走一次直通调用");
		assert.equal(reveal.calls.at(-1)!.isStreaming, false);
		assert.equal(textOf(reveal.calls, beforeEnd), text, "冲刷传全量");

		// 后续同消息 updateContent(true) 直通（不再管线化）。
		const beforeReplay = reveal.calls.length;
		reveal.send(streamMessage(text + " replay", ts));
		assert.equal(reveal.calls.length, beforeReplay + 1, "交还后同消息直通");
		assert.equal(textOf(reveal.calls, beforeReplay), text + " replay", "直通不截断");

		// 新消息重新管线化。
		const nextTs = ts + 1;
		reveal.send(streamMessage("fresh start".repeat(10), nextTs));
		assert.ok(textOf(reveal.calls, reveal.calls.length - 1).length < "fresh start".repeat(10).length, "新消息重新截断揭示");
	} finally {
		reveal.stop();
		reveal.uninstall();
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

test("断流中途新 delta 到达：立即停表，交还 delta 驱动", async () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	forceAnimation();
	const reveal = installRevealWithSpy();
	try {
		const ts = Date.now() + 1000;
		const initial = "aaaaaaaaaa bbbbbbbbbb ".repeat(50); // ~1100 graphemes
		reveal.send(streamMessage(initial, ts));
		await sleep(350); // 断流检测 + ticker 已起（部分推进）
		const ticker = getSharedTicker(33);
		if (revealStateCount() > 0 && ticker.size > 0) {
			// 新 delta 到达 → 停表。
			const grew = initial + "ccc";
			reveal.send(streamMessage(grew, ts));
			assert.equal(ticker.size, 0, "新 delta 到达立即停表");
			await sleep(900);
			assert.equal(revealStateCount(), 0, "后续经闸/追赶到达全量");
			assert.equal(textOf(reveal.calls, reveal.calls.length - 1), grew);
		}
	} finally {
		reveal.stop();
		reveal.uninstall();
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

// ── 透传条件与配置 ─────────────────────────────────────────────────────────

test("透传：配置 off 时 updateContent 原样直通（不截断、不建态）", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "off";
	forceAnimation();
	const reveal = installRevealWithSpy();
	try {
		const ts = Date.now() + 2000;
		const full = "no reveal for you ".repeat(30);
		reveal.send(streamMessage(full, ts));
		assert.equal(textOf(reveal.calls, 0), full, "off 直通全量");
		assert.equal(revealStateCount(), 0, "off 不建揭示态");
	} finally {
		reveal.stop();
		reveal.uninstall();
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

test("透传：动画禁用（PI_TUI_COLOR=none）时原样直通", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	withEnv({ PI_TUI_COLOR: "none" }, () => {
		const reveal = installRevealWithSpy();
		try {
			const ts = Date.now() + 3000;
			const full = "frozen animation ".repeat(20);
			reveal.send(streamMessage(full, ts));
			assert.equal(textOf(reveal.calls, 0), full, "动画禁用直通全量");
			assert.equal(revealStateCount(), 0);
		} finally {
			reveal.stop();
			reveal.uninstall();
			resetSharedTickers();
		}
	});
	config.streamingReveal = previousMode;
});

test("透传：isStreaming 缺省（invalidate 类重渲染）不管线化", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	forceAnimation();
	const reveal = installRevealWithSpy();
	try {
		const ts = Date.now() + 4000;
		const full = "invalidate re-render ".repeat(10);
		reveal.send(streamMessage(full, ts));
		assert.ok(textOf(reveal.calls, 0).length < full.length, "首个流式 delta 截断");
		// 组件 invalidate 以 updateContent(lastMessage)（无 isStreaming）重渲染 → 直通。
		const before = reveal.calls.length;
		reveal.component.updateContent(streamMessage(full, ts));
		reveal.component.updateContent(streamMessage(full, ts));
		assert.equal(reveal.calls.length, before + 2, "缺省 isStreaming 原样透传不改内容");
	} finally {
		reveal.stop();
		reveal.uninstall();
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

test("消息身份：thinking/toolCall 不占游标、透传；空 text 消息不建态", () => {
	const previousMode = config.streamingReveal;
	config.streamingReveal = "on";
	forceAnimation();
	const reveal = installRevealWithSpy();
	try {
		const ts = Date.now() + 5000;
		// 仅 thinking + toolCall（无 text）：不建揭示态，原样透传。
		const thinkingOnly = {
			...streamMessage("", ts),
			content: [
				{ type: "thinking", thinking: "let me think" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
			] as AssistantMessage["content"],
		};
		reveal.send(thinkingOnly);
		assert.equal(revealStateCount(), 0, "无 text 不建态");
		assert.equal(reveal.calls[0]!.isStreaming, true);

		// text 与 thinking 混合：截断只切 text 块，thinking 原样传递。
		const ts2 = ts + 1;
		const mixed = {
			...streamMessage("hello world", ts2),
			content: [
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "secret plan" },
				{ type: "text", text: " world" },
			] as AssistantMessage["content"],
		};
		reveal.send(mixed);
		const first = reveal.calls.at(-1)!.message.content;
		// 首批推进 steps = max(3, ceil(11/8)) = 3 grapheme：第一 text 块截到 "hel"，
		// thinking 不占游标且原样透传；第二 text 块尚未被游标覆盖。
		assert.equal((first[0] as { text: string }).text, "hel", "第一 text 块按游标截断");
		assert.equal((first[1] as { thinking: string }).thinking, "secret plan", "thinking 块原样透传");
		assert.equal((first[2] as { text: string }).text, "", "第二 text 块尚未计入游标、截为空");
	} finally {
		reveal.stop();
		reveal.uninstall();
		config.streamingReveal = previousMode;
		resetSharedTickers();
	}
});

// ── CPU 调用计数对比（合成数千 delta 长回复） ──────────────────────────────

test("CPU 基线：原生每 delta 一次全量渲染；reveal 只在小部分宿主帧上推进", async () => {
	const previousMode = config.streamingReveal;
	forceAnimation();

	// 原生路径调用计数（配置 off，spy 即链下）。
	config.streamingReveal = "off";
	const nativeReveal = installRevealWithSpy();
	const ts = Date.now() + 6000;
	let long = "";
	const DELTAS = 500;
	for (let i = 0; i < DELTAS; i++) {
		long += `segment ${i} `.repeat(2);
		nativeReveal.send(streamMessage(long, ts));
	}
	const nativeCalls = nativeReveal.calls.length;
	assert.equal(nativeCalls, DELTAS, "原生每 delta 一次全量渲染（基线）");
	nativeReveal.stop();
	nativeReveal.uninstall();
	resetSharedTickers();

	// reveal 路径：同批量 delta（同一时刻到达），首帧推进 + 断流 ticker 追赶。
	config.streamingReveal = "on";
	const revealReveal = installRevealWithSpy();
	const ts2 = ts + 1;
	long = "";
	for (let i = 0; i < DELTAS; i++) {
		long += `segment ${i} `.repeat(2);
		revealReveal.send(streamMessage(long, ts2));
	}
	await sleep(2800); // 250ms 断流检测 + 长文本追赶（~56 帧 × 33ms）。
	const revealCalls = revealReveal.calls.length;
	const renderedBeforeEnd = textOf(revealReveal.calls, revealReveal.calls.length - 1);
	assert.equal(renderedBeforeEnd, long, "长时间追赶后全量覆盖，无丢字");
	assert.ok(
		revealCalls <= Math.ceil(DELTAS / 5),
		`reveal 的 updateContent 次数=${revealCalls} 应远小于原生 ${nativeCalls}（批量 delta 合并推进）`,
	);
	revealReveal.stop();
	revealReveal.uninstall();
	config.streamingReveal = previousMode;
	resetSharedTickers();
});

// ── 配置与面板 ─────────────────────────────────────────────────────────────

test("normalizeConfig：streamingReveal 枚举兜底默认 off", () => {
	assert.equal(normalizeConfig({}).streamingReveal, "off");
	assert.equal(normalizeConfig({ streamingReveal: "on" }).streamingReveal, "on");
	assert.equal(normalizeConfig({ streamingReveal: "auto" }).streamingReveal, "off", "非法值回退");
});

test("面板 i18n 键：streamingReveal en/zh 成对并可解析", async () => {
	const fs = await import("node:fs/promises");
	const readJson = async (path: string) =>
		JSON.parse(await fs.readFile(new URL(path, import.meta.url), "utf8")) as Record<string, string>;
	const en = await readJson("../locales/en.json");
	const zh = await readJson("../locales/zh.json");
	for (const key of [
		"panel.streamingReveal.label",
		"panel.streamingReveal.desc.off",
		"panel.streamingReveal.desc.on",
	]) {
		assert.ok(en[key] !== undefined, `en 缺 ${key}`);
		assert.ok(zh[key] !== undefined, `zh 缺 ${key}`);
	}
	assert.equal(t("panel.streamingReveal.label", "Streaming reveal"), "Streaming reveal");
});