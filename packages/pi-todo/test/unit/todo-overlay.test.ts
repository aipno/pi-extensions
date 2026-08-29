import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockCtx, createMockPi, makeIdentityTheme } from "../helpers.ts";
import registerTodo from "../../index.ts";
import { __resetState, registerTodoTool, setActiveRenderSession, type TaskAction } from "../../todo.ts";
import { TodoOverlay } from "../../todo-overlay.ts";

const WIDGET_KEY = "pi-todos";

const identityTheme = makeIdentityTheme();

// ---------------------------------------------------------------------------
// Overlay widget harness (direct tool + overlay, no extension entry)
// ---------------------------------------------------------------------------

async function setupWithTool(actions: Array<Record<string, unknown>>, uiOverrides: Record<string, unknown> = {}) {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi as never);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx();
	for (const p of actions) {
		await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
			"tc",
			p,
			undefined,
			undefined,
			ctx,
		);
	}
	const ui = createMockCtx({ ui: uiOverrides }).ui;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	const setWidgetCall = ui.calls.find((c) => c.method === "setWidget");
	const factory = setWidgetCall?.args[1] as (
		tui: { requestRender: (force?: boolean) => void },
		theme: typeof identityTheme,
	) => { render: (w: number) => string[]; invalidate: () => void };
	const widget = factory({ requestRender: () => {} }, identityTheme);
	return { widget, tool, ui, overlay, ctx };
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

// ---------------------------------------------------------------------------
// Heading
// ---------------------------------------------------------------------------

test("overlay heading — includes 'Todos (completed/total)' count", async () => {
	const { widget } = await setupWithTool([
		{ action: "create", subject: "a" },
		{ action: "create", subject: "b" },
		{ action: "update", id: 1, status: "completed" },
	]);
	assert.ok(widget.render(200)[0]!.includes("Todos (1/2)"));
});

test("overlay heading — uses filled icon '●' when any task is active", async () => {
	const { widget } = await setupWithTool([{ action: "create", subject: "a" }]);
	assert.ok(widget.render(200)[0]!.includes("●"));
});

test("overlay heading — uses hollow icon '○' when all tasks are completed", async () => {
	const { widget } = await setupWithTool([
		{ action: "create", subject: "a" },
		{ action: "update", id: 1, status: "completed" },
	]);
	assert.ok(widget.render(200)[0]!.includes("○"));
});

// ---------------------------------------------------------------------------
// Natural-order rendering (no overflow)
// ---------------------------------------------------------------------------

test("overlay — renders one line per visible task plus heading, last row uses '└─'", async () => {
	const { widget } = await setupWithTool([
		{ action: "create", subject: "a" },
		{ action: "create", subject: "b" },
		{ action: "create", subject: "c" },
	]);
	const lines = widget.render(200);
	assert.equal(lines.length, 5); // heading + 3 + trailing spacer
	assert.ok(lines[1]!.includes("├─"));
	assert.ok(lines[2]!.includes("├─"));
	assert.ok(lines[3]!.includes("└─"));
	assert.equal(lines[4], ""); // trailing spacer below the panel
});

test("overlay — omits deleted tasks from the rendered output", async () => {
	const { widget } = await setupWithTool([
		{ action: "create", subject: "visible" },
		{ action: "create", subject: "gone" },
		{ action: "update", id: 2, status: "deleted" },
	]);
	const out = widget.render(200).join("\n");
	assert.ok(out.includes("visible"));
	assert.ok(!out.includes("gone"));
});

test("overlay — shows ids when any visible task carries a blockedBy reference", async () => {
	const { widget } = await setupWithTool([
		{ action: "create", subject: "dep" },
		{ action: "create", subject: "leaf" },
		{ action: "update", id: 2, addBlockedBy: [1] },
	]);
	const out = widget.render(200).join("\n");
	assert.ok(out.includes("#1"));
	assert.ok(out.includes("#2"));
	assert.ok(out.includes("⛓ #1"));
});

