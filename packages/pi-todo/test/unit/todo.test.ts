import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi, makeIdentityTheme } from "../helpers.ts";
import { __resetState, setActiveRenderSession, DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, registerTodoTool, TOOL_NAME } from "../../todo.ts";
import type { TaskDetails } from "../../tool/types.ts";

const identityTheme = makeIdentityTheme() as unknown as Theme;

function setup() {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi as never);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	return { tool, captured };
}

async function call(tool: Record<string, unknown>, params: Record<string, unknown>) {
	return (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, ctx: unknown) => unknown)(
		"tc",
		params,
		undefined,
		undefined,
		createMockCtx(),
	);
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

test("registerTodoTool — registers under the tool name 'todo' with the expected label and guidelines", () => {
	const { captured } = setup();
	const tool = captured.tools.get("todo")!;
	assert.equal(tool.name, "todo");
	assert.equal(tool.label, "Todo");
	assert.ok(String(tool.promptSnippet).includes("task list"));
	assert.ok(Array.isArray(tool.promptGuidelines));
	assert.ok((tool.promptGuidelines as string[]).length > 0);
});

test("registerTodoTool — exposes a typebox parameters schema declaring the six actions", () => {
	const { tool } = setup();
	const raw = JSON.stringify(tool.parameters);
	for (const action of ["create", "update", "list", "get", "delete", "clear"]) {
		assert.ok(raw.includes(action), `expected schema to declare ${action}`);
	}
});

test("registerTodoTool — runs sequentially and uses integer ids", () => {
	const { tool } = setup();
	assert.equal(tool.executionMode, "sequential");
	const raw = JSON.stringify(tool.parameters);
	assert.ok(raw.includes('"type":"integer"') || raw.includes('"type": "integer"'));
});

test("registerTodoTool — create → list returns the seeded row", async () => {
	const { tool } = setup();
	const r1 = await call(tool, { action: "create", subject: "first" });
	assert.equal((r1 as { details: TaskDetails }).details.action, "create");
	assert.ok(
		(r1 as { content: Array<{ text: string }> }).content[0]!.text.includes("#1 [pending] first"),
		"expected mutation result to include the compact board",
	);
	const r2 = (await call(tool, { action: "list" })) as { content: Array<{ text: string }> };
	assert.ok(r2.content[0]!.text.includes("first"));
});

test("registerTodoTool — clear resets module state and nextId", async () => {
	const { tool } = setup();
	await call(tool, { action: "create", subject: "a" });
	await call(tool, { action: "create", subject: "b" });
	const r = (await call(tool, { action: "clear" })) as { details: TaskDetails };
	assert.deepEqual(r.details.tasks, []);
	assert.equal(r.details.nextId, 1);
});

test("renderCall — create action emits 'todo +' and includes the subject", () => {
	const { tool } = setup();
	const node = (tool.renderCall as (a: unknown, t: Theme, c: unknown) => Text)(
		{ action: "create", subject: "hello" },
		identityTheme,
		undefined,
	);
	assert.ok(node instanceof Text);
	assert.ok((node as unknown as { text: string }).text.includes("todo "));
	assert.ok((node as unknown as { text: string }).text.includes("+"));
	assert.ok((node as unknown as { text: string }).text.includes("hello"));
});

test("renderCall — update action renders '#id' when the task has not been registered yet", () => {
	const { tool } = setup();
	const node = (tool.renderCall as (a: unknown, t: Theme, c: unknown) => Text)(
		{ action: "update", id: 42 },
		identityTheme,
		undefined,
	);
	assert.ok((node as unknown as { text: string }).text.includes("#42"));
});

test("renderCall — update action renders the task subject when seeded", async () => {
	const { tool } = setup();
	await call(tool, { action: "create", subject: "seeded-subject" });
	const node = (tool.renderCall as (a: unknown, t: Theme, c: unknown) => Text)(
		{ action: "update", id: 1 },
		identityTheme,
		undefined,
	);
	assert.ok((node as unknown as { text: string }).text.includes("seeded-subject"));
});

test("renderCall — list action with a status filter renders the humanized status label", () => {
	const { tool } = setup();
	const node = (tool.renderCall as (a: unknown, t: Theme, c: unknown) => Text)(
		{ action: "list", status: "in_progress" },
		identityTheme,
		undefined,
	);
	assert.ok((node as unknown as { text: string }).text.includes("in progress"));
});

test("renderCall — clear action renders only the base prefix + glyph", () => {
	const { tool } = setup();
	const node = (tool.renderCall as (a: unknown, t: Theme, c: unknown) => Text)(
		{ action: "clear" },
		identityTheme,
		undefined,
	);
	assert.ok((node as unknown as { text: string }).text.includes("∅"));
});

test("renderResult — create renders the new task's status label (pending)", async () => {
	const { tool } = setup();
	const r = await call(tool, { action: "create", subject: "a" });
	const node = (tool.renderResult as (r: unknown, o: unknown, t: Theme, c: unknown) => Text)(
		r,
		{},
		identityTheme,
		undefined,
	);
	const text = (node as unknown as { text: string }).text;
	assert.ok(text.includes("pending"));
	assert.ok(text.includes("○"));
});

test("renderResult — update renders the transitioned status (in progress)", async () => {
	const { tool } = setup();
	await call(tool, { action: "create", subject: "a" });
	const r = await call(tool, { action: "update", id: 1, status: "in_progress" });
	const node = (tool.renderResult as (r: unknown, o: unknown, t: Theme, c: unknown) => Text)(
		r,
		{},
		identityTheme,
		undefined,
	);
	const text = (node as unknown as { text: string }).text;
	assert.ok(text.includes("in progress"));
	assert.ok(text.includes("◐"));
});

