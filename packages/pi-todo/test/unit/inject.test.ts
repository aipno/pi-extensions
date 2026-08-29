import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMockCtx, createMockPi } from "../helpers.ts";
import registerTodo from "../../index.ts";
import { __resetState } from "../../todo.ts";

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

test("before_agent_start — injects the current board into the system prompt", async () => {
	const { pi, captured } = createMockPi();
	registerTodo(pi as never);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx({ sessionId: "s1" });
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "create", subject: "first" },
		undefined,
		undefined,
		ctx,
	);
	const handler = captured.events.get("before_agent_start")?.[0];
	assert.ok(handler, "expected before_agent_start to be registered");
	const result = await handler({ type: "before_agent_start", systemPrompt: "BASE" }, ctx);
	const prompt = (result as { systemPrompt: string }).systemPrompt;
	assert.ok(prompt.startsWith("BASE"));
	assert.ok(prompt.includes("Current todos:"));
	assert.ok(prompt.includes("#1 [pending] first"));
});

test("before_agent_start — adds nothing when the list is empty", async () => {
	const { pi, captured } = createMockPi();
	registerTodo(pi as never);
	const ctx = createMockCtx({ sessionId: "s1" });
	const handler = captured.events.get("before_agent_start")?.[0];
	assert.ok(handler);
	const result = await handler({ type: "before_agent_start", systemPrompt: "BASE" }, ctx);
	assert.equal(result, undefined);
});

test("before_agent_start — B4: stale in_progress task gets a reminder after several untouched turns", async () => {
	const { pi, captured } = createMockPi();
	registerTodo(pi as never);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx({ sessionId: "s1" });
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "create", subject: "stuck" },
		undefined,
		undefined,
		ctx,
	);
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "update", id: 1, status: "in_progress", activeForm: "Working" },
		undefined,
		undefined,
		ctx,
	);
	const handler = captured.events.get("before_agent_start")?.[0]!;
	const prompt = async () =>
		((await handler({ type: "before_agent_start", systemPrompt: "BASE" }, ctx)) as { systemPrompt: string })
			.systemPrompt;

	// Turn 1 and 2: too early — no reminder yet (needs 2 untouched turns).
	for (let i = 0; i < 2; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(!(await prompt()).includes("Stale:"));
	}
	// Turn 3: the task has gone two full turns without an update.
	await new Promise((resolve) => setTimeout(resolve, 5));
	const third = await prompt();
	assert.ok(third.includes("Current todos:"));
	assert.ok(third.includes("#1 [in_progress] stuck"));
	assert.ok(third.includes("Stale:"));
	assert.ok(third.includes("#1 [in_progress] stuck — no update for 2 turns"));
});

test("before_agent_start — B4: an updated task is never reminded (updatedAt refresh clears staleness)", async () => {
	const { pi, captured } = createMockPi();
	registerTodo(pi as never);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx({ sessionId: "s2" });
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "create", subject: "moving" },
		undefined,
		undefined,
		ctx,
	);
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "update", id: 1, status: "in_progress" },
		undefined,
		undefined,
		ctx,
	);
	const handler = captured.events.get("before_agent_start")?.[0]!;
	const prompt = async () =>
		((await handler({ type: "before_agent_start", systemPrompt: "BASE" }, ctx)) as { systemPrompt: string })
			.systemPrompt;

	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		const p = await prompt();
		// Refresh the task every turn so it never goes stale.
		await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
			"tc",
			{ action: "update", id: 1, activeForm: `step ${i}` },
			undefined,
			undefined,
			ctx,
		);
		assert.ok(!p.includes("Stale:"));
	}
});
