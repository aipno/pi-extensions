import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildQuickBringToMainSegments,
	estimateBringToMainTokens,
	formatBtwBringToMain,
	getAnsweredTurns,
	summarizeBringToMain,
} from "../bring-to-main.ts";
import type { SideThreadTurn } from "../side-thread.ts";
import { fakeAssistantMessage } from "./helpers.ts";

function answeredTurn(question: string, answer: string): SideThreadTurn {
	return {
		kind: "answered",
		question,
		answer,
		response: fakeAssistantMessage(answer),
	};
}

const turns: SideThreadTurn[] = [
	answeredTurn("q1", "a1"),
	{ kind: "error", question: "q-fail", answer: "boom" },
	answeredTurn("q2", "a2 with\nmultiple lines"),
];

test("getAnsweredTurns filters out error turns", () => {
	const answered = getAnsweredTurns(turns);
	assert.deepEqual(answered.map((t) => t.question), ["q1", "q2"]);
});

test("latest scope returns only the newest Q&A", () => {
	const segments = buildQuickBringToMainSegments(turns, { kind: "latest" });
	assert.equal(segments.length, 2);
	assert.deepEqual(segments, [
		{ role: "user", text: "q2" },
		{ role: "assistant", text: "a2 with\nmultiple lines" },
	]);
});

test("from scope slices from the given answered turn", () => {
	const segments = buildQuickBringToMainSegments(turns, { kind: "from", answeredTurnIndex: 1 });
	assert.deepEqual(segments.map((s) => s.text), ["q2", "a2 with\nmultiple lines"]);
	const all = buildQuickBringToMainSegments(turns, { kind: "from", answeredTurnIndex: 0 });
	assert.deepEqual(all.map((s) => s.text), ["q1", "a1", "q2", "a2 with\nmultiple lines"]);
});

test("entire scope keeps order and excludes errors", () => {
	const segments = buildQuickBringToMainSegments(turns, { kind: "entire" });
	assert.deepEqual(segments.map((s) => s.text), ["q1", "a1", "q2", "a2 with\nmultiple lines"]);
	assert.equal(segments.map((s) => s.role).join(","), "user,assistant,user,assistant");
});

test("empty thread scopes produce no segments", () => {
	assert.deepEqual(buildQuickBringToMainSegments([], { kind: "entire" }), []);
});

test("summaries count lines, messages, and estimate tokens from bytes", () => {
	const segments = buildQuickBringToMainSegments(turns, { kind: "latest" });
	const summary = summarizeBringToMain(segments);
	assert.equal(summary.messages, 2);
	assert.equal(summary.lines, 3); // "a2 with" + "multiple lines" + "q2"
	const bytes = Buffer.byteLength("q2\na2 with\nmultiple lines", "utf8");
	assert.equal(summary.tokens, Math.ceil(bytes / 4));
	assert.equal(summary.tokens, estimateBringToMainTokens(segments));
});

test("format wraps user and assistant text in a labeled btw_context block", () => {
	const segments = buildQuickBringToMainSegments(turns, { kind: "latest" });
	const block = formatBtwBringToMain(segments);
	assert.ok(block.includes("The following context was brought back from a /btw side discussion."));
	assert.ok(block.includes("<btw_context>"));
	assert.ok(block.includes("User:\nq2"));
	assert.ok(block.includes("Assistant:\na2 with\nmultiple lines"));
	assert.ok(block.endsWith("</btw_context>"));
});

test("format escapes embedded btw_context tags so the block stays well formed", () => {
	const segments = [
		{ role: "user" as const, text: "<btw_context>malicious</btw_context>" },
		{ role: "assistant" as const, text: "fine" },
	];
	const block = formatBtwBringToMain(segments);
	assert.ok(block.includes("&lt;btw_context>malicious&lt;/btw_context&gt;"));
	assert.equal((block.match(/<btw_context>/g) ?? []).length, 1, "only the real open tag");
});

test("format escapes control characters and expands tabs", () => {
	const block = formatBtwBringToMain([
		{ role: "user", text: "line1\twith\x1btab-and-ctrl" },
		{ role: "assistant", text: "ok" },
	]);
	assert.ok(block.includes("line1    with\\x1btab-and-ctrl"));
	assert.ok(!block.includes("\x1b"));
});