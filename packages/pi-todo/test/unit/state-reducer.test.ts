import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TASKS, type Task } from "../../tool/types.ts";
import { isTransitionValid } from "../../state/invariants.ts";
import type { TaskState } from "../../state/state.ts";
import { applyTaskMutation } from "../../state/state-reducer.ts";

const emptyState = (): TaskState => ({ tasks: [], nextId: 1 });

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks: [...tasks],
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
	status: "pending",
	...overrides,
});

test("applyTaskMutation — create — rejects empty subject", () => {
	const result = applyTaskMutation(emptyState(), "create", { subject: "" });
	assert.deepEqual(result.op, { kind: "error", message: "subject required for create" });
	assert.equal(result.state.tasks.length, 0);
	assert.equal(result.state.nextId, 1);
});

test("applyTaskMutation — create — rejects dangling blockedBy", () => {
	const result = applyTaskMutation(emptyState(), "create", { subject: "x", blockedBy: [99] });
	assert.deepEqual(result.op, { kind: "error", message: "blockedBy: #99 not found" });
	assert.equal(result.state.nextId, 1);
});

test("applyTaskMutation — create — rejects deleted blockedBy", () => {
	const state = stateWith(task({ id: 1, subject: "done", status: "deleted" }));
	const result = applyTaskMutation(state, "create", { subject: "new", blockedBy: [1] });
	assert.deepEqual(result.op, { kind: "error", message: "blockedBy: #1 is deleted" });
});

test("applyTaskMutation — create — creates with next id and preserves immutability", () => {
	const state = emptyState();
	const result = applyTaskMutation(state, "create", { subject: "write tests" });
	assert.equal(result.state.tasks.length, 1);
	assert.equal(result.state.tasks[0].id, 1);
	assert.equal(result.state.tasks[0].subject, "write tests");
	assert.equal(result.state.tasks[0].status, "pending");
	assert.equal(result.state.nextId, 2);
	assert.notEqual(result.state.tasks, state.tasks);
	assert.deepEqual(result.op, { kind: "create", taskId: 1 });
});

test("applyTaskMutation — create — stamps createdAt and updatedAt (A1)", () => {
	const result = applyTaskMutation(emptyState(), "create", { subject: "stamped" });
	const created = result.state.tasks[0]!;
	assert.equal(typeof created.createdAt, "number");
	assert.equal(created.createdAt!, created.updatedAt!);
	// Short-namespaced task objects keep timestamps at the field tail.
	assert.ok(created.createdAt <= Date.now());
});

test("applyTaskMutation — create — copies description/activeForm/owner/metadata/blockedBy", () => {
	const dep = task({ id: 5, subject: "dep" });
	const state = stateWith(dep);
	const result = applyTaskMutation(state, "create", {
		subject: "s",
		description: "d",
		activeForm: "a",
		owner: "o",
		blockedBy: [5],
		metadata: { k: "v" },
	});
	const created = result.state.tasks.find((t) => t.id === 6)!;
	assert.equal(created.subject, "s");
	assert.equal(created.description, "d");
	assert.equal(created.activeForm, "a");
	assert.equal(created.owner, "o");
	assert.deepEqual(created.blockedBy, [5]);
	assert.deepEqual(created.metadata, { k: "v" });
	assert.equal(created.status, "pending");
	// Copies must not alias the input arrays/records.
	const params = { subject: "s", blockedBy: [5], metadata: { x: 1 } };
	const r2 = applyTaskMutation(state, "create", params);
	params.blockedBy!.push(6);
	params.metadata!.x = 2;
	assert.deepEqual(r2.state.tasks.find((t) => t.id === 6)!.blockedBy, [5]);
	assert.deepEqual(r2.state.tasks.find((t) => t.id === 6)!.metadata, { x: 1 });
});

test("applyTaskMutation — update — rejects id-only update", () => {
	const state = stateWith(task({ id: 1, subject: "x" }));
	const result = applyTaskMutation(state, "update", { id: 1 });
	assert.deepEqual(result.op, {
		kind: "error",
		message:
			"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
	});
});

test("applyTaskMutation — update — rejects missing id and unknown id", () => {
	assert.deepEqual(applyTaskMutation(emptyState(), "update", { subject: "x" }).op, {
		kind: "error",
		message: "id required for update",
	});
	const state = stateWith(task({ id: 1, subject: "x" }));
	assert.deepEqual(applyTaskMutation(state, "update", { id: 42, subject: "y" }).op, {
		kind: "error",
		message: "#42 not found",
	});
});

