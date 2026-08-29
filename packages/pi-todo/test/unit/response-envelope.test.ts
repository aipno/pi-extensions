import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskState } from "../../state/state.ts";
import type { Op } from "../../state/state-reducer.ts";
import { buildToolResult, formatContent } from "../../tool/response-envelope.ts";
import type { Task } from "../../tool/types.ts";

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks,
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

const t = (over: Partial<Task> & { id: number; subject: string }): Task => ({ status: "pending", ...over });

test("formatContent — create — 'Created #id: subject (pending)' plus compact board", () => {
	const state = stateWith(t({ id: 1, subject: "alpha" }));
	assert.equal(
		formatContent({ kind: "create", taskId: 1 }, state),
		"Created #1: alpha (pending)\n#1 [pending] alpha",
	);
});

test("formatContent — update — emits transition tuple when statuses differ", () => {
	const state = stateWith(t({ id: 1, subject: "x", status: "in_progress" }));
	const op: Op = {
		kind: "update",
		id: 1,
		fromStatus: "pending",
		toStatus: "in_progress",
		changed: true,
		changedFields: ["status"],
	};
	assert.equal(formatContent(op, state), "Updated #1 (pending → in_progress) · changed: status\n#1 [in_progress] x");
});

test("formatContent — update — omits transition when from === to but fields changed", () => {
	const state = stateWith(t({ id: 1, subject: "x" }));
	const op: Op = {
		kind: "update",
		id: 1,
		fromStatus: "pending",
		toStatus: "pending",
		changed: true,
		changedFields: ["subject", "activeForm"],
	};
	assert.equal(formatContent(op, state), "Updated #1 · changed: subject, activeForm\n#1 [pending] x");
});

test("formatContent — update — reports 'No change' when changed is false", () => {
	const state = stateWith(t({ id: 1, subject: "x" }));
	const op: Op = {
		kind: "update",
		id: 1,
		fromStatus: "pending",
		toStatus: "pending",
		changed: false,
		changedFields: [],
	};
	assert.equal(
		formatContent(op, state),
		"No change: #1 already matches the requested values (status: pending)\n#1 [pending] x",
	);
});

test("formatContent — delete — 'Deleted #id: subject'", () => {
	const state = stateWith(t({ id: 1, subject: "ship", status: "deleted" }));
	assert.equal(formatContent({ kind: "delete", id: 1, subject: "ship" }, state), "Deleted #1: ship");
});

test("formatContent — clear — emits prior count", () => {
	assert.equal(formatContent({ kind: "clear", count: 4 }, stateWith()), "Cleared 4 tasks");
});

test("formatContent — list — 'No tasks' when filtered view is empty", () => {
	const state = stateWith(t({ id: 1, subject: "x", status: "deleted" }));
	assert.equal(formatContent({ kind: "list", includeDeleted: false }, state), "No tasks");
});

test("formatContent — list — joins per-task '[status] #id subject' lines", () => {
	const state = stateWith(
		t({ id: 1, subject: "a" }),
		t({ id: 2, subject: "b", status: "in_progress", activeForm: "Building" }),
	);
	assert.equal(formatContent({ kind: "list", includeDeleted: false }, state), "[pending] #1 a\n[in_progress] #2 b (Building)");
});

test("formatContent — get — multi-line task block with description/blockedBy/owner", () => {
	const state = stateWith(
		t({ id: 1, subject: "root" }),
		t({ id: 2, subject: "leaf", description: "details", blockedBy: [1], owner: "Sergii" }),
	);
	const op: Op = { kind: "get", task: state.tasks[1]! };
	assert.equal(formatContent(op, state), "#2 [pending] leaf\n  description: details\n  blockedBy: #1\n  owner: Sergii");
});

test("formatContent — get — emits 'blocks: #id,…' reverse-edge line when other tasks block on it", () => {
	const state = stateWith(
		t({ id: 1, subject: "ship", blockedBy: [2, 3] }),
		t({ id: 2, subject: "test" }),
		t({ id: 3, subject: "lint" }),
	);
	const op: Op = { kind: "get", task: state.tasks[1]! };
	assert.equal(formatContent(op, state), "#2 [pending] test\n  blocks: #1");
});

test("formatContent — get — emits activeForm line for in_progress task", () => {
	const state = stateWith(t({ id: 1, subject: "build", status: "in_progress", activeForm: "Building" }));
	const op: Op = { kind: "get", task: state.tasks[0]! };
	assert.equal(formatContent(op, state), "#1 [in_progress] build\n  activeForm: Building");
});

test("formatContent — list — statusFilter narrows to a single status", () => {
	const state = stateWith(
		t({ id: 1, subject: "a", status: "pending" }),
		t({ id: 2, subject: "b", status: "in_progress", activeForm: "Working" }),
		t({ id: 3, subject: "c", status: "completed" }),
	);
	assert.equal(
		formatContent({ kind: "list", includeDeleted: false, statusFilter: "in_progress" }, state),
		"[in_progress] #2 b (Working)",
	);
});