// ---------------------------------------------------------------------------
// Overflow behavior (row budget from config)
// ---------------------------------------------------------------------------

async function withConfig<T>(data: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-overlay-"));
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, JSON.stringify(data), "utf-8");
	const prev = process.env.PI_TODO_CONFIG;
	process.env.PI_TODO_CONFIG = file;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.PI_TODO_CONFIG;
		else process.env.PI_TODO_CONFIG = prev;
	}
}

test("overlay overflow — respects maxWidgetLines and reports hidden tasks with '+N more'", async () => {
	await withConfig({ maxWidgetLines: 4 }, async () => {
		const { widget } = await setupWithTool([
			{ action: "create", subject: "alpha" },
			{ action: "create", subject: "bravo" },
			{ action: "create", subject: "charlie" },
			{ action: "create", subject: "delta" },
			{ action: "create", subject: "echo" },
		]);
		const lines = widget.render(200);
		const out = lines.join("\n");
		// Budget 4 → heading + 2 task rows + "+3 more (3 pending)" summary.
		assert.ok(lines.some((l) => l.includes("+3 more (3 pending)")));
		assert.ok(out.includes("alpha"));
		assert.ok(out.includes("bravo"));
		assert.ok(!out.includes("charlie"));
		assert.ok(!out.includes("delta"));
		assert.ok(!out.includes("echo"));
	});
});

test("overlay overflow — drops completed tasks first when over budget", async () => {
	await withConfig({ maxWidgetLines: 4 }, async () => {
		const { widget } = await setupWithTool([
			{ action: "create", subject: "done1" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "create", subject: "done2" },
			{ action: "update", id: 2, status: "completed" },
			{ action: "create", subject: "pend1" },
			{ action: "create", subject: "pend2" },
			{ action: "create", subject: "pend3" },
		]);
		const out = widget.render(200).join("\n");
		assert.ok(out.includes("pend1"));
		assert.ok(out.includes("pend2"));
		assert.ok(!out.includes("pend3"));
		// hiddenCompleted = 2 → summary names them.
		assert.ok(out.includes("2 completed"));
	});
});

test("overlay — tool-output expansion mode shows all tasks regardless of budget", async () => {
	await withConfig({ maxWidgetLines: 3 }, async () => {
		const { widget } = await setupWithTool(
			[
				{ action: "create", subject: "a" },
				{ action: "create", subject: "b" },
				{ action: "create", subject: "c" },
				{ action: "create", subject: "d" },
			],
			{ getToolsExpanded: () => true },
		);
		const out = widget.render(200).join("\n");
		assert.ok(out.includes("a"));
		assert.ok(out.includes("b"));
		assert.ok(out.includes("c"));
		assert.ok(out.includes("d"));
		assert.ok(!out.includes("more"));
	});
});

// ---------------------------------------------------------------------------
// Completed-task display state (per-turn hiding)
// ---------------------------------------------------------------------------

test("completed tasks stay visible for the rest of the turn, then hide at the start of the next", async () => {
	const { widget, overlay } = await setupWithTool([
		{ action: "create", subject: "stay" },
		{ action: "update", id: 1, status: "completed" },
		{ action: "create", subject: "pending" },
	]);
	// First render: completed row visible with ✓.
	assert.ok(widget.render(200).join("\n").includes("stay"));

	// agent_start → hide completed tasks from previous turn.
	overlay.hideCompletedTasksFromPreviousTurn();
	const out = widget.render(200).join("\n");
	assert.ok(!out.includes("stay"));
	assert.ok(out.includes("pending"));
});

test("resetCompletedDisplayState() lets hidden completed tasks be shown once again", async () => {
	const { widget, overlay } = await setupWithTool([
		{ action: "create", subject: "done" },
		{ action: "update", id: 1, status: "completed" },
	]);
	// First render marks the completed row as pending-hide.
	assert.ok(widget.render(200).join("\n").includes("done"));
	overlay.hideCompletedTasksFromPreviousTurn();
	// All visible tasks are hidden → the widget renders nothing (auto-hide).
	assert.deepEqual(widget.render(200), []);
	// A replayed/replaced state resets the display bookkeeping → shown again.
	overlay.resetCompletedDisplayState();
	assert.ok(widget.render(200).join("\n").includes("done"));
});