test("applyTaskMutation — update — rejects illegal transition completed → in_progress", () => {
	const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
	const result = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
	assert.deepEqual(result.op, {
		kind: "error",
		message:
			"illegal transition completed → in_progress (completed is terminal; create a new task for regressions)",
	});
});

test("applyTaskMutation — update — allows completed → deleted transition", () => {
	const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
	const result = applyTaskMutation(state, "update", { id: 1, status: "deleted" });
	assert.deepEqual(result.op, {
		kind: "update",
		id: 1,
		fromStatus: "completed",
		toStatus: "deleted",
		changed: true,
		changedFields: ["status"],
	});
	assert.equal(result.state.tasks[0].status, "deleted");
});

test("applyTaskMutation — update — flags a no-effect status update as changed:false", () => {
	const state = stateWith(task({ id: 1, subject: "x", status: "pending" }));
	const result = applyTaskMutation(state, "update", { id: 1, status: "pending" });
	assert.deepEqual(result.op, {
		kind: "update",
		id: 1,
		fromStatus: "pending",
		toStatus: "pending",
		changed: false,
		changedFields: [],
	});
});

test("applyTaskMutation — update — flags a re-sent identical field as changed:false", () => {
	const state = stateWith(task({ id: 1, subject: "x", description: "d" }));
	const result = applyTaskMutation(state, "update", { id: 1, subject: "x", description: "d" });
	assert.deepEqual(result.op.kind, "update");
	assert.equal((result.op as { changed: boolean }).changed, false);
});

test("applyTaskMutation — update — flags a blockedBy-only update as changed:true even when status is unchanged", () => {
	const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }));
	const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [2] });
	assert.deepEqual(result.op, {
		kind: "update",
		id: 1,
		fromStatus: "pending",
		toStatus: "pending",
		changed: true,
		changedFields: ["blockedBy"],
	});
});

test("applyTaskMutation — update — flags a subject-only update with existing deps as changed:true (blockedBy unchanged)", () => {
	const state = stateWith(task({ id: 1, subject: "old", blockedBy: [2] }), task({ id: 2, subject: "dep" }));
	const result = applyTaskMutation(state, "update", { id: 1, subject: "new" });
	assert.deepEqual(result.op, {
		kind: "update",
		id: 1,
		fromStatus: "pending",
		toStatus: "pending",
		changed: true,
		changedFields: ["subject"],
	});
	assert.deepEqual(result.state.tasks[0].blockedBy, [2]);
});

test("applyTaskMutation — update — flags swapping one dependency for another (same length) as changed:true", () => {
	const state = stateWith(
		task({ id: 1, subject: "a", blockedBy: [2] }),
		task({ id: 2, subject: "b" }),
		task({ id: 3, subject: "c" }),
	);
	const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2], addBlockedBy: [3] });
	assert.deepEqual(result.op, {
		kind: "update",
		id: 1,
		fromStatus: "pending",
		toStatus: "pending",
		changed: true,
		changedFields: ["blockedBy"],
	});
	assert.deepEqual(result.state.tasks[0].blockedBy, [3]);
});

test("applyTaskMutation — update — rejects self-block via addBlockedBy", () => {
	const state = stateWith(task({ id: 1, subject: "x" }));
	const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] });
	assert.deepEqual(result.op, { kind: "error", message: "cannot block #1 on itself" });
});

test("applyTaskMutation — update — rejects cycle in blockedBy graph", () => {
	const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
	const result = applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] });
	assert.deepEqual(result.op, { kind: "error", message: "addBlockedBy would create a cycle in the blockedBy graph" });
});

test("applyTaskMutation — update — drops blockedBy field when merged set becomes empty", () => {
	const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
	const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2] });
	assert.ok(!("blockedBy" in result.state.tasks[0]));
});

test("applyTaskMutation — update — drops metadata key when value is null", () => {
	const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
	const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
	assert.deepEqual(result.state.tasks[0].metadata, { b: 2 });
});

test("applyTaskMutation — update — sets and overwrites metadata keys when value is non-null", () => {
	const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
	const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: 99, c: 3 } });
	assert.deepEqual(result.state.tasks[0].metadata, { a: 99, b: 2, c: 3 });
});

