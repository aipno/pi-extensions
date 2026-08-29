import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMockCtx, createMockPi } from "../helpers.ts";
import { __resetState, registerTodosCommand, registerTodoTool, TOOL_NAME } from "../../todo.ts";

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi as never);
	registerTodosCommand(pi as never);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	const cmd = captured.commands.get("todos");
	if (!cmd) throw new Error("command not registered");
	return { tool, cmd };
}

async function seed(tool: Record<string, unknown>, actions: Array<Record<string, unknown>>, ctx = createMockCtx()) {
	for (const p of actions) {
		await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
			"tc",
			p,
			undefined,
			undefined,
			ctx,
		);
	}
}

async function notifyCalls(ctx: ReturnType<typeof createMockCtx>) {
	return ctx.ui.calls.filter((c) => c.method === "notify");
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

test("/todos command — registers a command named 'todos' with a description", () => {
	const { cmd } = setup();
	assert.ok(String(cmd.description).includes("todos"));
});

test("/todos command — notifies an error when the session has no UI", async () => {
	const { cmd } = setup();
	const ctx = createMockCtx({ hasUI: false });
	await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);
	const notifies = await notifyCalls(ctx);
	assert.equal(notifies.length, 1);
	assert.ok(String(notifies[0]!.args[0]).includes("interactive"));
	assert.equal(notifies[0]!.args[1], "error");
});

test("/todos command — notifies an info message when there are no visible tasks", async () => {
	const { cmd } = setup();
	const ctx = createMockCtx();
	await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);
	const notifies = await notifyCalls(ctx);
	assert.ok(String(notifies[0]!.args[0]).includes("No todos"));
	assert.equal(notifies[0]!.args[1], "info");
});

test("/todos command — treats all-deleted tasks as empty (info notify, not group render)", async () => {
	const { tool, cmd } = setup();
	const ctx = createMockCtx();
	await seed(tool, [
		{ action: "create", subject: "a" },
		{ action: "update", id: 1, status: "deleted" },
	], ctx);
	await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);
	const notifies = await notifyCalls(ctx);
	assert.equal(notifies.length, 1);
	assert.ok(String(notifies[0]!.args[0]).includes("No todos"));
});

test("/todos command — renders a grouped status listing with a header", async () => {
	const { tool, cmd } = setup();
	const ctx = createMockCtx();
	await seed(tool, [
		{ action: "create", subject: "pending-task" },
		{ action: "create", subject: "active-task" },
		{ action: "update", id: 2, status: "in_progress" },
		{ action: "create", subject: "done-task" },
		{ action: "update", id: 3, status: "completed" },
	], ctx);
	await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);
	const notifies = await notifyCalls(ctx);
	const text = String(notifies[0]!.args[0]);
	// Header parts: completed/total + in-progress + pending counts.
	assert.ok(text.includes("1/3 completed"));
	assert.ok(text.includes("1 in progress"));
	assert.ok(text.includes("1 pending"));
	// Sections carry their boxed decorations and per-task lines.
	assert.ok(text.includes("── Pending ──"));
	assert.ok(text.includes("#1 pending-task"));
	assert.ok(text.includes("── In Progress ──"));
	assert.ok(text.includes("#2 active-task"));
	assert.ok(text.includes("── Completed ──"));
	assert.ok(text.includes("#3 done-task"));
});

test("/todos command — renders a task's owner", async () => {
	const { tool, cmd } = setup();
	const ctx = createMockCtx();
	await seed(tool, [{ action: "create", subject: "owned", owner: "scout" }], ctx);
	await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);
	const text = String((await notifyCalls(ctx))[0]!.args[0]);
	assert.ok(text.includes("#1 owned @scout"));
});

test("/todos command — renders a task's activeForm and blockedBy suffix", async () => {
	const { tool, cmd } = setup();
	const ctx = createMockCtx();
	await seed(tool, [
		{ action: "create", subject: "dep" },
		{ action: "create", subject: "working", activeForm: "Wiring" },
		{ action: "update", id: 2, status: "in_progress" },
		{ action: "update", id: 2, addBlockedBy: [1] },
	], ctx);
	await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);
	const text = String((await notifyCalls(ctx))[0]!.args[0]);
	assert.ok(text.includes("#2 working (Wiring)"));
	assert.ok(text.includes("⛓ #1"));
});