test("hideCompletedTasksFromPreviousTurn() is a no-op when nothing is pending hide", async () => {
	const overlay = new TodoOverlay();
	assert.doesNotThrow(() => overlay.hideCompletedTasksFromPreviousTurn());
});

// ---------------------------------------------------------------------------
// Lifecycle (registration via setWidget contract)
// ---------------------------------------------------------------------------

test("lifecycle — update() with no UI ctx bound is a no-op", () => {
	const overlay = new TodoOverlay();
	assert.doesNotThrow(() => overlay.update());
});

test("lifecycle — update() with empty todos does not register a widget", () => {
	const overlay = new TodoOverlay();
	const ui = createMockCtx().ui;
	overlay.setUICtx(ui);
	overlay.update();
	assert.equal(ui.calls.filter((c) => c.method === "setWidget").length, 0);
});

test("lifecycle — first update() with non-empty todos registers the widget exactly once", async () => {
	const { ui } = await setupWithTool([{ action: "create", subject: "a" }]);
	const calls = ui.calls.filter((c) => c.method === "setWidget");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.args[0], WIDGET_KEY);
	assert.equal(typeof calls[0]!.args[1], "function");
	assert.deepEqual(calls[0]!.args[2], { placement: "aboveEditor" });
});

test("lifecycle — later updates call tui.requestRender instead of re-registering", async () => {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi as never);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx();
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "create", subject: "a" },
		undefined,
		undefined,
		ctx,
	);
	const ui = createMockCtx().ui;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	const factory = ui.calls.find((c) => c.method === "setWidget")!.args[1] as (
		tui: { requestRender: (force?: boolean) => void },
		theme: typeof identityTheme,
	) => unknown;
	let rendered = 0;
	factory({ requestRender: () => rendered++ }, identityTheme);
	overlay.update();
	assert.equal(ui.calls.filter((c) => c.method === "setWidget").length, 1);
	assert.equal(rendered, 1);
});

test("lifecycle — transition non-empty → empty unregisters the widget", async () => {
	const { tool, ui, overlay, ctx } = await setupWithTool([{ action: "create", subject: "a" }]);
	assert.equal(ui.calls.filter((c) => c.method === "setWidget").length, 1);
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "clear" },
		undefined,
		undefined,
		ctx,
	);
	overlay.update();
	const calls = ui.calls.filter((c) => c.method === "setWidget");
	assert.equal(calls.length, 2);
	assert.equal(calls[1]!.args[0], WIDGET_KEY);
	assert.equal(calls[1]!.args[1], undefined);
});

test("lifecycle — dispose() unregisters the widget exactly once", async () => {
	const { ui, overlay, widget, tool, ctx } = await setupWithTool([{ action: "create", subject: "a" }]);
	assert.ok(widget.render(200).length > 0);
	assert.equal(ui.calls.filter((c) => c.method === "setWidget").length, 1);
	overlay.dispose();
	const calls = ui.calls.filter((c) => c.method === "setWidget");
	assert.equal(calls.length, 2);
	assert.equal(calls[1]!.args[1], undefined);
	// Dispose is idempotent.
	overlay.dispose();
	assert.equal(ui.calls.filter((c) => c.method === "setWidget").length, 2);
	assert.equal(tool.name, "todo");
});

// ---------------------------------------------------------------------------
// Collapse toggle via the shortcut handler (extension entry, mock pi)
// ---------------------------------------------------------------------------

function registerExtension(config?: Record<string, unknown>) {
	__resetState();
	if (config) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-ext-"));
		const file = path.join(dir, "config.json");
		fs.writeFileSync(file, JSON.stringify(config), "utf-8");
		const prev = process.env.PI_TODO_CONFIG;
		process.env.PI_TODO_CONFIG = file;
		return { file, prev };
	}
	return { file: undefined, prev: undefined };
}

