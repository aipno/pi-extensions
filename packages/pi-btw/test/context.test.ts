import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConversationContext, MAX_CONTEXT_CHARS } from "../context.ts";

const textBlock = (text: string) => [{ type: "text", text }];
const toolCall = (name: string, args: unknown) => [
	{ type: "toolCall", name, arguments: args },
];
const toolResult = (name: string, result: unknown) => [
	{ type: "toolResult", name, result },
];

test("builds a plain-text snapshot of user and assistant messages", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: textBlock("hello") } },
		{ type: "message", message: { role: "assistant", content: textBlock("hi there") } },
	];
	const context = buildConversationContext(entries);
	assert.ok(context.includes("User: hello"));
	assert.ok(context.includes("Assistant: hi there"));
});

test("skips tool messages and non-message entries", () => {
	const entries = [
		{ type: "label", label: "bookmark" },
		{ type: "message", message: { role: "system", content: textBlock("sys") } },
		{ type: "message", message: { role: "user", content: [] } },
		{ type: "message", message: { role: "assistant", content: textBlock("kept") } },
	];
	const context = buildConversationContext(entries);
	assert.equal(context.includes("sys"), false);
	assert.equal(context.includes("kept"), true);
});

test("summarizes tool calls and results as one line each", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: toolCall("read", { path: "a.ts" }) } },
		{
			type: "message",
			message: { role: "assistant", content: toolResult("read", "file contents") },
		},
	];
	const context = buildConversationContext(entries);
	assert.ok(context.includes("Tool call: read({\"path\":\"a.ts\"})"));
	assert.ok(context.includes("Tool result from read: \"file contents\""));
});

test("string content is included directly", () => {
	const context = buildConversationContext([
		{ type: "message", message: { role: "user", content: "raw string" } },
	]);
	assert.ok(context.includes("User: raw string"));
});

test("non-stop stop reasons are annotated", () => {
	const context = buildConversationContext([
		{
			type: "message",
			message: { role: "assistant", content: textBlock("partial"), stopReason: "max_tokens" },
		},
	]);
	assert.ok(context.includes("Assistant (max_tokens): partial"));
});

test("oversized contexts truncate from the start with a note", () => {
	const big = "x".repeat(MAX_CONTEXT_CHARS + 1000);
	const context = buildConversationContext([
		{ type: "message", message: { role: "user", content: textBlock(big) } },
	]);
	assert.ok(context.startsWith("[Earlier context omitted"));
	assert.ok(context.length <= MAX_CONTEXT_CHARS + 100);
	assert.ok(context.endsWith("x".repeat(1000)));
});

test("no entries produces an empty string", () => {
	assert.equal(buildConversationContext([]), "");
});

test("missing message fields are ignored safely", () => {
	assert.equal(buildConversationContext([{ type: "message" }]), "");
	assert.equal(buildConversationContext([{ type: "custom" }]), "");
});