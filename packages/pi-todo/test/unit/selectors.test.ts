import { test } from "node:test";
import assert from "node:assert/strict";
import {
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTaskSubjectById,
	selectTasksByStatus,
	selectTodoCounts,
	selectVisibleTasks,
} from "../../state/selectors.ts";
import type { TaskState } from "../../state/state.ts";
import type { Task } from "../../tool/types.ts";

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
	status: "pending",
	...overrides,
});

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks,
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

test("selectVisibleTasks — drops deleted tombstones", () => {
	const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", status: "deleted" }));
	assert.deepEqual(
		selectVisibleTasks(state).map((t) => t.id),
		[1],
	);
});

test("selectTasksByStatus / selectTodoCounts — group and count visible tasks", () => {
	const state = stateWith(
		task({ id: 1, subject: "a" }),
		task({ id: 2, subject: "b", status: "in_progress" }),
		task({ id: 3, subject: "c", status: "completed" }),
		task({ id: 4, subject: "d", status: "deleted" }),
	);
	const groups = selectTasksByStatus(state);
	assert.equal(groups.pending.length, 1);
	assert.equal(groups.inProgress.length, 1);
	assert.equal(groups.completed.length, 1);
	assert.deepEqual(selectTodoCounts(state), { total: 3, pending: 1, inProgress: 1, completed: 1 });
});

test("selectShowTaskIds — true only when a visible task has blockedBy", () => {
	assert.equal(selectShowTaskIds(stateWith(task({ id: 1, subject: "a" }))), false);
	assert.equal(
		selectShowTaskIds(stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] }))),
		true,
	);
	assert.equal(
		selectShowTaskIds(stateWith(task({ id: 1, subject: "a", status: "deleted", blockedBy: [2] }))),
		false,
	);
});

test("selectHasActive — true for pending or in_progress", () => {
	assert.equal(selectHasActive(stateWith(task({ id: 1, subject: "a", status: "completed" }))), false);
	assert.equal(selectHasActive(stateWith(task({ id: 1, subject: "a" }))), true);
	assert.equal(selectHasActive(stateWith(task({ id: 1, subject: "a", status: "in_progress" }))), true);
});

test("selectTaskSubjectById — resolves a subject or undefined", () => {
	const state = stateWith(task({ id: 7, subject: "lucky" }));
	assert.equal(selectTaskSubjectById(state, 7), "lucky");
	assert.equal(selectTaskSubjectById(state, 1), undefined);
});

test("selectOverlayLayout — fits entirely when at or under budget", () => {
	const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }));
	assert.deepEqual(selectOverlayLayout(state, 2), {
		visible: state.tasks,
		hiddenCompleted: 0,
		truncatedPending: 0,
		truncatedInProgress: 0,
	});
});

test("selectOverlayLayout — drops completed first and keeps the latest completed when some still fit", () => {
	const state = stateWith(
		task({ id: 1, subject: "old-done", status: "completed" }),
		task({ id: 2, subject: "mid-done", status: "completed" }),
		task({ id: 3, subject: "new-done", status: "completed" }),
		task({ id: 4, subject: "pend" }),
	);
	// 4 visible > budget 2 → innerBudget 1. 1 pending fits, no room for completed.
	const noRoom = selectOverlayLayout(state, 2);
	assert.deepEqual(
		noRoom.visible.map((t) => t.subject),
		["pend"],
	);
	assert.equal(noRoom.hiddenCompleted, 3);
	assert.equal(noRoom.truncatedPending, 0);
	assert.equal(noRoom.truncatedInProgress, 0);

	// budget 3 → innerBudget 2. 1 pending + 1 completed. Keep the latest completed (new-done).
	const someRoom = selectOverlayLayout(state, 3);
	assert.deepEqual(
		someRoom.visible.map((t) => t.subject),
		["new-done", "pend"],
	);
	assert.equal(someRoom.hiddenCompleted, 2);
	assert.equal(someRoom.truncatedPending, 0);
	assert.equal(someRoom.truncatedInProgress, 0);
});

test("selectOverlayLayout — truncates the unfinished tail after dropping every completed task", () => {
	const state = stateWith(
		task({ id: 1, subject: "done", status: "completed" }),
		task({ id: 2, subject: "a" }),
		task({ id: 3, subject: "b" }),
		task({ id: 4, subject: "c" }),
	);
	const layout = selectOverlayLayout(state, 3);
	assert.deepEqual(
		layout.visible.map((t) => t.subject),
		["a", "b"],
	);
	assert.equal(layout.hiddenCompleted, 1);
	assert.equal(layout.truncatedPending, 1);
	assert.equal(layout.truncatedInProgress, 0);
});

test("selectOverlayLayout — N1: truncated tail splits pending vs in_progress", () => {
	// The original bug: 5 in_progress tasks overflowing a budget of 4 were
	// summarized as "2 pending" although both hidden rows were in_progress.
	const state = stateWith(
		task({ id: 1, subject: "busy1", status: "in_progress" }),
		task({ id: 2, subject: "busy2", status: "in_progress" }),
		task({ id: 3, subject: "busy3", status: "in_progress" }),
		task({ id: 4, subject: "busy4", status: "in_progress" }),
		task({ id: 5, subject: "busy5", status: "in_progress" }),
	);
	const layout = selectOverlayLayout(state, 4);
	assert.deepEqual(
		layout.visible.map((t) => t.subject),
		["busy1", "busy2", "busy3"],
	);
	assert.equal(layout.hiddenCompleted, 0);
	assert.equal(layout.truncatedPending, 0);
	assert.equal(layout.truncatedInProgress, 2);
	// Mixed tail splits both counts: 5 tasks, budget 4 → visible 3, truncated = #4 (pending) + #5 (in_progress).
	const mixed = stateWith(
		task({ id: 1, subject: "p1" }),
		task({ id: 2, subject: "busy1", status: "in_progress" }),
		task({ id: 3, subject: "busy2", status: "in_progress" }),
		task({ id: 4, subject: "p2" }),
		task({ id: 5, subject: "busy3", status: "in_progress" }),
	);
	const mixedLayout = selectOverlayLayout(mixed, 4);
	assert.deepEqual(
		mixedLayout.visible.map((t) => t.subject),
		["p1", "busy1", "busy2"],
	);
	assert.equal(mixedLayout.truncatedPending, 1);
	assert.equal(mixedLayout.truncatedInProgress, 1);
});
