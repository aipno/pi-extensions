import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../../tool/types.ts";
import { deriveBlocks, detectCycle } from "../../state/task-graph.ts";

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
	status: "pending",
	...overrides,
});

test("detectCycle — detects direct cycle", () => {
	const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] })];
	assert.equal(detectCycle(tasks, 1, [2]), true);
});

test("detectCycle — returns false for acyclic graph", () => {
	const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] })];
	assert.equal(detectCycle(tasks, 2, [1]), false);
});

test("detectCycle — skips idempotent merges (dependency already present)", () => {
	const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] })];
	// Merging [1] into task 2 which already blocks on 1 must not create a cycle.
	assert.equal(detectCycle(tasks, 2, [1]), false);
});

test("detectCycle — indirect cycle through the graph", () => {
	const tasks = [
		task({ id: 1, subject: "a", blockedBy: [3] }),
		task({ id: 2, subject: "b" }),
		task({ id: 3, subject: "c", blockedBy: [2] }),
	];
	// 2 → would block on 1 → 3 → 2: cycle.
	assert.equal(detectCycle(tasks, 2, [1]), true);
});

test("deriveBlocks — returns an empty map when no task has blockedBy", () => {
	const tasks: Task[] = [
		{ id: 1, subject: "a", status: "pending" },
		{ id: 2, subject: "b", status: "pending" },
	];
	assert.equal(deriveBlocks(tasks).size, 0);
});

test("deriveBlocks — inverts blockedBy into a blocks map", () => {
	const tasks: Task[] = [
		{ id: 1, subject: "root", status: "pending" },
		{ id: 2, subject: "dep", status: "pending", blockedBy: [1] },
		{ id: 3, subject: "dep2", status: "pending", blockedBy: [1, 2] },
	];
	const blocks = deriveBlocks(tasks);
	assert.deepEqual(blocks.get(1), [2, 3]);
	assert.deepEqual(blocks.get(2), [3]);
	assert.equal(blocks.get(3), undefined);
});