test("renderResult — delete renders the deleted-tombstone label", async () => {
	const { tool } = setup();
	await call(tool, { action: "create", subject: "a" });
	const r = await call(tool, { action: "delete", id: 1 });
	const node = (tool.renderResult as (r: unknown, o: unknown, t: Theme, c: unknown) => Text)(
		r,
		{},
		identityTheme,
		undefined,
	);
	const text = (node as unknown as { text: string }).text;
	assert.ok(text.includes("deleted"));
	assert.ok(text.includes("⊘"));
});

test("renderResult — list/get/clear render the plain '✓' fallback (no status leakage)", async () => {
	const { tool } = setup();
	await call(tool, { action: "create", subject: "a" });
	for (const p of [{ action: "list" }, { action: "get", id: 1 }, { action: "clear" }]) {
		const r = await call(tool, p);
		const node = (tool.renderResult as (r: unknown, o: unknown, t: Theme, c: unknown) => Text)(
			r,
			{},
			identityTheme,
			undefined,
		);
		assert.ok((node as unknown as { text: string }).text.includes("✓"), `expected ✓ for ${p.action}`);
	}
});

test("renderResult — missing details falls back to plain '✓'", () => {
	const { tool } = setup();
	const node = (tool.renderResult as (r: unknown, o: unknown, t: Theme, c: unknown) => Text)(
		{ content: [], details: undefined },
		{},
		identityTheme,
		undefined,
	);
	assert.ok((node as unknown as { text: string }).text.includes("✓"));
});

// ---------------------------------------------------------------------------
// Guidance overrides (via the PI_TODO_CONFIG env override; the reference writes
// to ~/.config — we point the loader at a temp file instead).
// ---------------------------------------------------------------------------

const DEFAULT_GUIDELINES_LENGTH = DEFAULT_PROMPT_GUIDELINES.length;

function withConfig<T>(data: Record<string, unknown>, fn: () => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-guidance-"));
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
	const prev = process.env.PI_TODO_CONFIG;
	process.env.PI_TODO_CONFIG = file;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.PI_TODO_CONFIG;
		else process.env.PI_TODO_CONFIG = prev;
	}
}

test("guidance — uses built-in defaults when no config file exists", () => {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi as never);
	const tool = captured.tools.get(TOOL_NAME)!;
	assert.equal(tool.promptSnippet, DEFAULT_PROMPT_SNIPPET);
	assert.equal((tool.promptGuidelines as string[]).length, DEFAULT_GUIDELINES_LENGTH);
});

test("guidance — uses built-in defaults when config has no guidance field", () => {
	withConfig({ otherField: true }, () => {
		__resetState();
		const { pi, captured } = createMockPi();
		registerTodoTool(pi as never);
		const tool = captured.tools.get(TOOL_NAME)!;
		assert.equal(tool.promptSnippet, DEFAULT_PROMPT_SNIPPET);
	});
});

test("guidance — overrides promptSnippet with valid value", () => {
	withConfig({ guidance: { promptSnippet: "Custom todo snippet" } }, () => {
		__resetState();
		const { pi, captured } = createMockPi();
		registerTodoTool(pi as never);
		const tool = captured.tools.get(TOOL_NAME)!;
		assert.equal(tool.promptSnippet, "Custom todo snippet");
		assert.equal((tool.promptGuidelines as string[]).length, DEFAULT_GUIDELINES_LENGTH);
	});
});

test("guidance — overrides promptGuidelines with valid value", () => {
	withConfig({ guidance: { promptGuidelines: ["Rule one", "Rule two"] } }, () => {
		__resetState();
		const { pi, captured } = createMockPi();
		registerTodoTool(pi as never);
		const tool = captured.tools.get(TOOL_NAME)!;
		assert.equal(tool.promptSnippet, DEFAULT_PROMPT_SNIPPET);
		assert.deepEqual(tool.promptGuidelines, ["Rule one", "Rule two"]);
	});
});

test("guidance — falls back to defaults on empty promptSnippet", () => {
	withConfig({ guidance: { promptSnippet: "" } }, () => {
		__resetState();
		const { pi, captured } = createMockPi();
		registerTodoTool(pi as never);
		const tool = captured.tools.get(TOOL_NAME)!;
		assert.equal(tool.promptSnippet, DEFAULT_PROMPT_SNIPPET);
	});
});

test("guidance — falls back to defaults on wrong types", () => {
	withConfig({ guidance: { promptSnippet: 123, promptGuidelines: "not-array" } }, () => {
		__resetState();
		const { pi, captured } = createMockPi();
		registerTodoTool(pi as never);
		const tool = captured.tools.get(TOOL_NAME)!;
		assert.equal(tool.promptSnippet, DEFAULT_PROMPT_SNIPPET);
		assert.equal((tool.promptGuidelines as string[]).length, DEFAULT_GUIDELINES_LENGTH);
	});
});

test("guidance — falls back to defaults on promptGuidelines with empty string item", () => {
	withConfig({ guidance: { promptGuidelines: ["valid", ""] } }, () => {
		__resetState();
		const { pi, captured } = createMockPi();
		registerTodoTool(pi as never);
		const tool = captured.tools.get(TOOL_NAME)!;
		assert.equal((tool.promptGuidelines as string[]).length, DEFAULT_GUIDELINES_LENGTH);
	});
});