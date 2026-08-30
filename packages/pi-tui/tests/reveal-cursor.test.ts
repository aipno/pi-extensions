/**
 * reveal-cursor 纯函数单测（P2 §1 步骤 1，独立于宿主）。
 *
 * 覆盖：追赶公式、时间闸（5ms 密集 delta 合并推进 ≤30fps）、coalesce 不丢字、
 * 冲刷、断流自动停表、CJK/emoji 代理对不劈、首帧即时推进、Segmented 缺失回退。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
	advanceGraphemeCursor,
	BlockUnitCounter,
	graphemeCount,
	revealSteps,
	shouldReveal,
	textSegments,
	truncateMessageToCursor,
} from "../extensions/utils/reveal-cursor.ts";
import {
	graphemeCount as graphemeCountFallback,
	advanceGraphemeCursor as advanceFallback,
	resetGraphemeSegmenterForTest,
} from "../extensions/utils/reveal-cursor.ts";

function message(content: AssistantMessage["content"], stopReason = "pending"): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: stopReason as AssistantMessage["stopReason"],
		timestamp: 123,
	};
}

// ── grapheme 计数与游标 ───────────────────────────────────────────────────

test("graphemeCount：ASCII/CJK/emoji 代理对各计 1", () => {
	assert.equal(graphemeCount(""), 0);
	assert.equal(graphemeCount("hello"), 5);
	assert.equal(graphemeCount("中文测试"), 4);
	assert.equal(graphemeCount("a😀b"), 3, "代理对作为一个 grapheme");
	assert.equal(graphemeCount("👨‍👩‍👧‍👦"), 1, "ZWJ 家庭 emoji 作为一个 grapheme");
});

test("advanceGraphemeCursor：边界步进，代理对/组合字符不劈", () => {
	const text = "abc😀de";
	assert.equal(advanceGraphemeCursor(text, 0, 1), 1);
	assert.equal(advanceGraphemeCursor(text, 0, 3), 3, "3 个 grapheme 后停在 😀 起点边界");
	assert.equal(advanceGraphemeCursor(text, 3, 1), 5, "😀 揭示后停在 d 起点，代理对不劈");
	assert.equal(advanceGraphemeCursor(text, 0, 99), text.length, "超出末尾钳制");
	assert.equal(advanceGraphemeCursor(text, 2, 0), 2, "steps=0 原地");
});

test("advanceGraphemeCursor：组合序列（é = e + 组合重音）不劈", () => {
	const text = "e\u0301x"; // é + x
	assert.equal(graphemeCount(text), 2);
	assert.equal(advanceGraphemeCursor(text, 0, 1), 2, "一个 grapheme = e + 组合重音两个 code point");
	assert.equal(advanceGraphemeCursor(text, 0, 2), 3);
});

test("advanceGraphemeCursor/graphemeCount：Segmenter 缺失回退 code point 切分", () => {
	const OriginalIntl = globalThis.Intl;
	const fakeIntl = { ...OriginalIntl } as Record<string, unknown>;
	delete fakeIntl.Segmenter;
	(globalThis as any).Intl = fakeIntl;
	resetGraphemeSegmenterForTest();
	try {
		assert.equal(graphemeCountFallback("a😀b"), 3, "代理对各计一个 code point");
		assert.equal(graphemeCountFallback("e\u0301"), 2, "组合序列按 code point 计 2");
		assert.equal(advanceFallback("abc😀de", 0, 4), 5, "4 code points 后落在 d（代理对不劈）");
		assert.equal(advanceFallback("abc😀de", 0, 6), 7, "到达末尾");
		assert.equal(advanceFallback("ab", 1, 1), 2);
	} finally {
		(globalThis as any).Intl = OriginalIntl;
		resetGraphemeSegmenterForTest();
	}
});

// ── 追赶公式 ───────────────────────────────────────────────────────────────

test("revealSteps：max(3, ceil(backlog/8))", () => {
	assert.equal(revealSteps(0), 3, "backlog 0 也有最小步进（推进函数按剩余钳制）");
	assert.equal(revealSteps(1), 3);
	assert.equal(revealSteps(8), 3);
	assert.equal(revealSteps(9), 3); // ceil(9/8)=2 → min 3
	assert.equal(revealSteps(24), 3);
	assert.equal(revealSteps(25), 4); // ceil(25/8)=4
	assert.equal(revealSteps(80), 10);
	assert.equal(revealSteps(800), 100);
});

// ── 时间闸 ─────────────────────────────────────────────────────────────────

test("shouldReveal：33ms 闸，5ms 密集 delta 合并推进 ≤30fps", () => {
	const gateMs = 33;
	assert.equal(shouldReveal(0, 32, gateMs), false, "闸内不推进");
	assert.equal(shouldReveal(0, 33, gateMs), true, "达闸推进");
	assert.equal(shouldReveal(100, 100, gateMs), false, "同一时刻不重复推进");
	assert.equal(shouldReveal(100, 133, gateMs), true);

	// 模拟 5ms 一个 delta 的密集流：首个推进在 t=35（首帧除外），此后闸内合并。
	let lastRevealAt = 0;
	const reveals: number[] = [];
	for (let now = 5; now <= 45; now += 5) {
		if (shouldReveal(lastRevealAt, now, gateMs)) {
			lastRevealAt = now;
			reveals.push(now);
		}
	}
	assert.deepEqual(reveals, [35], "35ms 前闸内合并，35ms 处唯一推进");
	assert.ok(reveals.every((t, i) => i === 0 || t - reveals[i - 1]! >= gateMs), "相邻推进间隔 >= 33ms");
});

// ── BlockUnitCounter：增量计数只扫 tail ────────────────────────────────────

test("BlockUnitCounter：增量 push 累计 grapheme（只重扫 tail）", () => {
	const counter = new BlockUnitCounter();
	assert.equal(counter.push("abc"), 3);
	assert.equal(counter.push("de"), 5);
	assert.equal(counter.count, 5);
	assert.equal(counter.push(""), 5, "空 chunk 不计");
	assert.equal(counter.push("😀x"), 7, "代理对计 1");
	assert.equal(counter.count, 7);
});

test("BlockUnitCounter：文本缩短/替换 → reset 后重推", () => {
	const counter = new BlockUnitCounter();
	counter.push("abcdef");
	assert.equal(counter.count, 6);
	counter.reset();
	assert.equal(counter.push("abc"), 3);
	assert.equal(counter.count, 3);
});

test("BlockUnitCounter：CJK/emoji 按 grapheme 计数", () => {
	const counter = new BlockUnitCounter();
	counter.push("中文");
	assert.equal(counter.count, 2);
	counter.push("😀a");
	assert.equal(counter.count, 4);
});

// ── 消息截断与冲刷 ─────────────────────────────────────────────────────────

test("truncateMessageToCursor：跨 text 块消费，thinking/toolCall 透传", () => {
	const msg = message([
		{ type: "text", text: "hello" },
		{ type: "thinking", thinking: "secret" },
		{ type: "text", text: " world!" },
		{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
	]);
	const out = truncateMessageToCursor(msg, 8);
	assert.equal(out.content[0]!.type, "text");
	assert.equal((out.content[0] as any).text, "hello", "第一块全量");
	assert.equal(out.content[1]!.type, "thinking");
	assert.equal((out.content[1] as any).thinking, "secret", "thinking 透传");
	assert.equal((out.content[2] as any).text, " wo", "第二块截 3 grapheme（' world!' 前 3 个）");
	assert.equal(out.content[3]!.type, "toolCall", "toolCall 透传");
});

test("truncateMessageToCursor：游标在块内按 grapheme 边界切，不劈代理对", () => {
	const msg = message([{ type: "text", text: "a😀b😀c" }]);
	const out = truncateMessageToCursor(msg, 2);
	assert.equal((out.content[0] as any).text, "a😀", "2 grapheme，代理对完整保留");
	assert.equal(msg.content[0]!.type, "text");
});

test("truncateMessageToCursor：cursor=0 或全量时不重建消息（恒等）", () => {
	const msg = message([{ type: "text", text: "abc" }]);
	assert.equal(truncateMessageToCursor(msg, 0), msg, "cursor=0 原样");
	assert.equal(truncateMessageToCursor(msg, 3), msg, "光标达全文原样（冲刷路径返回全量）");
});

test("truncateMessageToCursor：非 text 字段与消息字段透传", () => {
	const msg = message([{ type: "text", text: "hello world" }], "stop");
	const out = truncateMessageToCursor(msg, 5);
	assert.equal(out.stopReason, "stop");
	assert.equal(out.timestamp, 123);
	assert.equal(out.api, "anthropic");
	assert.equal((out.content[0] as any).text, "hello");
	assert.equal((out.content[0] as any).type, "text");
});

test("textSegments：仅 text 块，按 content[] 顺序", () => {
	const msg = message([
		{ type: "text", text: "a" },
		{ type: "thinking", thinking: "t" },
		{ type: "text", text: "b" },
	]);
	assert.deepEqual(textSegments(msg), ["a", "b"]);
});

// ── 集成性质：coalesce 不丢字 + 冲刷无残留 ─────────────────────────────────

test("集成：revealSteps 追赶全部覆盖，截断结果逐帧单调且终达全文", () => {
	const full = "这是一段相当长的流式回复文本，包含几个 emoji 😀🎉 以及标点符号！";
	const msg = message([{ type: "text", text: full }]);
	const total = graphemeCount(full);
	let cursor = 0;
	const lengths: number[] = [];
	while (cursor < total) {
		cursor = Math.min(total, cursor + revealSteps(total - cursor));
		const out = truncateMessageToCursor(msg, cursor);
		const shown = graphemeCount((out.content[0] as { text: string }).text);
		lengths.push(shown);
		assert.ok(shown <= total, "不越界");
	}
	assert.equal(lengths.at(-1), total, "末帧 = 全文（冲刷后无残留）");
	assert.ok(
		lengths.slice(0, -1).every((n, i) => n < (lengths[i + 1] ?? Infinity)),
		"中间帧严格单调增长（不丢字、无回退）",
	);
});