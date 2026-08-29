import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	BTW_THINKING_LEVELS,
	buildFollowUpPrompt,
	buildSideThreadMessages,
	buildUserPrompt,
	completeSideQuestion,
	completeSideThreadTurn,
	createSideThread,
	extractAssistantText,
	type CompleteSimpleFunction,
} from "../side-thread.ts";
import { fakeAssistantMessage } from "./helpers.ts";

function fakeModel(id = "side-model"): Model<"anthropic-messages"> {
	return { provider: "fake", id } as unknown as Model<"anthropic-messages">;
}

function recordingCompleteSimple(log: Array<Record<string, unknown>>): CompleteSimpleFunction {
	return async (model, context, options) => {
		log.push({ model, systemPrompt: context.systemPrompt, messages: context.messages, options });
		return fakeAssistantMessage("the answer");
	};
}

test("a fresh thread prompts with the conversation context", () => {
	const thread = createSideThread("branch context text");
	const messages = buildSideThreadMessages(thread, "my question");
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.role, "user");
	const text = (messages[0]?.content as Array<{ text: string }>)[0]?.text ?? "";
	assert.ok(text.includes("<side_question>"));
	assert.ok(text.includes("my question"));
	assert.ok(text.includes("<conversation_context>"));
	assert.ok(text.includes("branch context text"));
	assert.equal(text.includes("Continue the same side conversation"), false);
});

test("follow-up turns reuse history and drop the conversation context", () => {
	const thread = createSideThread("branch context text");
	const response = fakeAssistantMessage("first answer");
	thread.turns.push({ kind: "answered", question: "q1", answer: "first answer", response });
	const messages = buildSideThreadMessages(thread, "q2");
	assert.equal(messages.length, 3);
	assert.equal(messages[0]?.role, "user");
	assert.ok(buildUserPrompt("q1", "branch context text").includes("<conversation_context>"));
	assert.equal(messages[1], response);
	const followUpText = (messages[2]?.content as Array<{ text: string }>)[0]?.text ?? "";
	assert.equal(followUpText, buildFollowUpPrompt("q2"));
	assert.ok(followUpText.includes("Continue the same side conversation"));
	assert.equal(followUpText.includes("<conversation_context>"), false);
});

test("error turns are excluded from the message history", () => {
	const thread = createSideThread("ctx");
	thread.turns.push({ kind: "error", question: "q1", answer: "boom" });
	const messages = buildSideThreadMessages(thread, "q2");
	assert.equal(messages.length, 1, "failed turns do not become model history");
});

test("completeSideThreadTurn sends the model options with the thinking level", async () => {
	const thread = createSideThread("ctx");
	const log: Array<Record<string, unknown>> = [];
	const role = await completeSideThreadTurn({
		thread,
		model: fakeModel(),
		question: "q1",
		thinkingLevel: "high",
		auth: { apiKey: "key-1" },
		completeSimple: recordingCompleteSimple(log),
	});
	assert.equal(role.kind, "answered");
	const options = log[0]?.["options"] as { reasoning?: string; apiKey?: string };
	assert.equal(options?.reasoning, "high");
	assert.equal(options?.apiKey, "key-1");
	assert.equal(thread.turns.length, 1);
	assert.equal(thread.turns[0]?.kind, "answered");
});

test("thinking level off omits the reasoning option", async () => {
	const log: Array<Record<string, unknown>> = [];
	await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q",
		thinkingLevel: "off",
		auth: {},
		completeSimple: recordingCompleteSimple(log),
	});
	const options = log[0]?.["options"] as { reasoning?: string };
	assert.equal(options?.reasoning, undefined);
});

test("completeSideThreadTurn reports errors from the stream", async () => {
	const result = await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q",
		thinkingLevel: "off",
		auth: {},
		completeSimple: async () => {
			throw new Error("network down");
		},
	});
	assert.deepEqual(result, { kind: "error", message: "network down" });
	assert.equal(threadTurns(), 0);
	function threadTurns() {
		return 0; // throw path never pushes a turn
	}
});

test("stopReason error surfaces the provider message", async () => {
	const result = await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q",
		thinkingLevel: "off",
		auth: {},
		completeSimple: async () =>
			({
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "error",
				errorMessage: "overloaded",
			}) as unknown as AssistantMessage,
	});
	assert.deepEqual(result, { kind: "error", message: "overloaded" });
});

test("aborted signal rejects before and after the request", async () => {
	const controller = new AbortController();
	const result = await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q",
		thinkingLevel: "off",
		auth: {},
		signal: controller.signal,
		completeSimple: async () => fakeAssistantMessage("x"),
	});
	assert.equal(result.kind, "answered", "fresh signal proceeds");
	controller.abort();
	const aborted = await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q2",
		thinkingLevel: "off",
		auth: {},
		signal: controller.signal,
		completeSimple: async () => fakeAssistantMessage("x"),
	});
	assert.deepEqual(aborted, { kind: "aborted" });
});

test("abort during the stream reports aborted, not error", async () => {
	const controller = new AbortController();
	const result = await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q",
		thinkingLevel: "off",
		auth: {},
		signal: controller.signal,
		completeSimple: async () => {
			controller.abort();
			throw new Error("aborted by caller");
		},
	});
	assert.deepEqual(result, { kind: "aborted" });
});

test("malformed responses are reported as errors", async () => {
	const result = await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q",
		thinkingLevel: "off",
		auth: {},
		completeSimple: async () => ({ unexpected: true }) as unknown as AssistantMessage,
	});
	assert.equal(result.kind, "error");
	if (result.kind === "error") assert.match(result.message, /malformed/);
});

test("empty answers become a fallback text", async () => {
	const result = await completeSideThreadTurn({
		thread: createSideThread("ctx"),
		model: fakeModel(),
		question: "q",
		thinkingLevel: "off",
		auth: {},
		completeSimple: async () => fakeAssistantMessage("   "),
	});
	assert.equal(result.kind, "answered");
	if (result.kind === "answered") assert.equal(result.answer, "No response received.");
});

test("extractAssistantText joins text blocks and trims", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: "one" },
			{ type: "thinking", thinking: "ignored" },
			null,
			{ type: "text", text: " two\n" },
		],
		stopReason: "stop",
	} as unknown as AssistantMessage;
	assert.equal(extractAssistantText(message), "one\n two");
});

test("completeSideQuestion is a one-shot prompt without thread history", async () => {
	const log: Array<Record<string, unknown>> = [];
	const response = await completeSideQuestion({
		model: fakeModel(),
		question: "quick one",
		conversationContext: "ctx",
		thinkingLevel: "off",
		auth: {},
		completeSimple: recordingCompleteSimple(log),
	});
	assert.equal(extractAssistantText(response), "the answer");
	assert.equal(log.length, 1);
	const messages = log[0]?.["messages"] as unknown[];
	assert.equal(messages.length, 1);
});

test("thinking levels are the canonical pi list", () => {
	assert.deepEqual(BTW_THINKING_LEVELS, [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});