function restoreExtension(env: { file?: string; prev?: string }) {
	if (env.file) {
		if (env.prev === undefined) delete process.env.PI_TODO_CONFIG;
		else process.env.PI_TODO_CONFIG = env.prev;
	}
}

test("shortcut — registers 'ctrl+shift+t' with a description at factory scope", () => {
	const env = registerExtension();
	try {
		const { pi, captured } = createMockPi();
		registerTodo(pi as never);
		const shortcut = captured.shortcuts.get("ctrl+shift+t");
		assert.ok(shortcut);
		assert.ok(String(shortcut.description).includes("Collapse"));
	} finally {
		restoreExtension(env);
	}
});

test("shortcut — handler is a no-op in headless mode (!ctx.hasUI)", async () => {
	const env = registerExtension();
	try {
		const { pi, captured } = createMockPi();
		registerTodo(pi as never);
		const sessionStart = captured.events.get("session_start")?.[0];
		const toolEnd = captured.events.get("tool_execution_end")?.[0] as
			| ((event: { toolName: string; isError: boolean }) => Promise<void>)
			| undefined;
		const tool = captured.tools.get("todo")!;
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
			"tc",
			{ action: "create", subject: "a" },
			undefined,
			undefined,
			ctx,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		const handler = captured.shortcuts.get("ctrl+shift+t")!.handler;
		await handler({ hasUI: false } as never);
		// Overlay registered exactly once — no toggle caused a second setWidget.
		assert.equal(ctx.ui.calls.filter((c) => c.method === "setWidget").length, 1);
	} finally {
		restoreExtension(env);
	}
});

test("shortcut — handler is a no-op before any session_start created the overlay", async () => {
	const env = registerExtension();
	try {
		const { pi, captured } = createMockPi();
		registerTodo(pi as never);
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await captured.shortcuts.get("ctrl+shift+t")!.handler(ctx as never);
		assert.equal(ctx.ui.calls.filter((c) => c.method === "setWidget").length, 0);
	} finally {
		restoreExtension(env);
	}
});

