import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionEntries, makeTodoToolResult, makeUserMessage } from "../helpers.ts";
import type { Task, TaskDetails } from "../../tool/types.ts";
import { isTaskDetails, replayFromBranch } from "../../state/replay.ts";

function buildBranch(snapshots: TaskDetails[]) {
	const messages = snapshots.map((s) => makeTodoToolResult(s));
	return buildSessionEntries([makeUserMessage("hi"), ...messages]);
}

const taskFixture = (id: number, subject: string, extra: Partial<Task> = {}): Task => ({
	id,
	subject,
	status: "pending",
	...extra,
});

test("isTaskDetails — rejects null and undefined", () => {
	assert.equal(isTaskDetails(null), false);
	assert.equal(isTaskDetails(undefined), false);
});

test("isTaskDetails — rejects primitives (string, number, boolean)", () => {
	assert.equal(isTaskDetails("oops"), false);
	assert.equal(isTaskDetails(42), false);
	assert.equal(isTaskDetails(true), false);
});

test("isTaskDetails — rejects objects missing tasks[] or nextId", () => {
	assert.equal(isTaskDetails({}), false);
	assert.equal(isTaskDetails({ tasks: "x", nextId: 1 }), false);
	assert.equal(isTaskDetails({ tasks: [], nextId: "1" }), false);
});

test("isTaskDetails — accepts well-formed snapshot envelopes", () => {
	assert.equal(isTaskDetails({ tasks: [], nextId: 1 }), true);
	assert.equal(isTaskDetails({ action: "create", params: {}, tasks: [], nextId: 1 }), true);
});

test("replayFromBranch — returns empty TaskState when branch has no todo toolResults", () => {
	const ctx = { sessionManager: { getBranch: () => buildSessionEntries([makeUserMessage("hi")]) } };
	const state = replayFromBranch(ctx as never);
	assert.deepEqual(state.tasks, []);
	assert.equal(state.nextId, 1);
});

test("replayFromBranch — replays the last snapshot (last-write-wins)", () => {
	const ctx = {
		sessionManager: {
			getBranch: () =>
				buildBranch([
					{ action: "create", params: {}, tasks: [taskFixture(1, "old")], nextId: 2 },
					{
						action: "create",
						params: {},
						tasks: [taskFixture(1, "old"), taskFixture(2, "new")],
						nextId: 3,
					},
				]),
		},
	};
	const state = replayFromBranch(ctx as never);
	assert.equal(state.tasks.length, 2);
	assert.equal(state.nextId, 3);
});

test("replayFromBranch — clones tasks so mutating the fixture does not mutate replayed state", () => {
	const fixture: Task = taskFixture(1, "original");
	const ctx = {
		sessionManager: {
			getBranch: () => buildBranch([{ action: "create", params: {}, tasks: [fixture], nextId: 2 }]),
		},
	};
	const state = replayFromBranch(ctx as never);
	assert.notEqual(state.tasks[0], fixture);
	assert.equal(state.tasks[0]!.subject, "original");
});

test("replayFromBranch — skips non-message entries in the branch (defensive type guard)", () => {
	const ctx = {
		sessionManager: {
			getBranch: () =>
				[
					{ type: "tool_call", call: { id: "x" } },
					...buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "kept")], nextId: 2 }]),
				] as never,
		},
	};
	const state = replayFromBranch(ctx as never);
	assert.equal(state.tasks.length, 1);
	assert.equal(state.tasks[0]!.subject, "kept");
	assert.equal(state.nextId, 2);
});

test("replayFromBranch — skips toolResult entries whose details fail isTaskDetails (corrupt-snapshot guard)", () => {
	const corrupt = {
		type: "message" as const,
		message: { role: "toolResult", toolName: "todo", details: { tasks: "not-an-array" } },
	};
	const ctx = {
		sessionManager: {
			getBranch: () =>
				[
					...buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "good")], nextId: 2 }]),
					corrupt,
				] as never,
		},
	};
	const state = replayFromBranch(ctx as never);
	assert.equal(state.tasks.length, 1);
	assert.equal(state.tasks[0]!.subject, "good");
});

test("replayFromBranch — ignores toolResults for other tool names", () => {
	const otherTool = { type: "message", message: { role: "toolResult", toolName: "search", details: { tasks: [] } } };
	const ctx = {
		sessionManager: {
			getBranch: () =>
				[
					...buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "y")], nextId: 2 }]),
					otherTool,
				] as never,
		},
	};
	const state = replayFromBranch(ctx as never);
	assert.equal(state.tasks.length, 1);
	assert.equal(state.tasks[0]!.subject, "y");
});

test("replayFromBranch — last-write-wins when getBranch() is a non-array iterable", () => {
	function* gen() {
		yield makeUserMessage("hi");
		yield makeTodoToolResult({ action: "create", params: {}, tasks: [taskFixture(1, "old")], nextId: 2 });
		yield makeTodoToolResult({
			action: "create",
			params: {},
			tasks: [taskFixture(1, "old"), taskFixture(2, "new")],
			nextId: 3,
		});
	}
	const ctx = { sessionManager: { getBranch: () => gen() } };
	const state = replayFromBranch(ctx as never);
	assert.equal(state.tasks.length, 2);
	assert.equal(state.tasks[1]!.subject, "new");
	assert.equal(state.nextId, 3);
});

test("replayFromBranch — returns a fresh empty TaskState when called with an empty branch", () => {
	const ctx1 = {
		sessionManager: {
			getBranch: () => buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "x")], nextId: 2 }]),
		},
	};
	assert.equal(replayFromBranch(ctx1 as never).nextId, 2);

	const ctx2 = { sessionManager: { getBranch: () => buildSessionEntries([makeUserMessage("hi")]) } };
	const fresh = replayFromBranch(ctx2 as never);
	assert.deepEqual(fresh.tasks, []);
	assert.equal(fresh.nextId, 1);
});
test("replayFromBranch — A1: legacy snapshots without timestamps replay cleanly (fields absent)", () => {
	const legacy: Task = taskFixture(5, "legacy", { status: "completed" });
	const ctx = {
		sessionManager: {
			getBranch: () =>
				buildBranch([
					{
						action: "create",
						params: {},
						tasks: [legacy],
						nextId: 6,
					},
				]),
		},
	};
	const state = replayFromBranch(ctx as never);
	assert.equal(state.tasks.length, 1);
	assert.equal(state.tasks[0]!.subject, "legacy");
	assert.equal(state.tasks[0]!.status, "completed");
	// Old snapshots simply lack the new optional fields — never invented values.
	assert.ok(!("createdAt" in state.tasks[0]!));
	assert.ok(!("updatedAt" in state.tasks[0]!));
});

test("replayFromBranch — A1: timestamps survive replay when the snapshot carries them", () => {
	const stamped = taskFixture(1, "fresh", { createdAt: 1000, updatedAt: 2000 });
	const ctx = {
		sessionManager: {
			getBranch: () => buildBranch([{ action: "create", params: {}, tasks: [stamped], nextId: 2 }]),
		},
	};
	const state = replayFromBranch(ctx as never);
	const replayed = state.tasks[0]! as Task & { createdAt: number; updatedAt: number };
	assert.equal(replayed.createdAt, 1000);
	assert.equal(replayed.updatedAt, 2000);
});