test("applyTaskMutation — update — collapses metadata to undefined when every key is deleted", () => {
	const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1 } }));
	const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
	assert.ok(!("metadata" in result.state.tasks[0]));
});

test("applyTaskMutation — list — emits Op with includeDeleted flag and optional statusFilter", () => {
	const state = stateWith(
		task({ id: 1, subject: "a", status: "pending" }),
		task({ id: 2, subject: "b", status: "deleted" }),
	);
	const result = applyTaskMutation(state, "list", { includeDeleted: true, status: "deleted" });
	assert.deepEqual(result.op, { kind: "list", includeDeleted: true, statusFilter: "deleted" });
	assert.equal(result.state, state);
});

test("applyTaskMutation — delete — on already-deleted task errors", () => {
	const state = stateWith(task({ id: 1, subject: "x", status: "deleted" }));
	const result = applyTaskMutation(state, "delete", { id: 1 });
	assert.deepEqual(result.op, { kind: "error", message: "#1 is already deleted" });
});

test("applyTaskMutation — delete — emits Op with id + subject", () => {
	const state = stateWith(task({ id: 1, subject: "x" }));
	const result = applyTaskMutation(state, "delete", { id: 1 });
	assert.deepEqual(result.op, { kind: "delete", id: 1, subject: "x" });
	assert.equal(result.state.tasks[0].status, "deleted");
});

test("applyTaskMutation — delete — rejects unknown id", () => {
	assert.deepEqual(applyTaskMutation(emptyState(), "delete", { id: 9 }).op, { kind: "error", message: "#9 not found" });
});

test("applyTaskMutation — clear — emits Op with prior count and resets nextId to 1", () => {
	const state = stateWith(task({ id: 5, subject: "x" }));
	const result = applyTaskMutation(state, "clear", {});
	assert.deepEqual(result.op, { kind: "clear", count: 1 });
	assert.equal(result.state.tasks.length, 0);
	assert.equal(result.state.nextId, 1);
});

test("applyTaskMutation — get — emits Op with the resolved task", () => {
	const state = stateWith(task({ id: 1, subject: "alpha" }));
	const result = applyTaskMutation(state, "get", { id: 1 });
	assert.deepEqual(result.op, { kind: "get", task: state.tasks[0] });
});

test("applyTaskMutation — get — rejects unknown id", () => {
	assert.deepEqual(applyTaskMutation(emptyState(), "get", { id: 9 }).op, { kind: "error", message: "#9 not found" });
});

test("isTransitionValid — is idempotent on same→same", () => {
	assert.equal(isTransitionValid("completed", "completed"), true);
});

test("isTransitionValid — rejects completed → in_progress", () => {
	assert.equal(isTransitionValid("completed", "in_progress"), false);
});

test("isTransitionValid — allows completed → deleted", () => {
	assert.equal(isTransitionValid("completed", "deleted"), true);
});

test("applyTaskMutation — create — trims subject whitespace", () => {
	const result = applyTaskMutation(emptyState(), "create", { subject: "  write tests  " });
	assert.equal(result.state.tasks[0]!.subject, "write tests");
});

test("applyTaskMutation — create — dedupes blockedBy while preserving order", () => {
	const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }));
	const result = applyTaskMutation(state, "create", { subject: "c", blockedBy: [2, 1, 2] });
	assert.deepEqual(result.state.tasks[2]!.blockedBy, [2, 1]);
});

test("applyTaskMutation — create — rejects once MAX_TASKS visible tasks exist", () => {
	const tasks = Array.from({ length: MAX_TASKS }, (_, i) => task({ id: i + 1, subject: `t${i + 1}` }));
	const state = stateWith(...tasks);
	const result = applyTaskMutation(state, "create", { subject: "overflow" });
	assert.equal(result.op.kind, "error");
	assert.ok((result.op as { message: string }).message.includes(String(MAX_TASKS)));
	assert.equal(result.state.tasks.length, MAX_TASKS);
});

test("applyTaskMutation — create — tombstones do not count toward MAX_TASKS", () => {
	const tasks = [
		task({ id: 1, subject: "gone", status: "deleted" }),
		...Array.from({ length: MAX_TASKS - 1 }, (_, i) => task({ id: i + 2, subject: `t${i + 2}` })),
	];
	const state = stateWith(...tasks);
	const result = applyTaskMutation(state, "create", { subject: "fits" });
	assert.equal(result.op.kind, "create");
	assert.equal(result.state.tasks.at(-1)!.subject, "fits");
});