test("formatContent — list — N2: statusFilter=deleted no longer requires includeDeleted", () => {
	const state = stateWith(t({ id: 1, subject: "x", status: "deleted" }));
	assert.equal(
		formatContent({ kind: "list", includeDeleted: false, statusFilter: "deleted" }, state),
		"[deleted] #1 x",
	);
});

test("formatContent — list — includeDeleted=true surfaces tombstoned rows", () => {
	const state = stateWith(t({ id: 1, subject: "x", status: "deleted" }));
	assert.equal(formatContent({ kind: "list", includeDeleted: true }, state), "[deleted] #1 x");
});

test("formatContent — list — '⛓ #id,…' suffix appears when task has blockedBy", () => {
	const state = stateWith(t({ id: 1, subject: "leaf" }), t({ id: 2, subject: "task", blockedBy: [1] }));
	assert.equal(formatContent({ kind: "list", includeDeleted: false }, state), "[pending] #1 leaf\n[pending] #2 task ⛓ #1");
});

test("formatContent — list — A3: pending-first ordering groups by status (stable within group)", () => {
	const state = stateWith(
		t({ id: 1, subject: "old-done", status: "completed" }),
		t({ id: 2, subject: "first" }),
		t({ id: 3, subject: "busy", status: "in_progress" }),
		t({ id: 4, subject: "second" }),
		t({ id: 5, subject: "new-done", status: "completed" }),
	);
	assert.equal(
		formatContent({ kind: "list", includeDeleted: false }, state),
		"[pending] #2 first\n[pending] #4 second\n[in_progress] #3 busy\n[completed] #1 old-done\n[completed] #5 new-done",
	);
});

test("formatContent — list — A3: completed/deleted blockers are dropped from the '⛓' suffix", () => {
	const state = stateWith(
		t({ id: 1, subject: "live" }),
		t({ id: 2, subject: "done", status: "completed" }),
		t({ id: 3, subject: "gone", status: "deleted" }),
		t({ id: 4, subject: "leaf", blockedBy: [1, 2, 3] }),
	);
	assert.equal(
		formatContent({ kind: "list", includeDeleted: false }, state),
		"[pending] #1 live\n[pending] #4 leaf ⛓ #1\n[completed] #2 done",
	);
});

test("formatContent — create — defensive fallback when op.taskId is unknown to state", () => {
	assert.equal(formatContent({ kind: "create", taskId: 999 }, stateWith()), "Created #999");
});

test("formatContent — create — board includes owner, activeForm, and blockedBy", () => {
	const state = stateWith(
		t({ id: 1, subject: "dep" }),
		t({
			id: 2,
			subject: "leaf",
			status: "in_progress",
			activeForm: "Wiring",
			blockedBy: [1],
			owner: "worker",
		}),
	);
	assert.equal(
		formatContent({ kind: "create", taskId: 2 }, state),
		"Created #2: leaf (pending)\n#1 [pending] dep\n#2 [in_progress] leaf (Wiring) ⛓ #1 @worker",
	);
});

test("formatContent — error — 'Error: <message>'", () => {
	assert.equal(
		formatContent({ kind: "error", message: "subject required for create" }, stateWith()),
		"Error: subject required for create",
	);
});

// ---------------------------------------------------------------------------
// buildToolResult
// ---------------------------------------------------------------------------

test("buildToolResult — envelope.details mirrors the canonical TaskDetails shape on success", () => {
	const state = stateWith(t({ id: 1, subject: "alpha" }));
	const env = buildToolResult("create", { subject: "alpha" }, state, { kind: "create", taskId: 1 });
	assert.deepEqual(env, {
		content: [{ type: "text", text: "Created #1: alpha (pending)\n#1 [pending] alpha" }],
		details: { action: "create", params: { subject: "alpha" }, tasks: state.tasks, nextId: state.nextId },
	});
});

test("buildToolResult — envelope.details carries error message on op.kind === 'error'", () => {
	const env = buildToolResult("create", { subject: "" }, stateWith(), {
		kind: "error",
		message: "subject required for create",
	});
	assert.equal(env.details.error, "subject required for create");
	assert.equal(env.content[0]!.text, "Error: subject required for create");
});

// ---------------------------------------------------------------------------
// Control characters in model-controlled fields
// ---------------------------------------------------------------------------

test("formatContent — get — strips escape sequences from subject, description, and owner", () => {
	const state = stateWith(
		t({ id: 1, subject: "safe\u001b[2J\u001b[Hsubject", description: "line1\nline2", owner: "who\u009b31mami" }),
	);
	const op: Op = { kind: "get", task: state.tasks[0]! };
	assert.equal(formatContent(op, state), "#1 [pending] safesubject\n  description: line1 line2\n  owner: whoami");
});

test("formatContent — create/list — strips escape sequences from the echoed subject and activeForm", () => {
	const state = stateWith(
		t({ id: 1, subject: "evil\u001b[31m", status: "in_progress", activeForm: "clear\u001b[2Jing" }),
	);
	assert.equal(
		formatContent({ kind: "create", taskId: 1 }, state),
		"Created #1: evil (pending)\n#1 [in_progress] evil (clearing)",
	);
	assert.equal(formatContent({ kind: "list", includeDeleted: false }, state), "[in_progress] #1 evil (clearing)");
});