test("shortcut — handler toggles the overlay when it is registered", async () => {
	const env = registerExtension();
	try {
		const { pi, captured } = createMockPi();
		registerTodo(pi as never);
		const sessionStart = captured.events.get("session_start")?.[0];
		const toolEnd = captured.events.get("tool_execution_end")?.[0] as
			| ((event: { toolName: string; isError: boolean }) => Promise<void>)
			| undefined;
		const tool = captured.tools.get("todo")!;
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
			"tc",
			{ action: "create", subject: "a" },
			undefined,
			undefined,
			ctx,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		const factory = ctx.ui.calls.find((c) => c.method === "setWidget")!.args[1] as (
			tui: { requestRender: (force?: boolean) => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		let renderedWithForce: boolean | undefined;
		const widget = factory({ requestRender: (force) => (renderedWithForce = force) }, identityTheme);

		// Before: expanded render carries the task, not the collapse hint.
		assert.ok(!widget.render(200).some((l) => l.includes("ctrl+shift+t to expand")));

		// Toggle → collapses; forced redraw on the height step.
		await captured.shortcuts.get("ctrl+shift+t")!.handler(ctx as never);
		assert.equal(renderedWithForce, true);
		assert.ok(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand")));

		// Toggle again → re-expands; hint gone.
		await captured.shortcuts.get("ctrl+shift+t")!.handler(ctx as never);
		assert.ok(!widget.render(200).some((l) => l.includes("ctrl+shift+t to expand")));
	} finally {
		restoreExtension(env);
	}
});

test("shortcut config — registers the configured key instead of the default", () => {
	const env = registerExtension({ collapseKey: "alt+o" });
	try {
		const { pi, captured } = createMockPi();
		registerTodo(pi as never);
		assert.ok(captured.shortcuts.has("alt+o"));
		assert.ok(!captured.shortcuts.has("ctrl+shift+t"));
	} finally {
		restoreExtension(env);
	}
});

test("shortcut config — skips registerShortcut entirely when collapseKey is 'off'", () => {
	const env = registerExtension({ collapseKey: "off" });
	try {
		const { pi, captured } = createMockPi();
		registerTodo(pi as never);
		assert.equal(captured.shortcuts.size, 0);
	} finally {
		restoreExtension(env);
	}
});

test("shortcut config — falls back to the default key when collapseKey is invalid", () => {
	const env = registerExtension({ collapseKey: "ctr+t" });
	try {
		const { pi, captured } = createMockPi();
		registerTodo(pi as never);
		assert.ok(captured.shortcuts.has("ctrl+shift+t"));
	} finally {
		restoreExtension(env);
	}
});
// ---------------------------------------------------------------------------
// B1: heading split counts / N1: truncated-status summary / B3: animation
// ---------------------------------------------------------------------------

test("overlay heading — B1: splits pending and in_progress counts", async () => {
	const { widget } = await setupWithTool([
		{ action: "create", subject: "a" },
		{ action: "create", subject: "b" },
		{ action: "create", subject: "c" },
		{ action: "update", id: 1, status: "in_progress", activeForm: "Working" },
		{ action: "update", id: 2, status: "completed" },
	]);
	const heading = widget.render(200)[0]!;
	assert.ok(heading.includes("Todos (1/3)"));
	assert.ok(heading.includes("1 in progress"));
	assert.ok(heading.includes("1 pending"));
});

test("overlay overflow — N1: truncated in_progress rows are summarized with their real status", async () => {
	// The tool's auto-demotion keeps at most one in_progress task, so a
	// multi-active board can only arise from replay/legacy state — seed the
	// store directly instead of through the tool.
	const multiActive = { // 5 in_progress tasks, budget 4 → 3 hidden in_progress
		tasks: [1, 2, 3, 4, 5].map((id) => ({
			id,
			subject: `busy${id}`,
			status: "in_progress" as const,
		})),
		nextId: 6,
	};
	await withConfig({ maxWidgetLines: 4 }, async () => {
		__resetState();
		setActiveRenderSession("test-session");
		const { replaceState } = await import("../../state/store.ts");
		replaceState("test-session", multiActive);
		const ui = createMockCtx().ui;
		const overlay = new TodoOverlay();
		overlay.setUICtx(ui);
		overlay.update();
		const factory = ui.calls.find((c) => c.method === "setWidget")!.args[1] as (
			tui: { requestRender: (force?: boolean) => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const widget = factory({ requestRender: () => {} }, identityTheme);
		const out = widget.render(200).join("\n");
		overlay.dispose();
		assert.ok(out.includes("+3 more (3 in progress)"));
		assert.ok(!out.includes("3 pending"));
	});
});

test("overlay — B3: in_progress row renders a spinner glyph from the frame counter", async () => {
	const { widget } = await setupWithTool([
		{ action: "create", subject: "work" },
		{ action: "update", id: 1, status: "in_progress", activeForm: "Building" },
	]);
	const out = widget.render(200).join("\n");
	// frame 0 → first spinner glyph; identity theme leaves the glyph verbatim.
	assert.ok(["◐", "◑", "◒", "◓"].some((g) => out.includes(g)));
});

test("overlay — B3: animation ticker runs only while an in_progress task exists", async () => {
	const { overlay, widget, tool, ctx } = await setupWithTool([
		{ action: "create", subject: "work" },
		{ action: "update", id: 1, status: "in_progress" },
	]);
	assert.equal(overlay.isAnimating(), true);
	widget.render(200); // first paint binds tui
	// Completing the task stops the ticker on the next update.
	await (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => unknown)(
		"tc",
		{ action: "update", id: 1, status: "completed" },
		undefined,
		undefined,
		ctx,
	);
	overlay.update();
	assert.equal(overlay.isAnimating(), false);
	// Dispose is idempotent and also drops the ticker.
	overlay.dispose();
	assert.equal(overlay.isAnimating(), false);
});