test("applyTaskMutation — update — trims subject and rejects blank", () => {
	const state = stateWith(task({ id: 1, subject: "old" }));
	const trimmed = applyTaskMutation(state, "update", { id: 1, subject: "  new  " });
	assert.equal(trimmed.state.tasks[0]!.subject, "new");
	const blank = applyTaskMutation(state, "update", { id: 1, subject: "   " });
	assert.deepEqual(blank.op, { kind: "error", message: "subject must be non-empty" });
});

test("applyTaskMutation — update — auto-demotes the previous in_progress task", () => {
	const state = stateWith(
		task({ id: 1, subject: "a", status: "in_progress" }),
		task({ id: 2, subject: "b" }),
	);
	const result = applyTaskMutation(state, "update", { id: 2, status: "in_progress" });
	assert.equal(result.state.tasks[0]!.status, "pending");
	assert.equal(result.state.tasks[1]!.status, "in_progress");
	assert.equal((result.op as { changed: boolean }).changed, true);
});

test("applyTaskMutation — update — demoting others still flags changed when the target was already in_progress", () => {
	const state = stateWith(
		task({ id: 1, subject: "a", status: "in_progress" }),
		task({ id: 2, subject: "b", status: "in_progress" }),
	);
	const result = applyTaskMutation(state, "update", { id: 2, status: "in_progress" });
	assert.equal(result.state.tasks[0]!.status, "pending");
	assert.equal(result.state.tasks[1]!.status, "in_progress");
	assert.equal((result.op as { changed: boolean }).changed, true);
});

test("applyTaskMutation — update — metadata compare is key-order independent", () => {
	const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
	const result = applyTaskMutation(state, "update", { id: 1, metadata: { b: 2, a: 1 } });
	assert.equal((result.op as { changed: boolean }).changed, false);
});
// ---------------------------------------------------------------------------
// A1: timestamp refresh semantics
// ---------------------------------------------------------------------------

test("A1 — effective update refreshes updatedAt but keeps createdAt", async () => {
	const { setTimeout: sleep } = await import("node:timers/promises");
	const created = applyTaskMutation(emptyState(), "create", { subject: "work" });
	const createdAt = created.state.tasks[0]!.createdAt!;
	await sleep(2);
	const updated = applyTaskMutation(created.state, "update", { id: 1, status: "in_progress" });
	const task = updated.state.tasks[0]!;
	assert.equal(task.createdAt, createdAt);
	assert.equal(typeof task.updatedAt, "number");
	assert.ok(task.updatedAt! > createdAt);
});

test("A1 — no-op update does not refresh updatedAt", async () => {
	const { setTimeout: sleep } = await import("node:timers/promises");
	const created = applyTaskMutation(emptyState(), "create", { subject: "work" });
	const updatedAt = created.state.tasks[0]!.updatedAt!;
	await sleep(2);
	const noop = applyTaskMutation(created.state, "update", { id: 1, subject: "work" });
	assert.equal(noop.state.tasks[0]!.updatedAt, updatedAt);
	assert.equal((noop.op as { changed: boolean }).changed, false);
});

// ---------------------------------------------------------------------------
// A2: delete sweeps blockedBy edges
// ---------------------------------------------------------------------------

test("A2 — delete removes the id from other tasks' blockedBy", () => {
	const state = stateWith(
		task({ id: 1, subject: "blocker" }),
		task({ id: 2, subject: "leaf", blockedBy: [1] }),
		task({ id: 3, subject: "multi", blockedBy: [1, 2] }),
	);
	const result = applyTaskMutation(state, "delete", { id: 1 });
	assert.equal(result.state.tasks[0]!.status, "deleted");
	assert.ok(!("blockedBy" in result.state.tasks[1]!));
	assert.deepEqual(result.state.tasks[2]!.blockedBy, [2]);
});

test("A2 — delete keeps the deleted task's own blockedBy for history", () => {
	const state = stateWith(task({ id: 1, subject: "dep" }), task({ id: 2, subject: "victim", blockedBy: [1] }));
	const result = applyTaskMutation(state, "delete", { id: 2 });
	const deleted = result.state.tasks[1]!;
	assert.equal(deleted.status, "deleted");
	assert.deepEqual(deleted.blockedBy, [1]);
	assert.equal(result.state.tasks[0]!.blockedBy, undefined);
});
