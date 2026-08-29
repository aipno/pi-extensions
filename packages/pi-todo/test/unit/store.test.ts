import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "../../state/state.ts";
import {
	__resetState,
	clearActiveRenderSession,
	commitState,
	evictSession,
	getActiveRenderSession,
	getNextId,
	getRenderState,
	getState,
	getTodos,
	replaceState,
	setActiveRenderSession,
	sid,
} from "../../state/store.ts";

const SID = "s1";

function makeTask(id: number, subject = `t${id}`): Task {
	return { id, subject, status: "pending" };
}

test("__resetState() restores EMPTY_STATE shape (independent of EMPTY_STATE.tasks identity)", () => {
	__resetState();
	assert.deepEqual(getTodos(SID), EMPTY_STATE.tasks);
	assert.equal(getNextId(SID), EMPTY_STATE.nextId);
	// Reset clones — must NOT alias EMPTY_STATE.tasks (else mutations leak).
	assert.notEqual(getTodos(SID), EMPTY_STATE.tasks);
});

test("getTodos(sid) returns the live tasks reference (read-only typed)", () => {
	__resetState();
	const next: TaskState = { tasks: [makeTask(1)], nextId: 2 };
	commitState(SID, next);
	assert.equal(getTodos(SID), next.tasks);
});

test("getNextId(sid) reflects the current slot value", () => {
	__resetState();
	commitState(SID, { tasks: [], nextId: 42 });
	assert.equal(getNextId(SID), 42);
});

test("getState(sid) returns the same slot that getTodos/getNextId read from", () => {
	__resetState();
	const next: TaskState = { tasks: [makeTask(7, "lucky")], nextId: 8 };
	commitState(SID, next);
	const snap = getState(SID);
	assert.equal(snap, next);
	assert.equal(snap.tasks, getTodos(SID));
	assert.equal(snap.nextId, getNextId(SID));
});

test("replaceState(sid, next) publishes a new slot wholesale (replay seam)", () => {
	__resetState();
	const replayed: TaskState = {
		tasks: [makeTask(10, "from-branch"), makeTask(11, "from-branch-2")],
		nextId: 12,
	};
	replaceState(SID, replayed);
	assert.equal(getState(SID), replayed);
	assert.equal(getNextId(SID), 12);
});

test("commitState() and replaceState() are interchangeable seams over the same slot", () => {
	__resetState();
	commitState(SID, { tasks: [makeTask(1)], nextId: 2 });
	assert.equal(getNextId(SID), 2);
	replaceState(SID, { tasks: [], nextId: 99 });
	assert.deepEqual(getTodos(SID), []);
	assert.equal(getNextId(SID), 99);
});

test("__resetState() after a commit clears the slot (test-isolation contract)", () => {
	commitState(SID, { tasks: [makeTask(1)], nextId: 2 });
	__resetState();
	assert.deepEqual(getTodos(SID), []);
	assert.equal(getNextId(SID), 1);
});

// ---------------------------------------------------------------------------
// Per-session isolation
// ---------------------------------------------------------------------------

test("commitState/replaceState to one session never affects another session's slot", () => {
	__resetState();
	const s1: TaskState = { tasks: [makeTask(1, "s1-task")], nextId: 2 };
	const s2: TaskState = { tasks: [makeTask(1, "s2-task")], nextId: 5 };
	commitState("s1", s1);
	commitState("s2", s2);

	assert.equal(getState("s1"), s1);
	assert.equal(getState("s2"), s2);

	// A write to s1 leaves s2 untouched, and vice-versa.
	replaceState("s1", { tasks: [makeTask(9, "new-s1")], nextId: 10 });
	assert.equal(getState("s2"), s2);
	assert.equal(getNextId("s2"), 5);
	commitState("s2", { tasks: [], nextId: 77 });
	assert.deepEqual(getTodos("s1"), [makeTask(9, "new-s1")]);
	assert.equal(getNextId("s1"), 10);
});

test("a missing slot returns a fresh EMPTY_STATE copy, never aliasing EMPTY_STATE.tasks", () => {
	__resetState();
	const slot = getState("never-seen");
	assert.deepEqual(slot.tasks, EMPTY_STATE.tasks);
	assert.equal(slot.nextId, EMPTY_STATE.nextId);
	assert.notEqual(slot.tasks, EMPTY_STATE.tasks);
	assert.notEqual(slot, EMPTY_STATE);

	assert.deepEqual(getTodos("absent"), []);
	assert.equal(getNextId("absent"), 1);
	assert.notEqual(getTodos("absent"), EMPTY_STATE.tasks);
});

// ---------------------------------------------------------------------------
// evictSession
// ---------------------------------------------------------------------------

test("evictSession(sid) frees the slot; a later read returns a fresh EMPTY_STATE copy", () => {
	__resetState();
	commitState(SID, { tasks: [makeTask(1)], nextId: 2 });
	assert.equal(getState(SID).tasks.length, 1);
	evictSession(SID);
	const after = getState(SID);
	assert.deepEqual(after.tasks, []);
	assert.equal(after.nextId, 1);
	assert.notEqual(after.tasks, EMPTY_STATE.tasks);
});

test("evictSession on an absent slot is a no-op", () => {
	__resetState();
	assert.doesNotThrow(() => evictSession("absent"));
	assert.deepEqual(getTodos("absent"), []);
});

// ---------------------------------------------------------------------------
// Ctx-less render pointer
// ---------------------------------------------------------------------------

test("getRenderState() returns a fresh EMPTY_STATE copy before any pointer is set", () => {
	__resetState();
	const rendered = getRenderState();
	assert.deepEqual(rendered.tasks, []);
	assert.equal(rendered.nextId, 1);
	assert.notEqual(rendered.tasks, EMPTY_STATE.tasks);
});

test("setActiveRenderSession(sid) makes getRenderState() read that session's slot", () => {
	__resetState();
	commitState("rendered", { tasks: [makeTask(3, "shown")], nextId: 4 });
	setActiveRenderSession("rendered");
	const rendered = getRenderState();
	assert.deepEqual(rendered.tasks, [makeTask(3, "shown")]);
	assert.equal(rendered.nextId, 4);
});

test("setActiveRenderSession re-points the render slot to a different session", () => {
	__resetState();
	commitState("a", { tasks: [makeTask(1, "a")], nextId: 2 });
	commitState("b", { tasks: [makeTask(1, "b")], nextId: 2 });
	setActiveRenderSession("a");
	assert.deepEqual(getRenderState().tasks.map((t) => t.subject), ["a"]);
	setActiveRenderSession("b");
	assert.deepEqual(getRenderState().tasks.map((t) => t.subject), ["b"]);
});

test("__resetState() clears BOTH the Map and the render pointer", () => {
	commitState("a", { tasks: [makeTask(1)], nextId: 2 });
	setActiveRenderSession("a");
	assert.equal(getRenderState().tasks.length, 1);
	__resetState();
	assert.deepEqual(getState("a").tasks, []);
	const rendered = getRenderState();
	assert.deepEqual(rendered.tasks, []);
	assert.notEqual(rendered.tasks, EMPTY_STATE.tasks);
});

// ---------------------------------------------------------------------------
// sid(ctx)
// ---------------------------------------------------------------------------

test("sid(ctx) returns ctx.sessionManager.getSessionId()", () => {
	assert.equal(sid({ sessionManager: { getSessionId: () => "abc" } }), "abc");
});

test("sid(ctx) coerces a null/undefined session id to empty string (defensive)", () => {
	assert.equal(sid({ sessionManager: { getSessionId: () => null as unknown as string } }), "");
	assert.equal(sid({ sessionManager: { getSessionId: () => undefined as unknown as string } }), "");
});

// ---------------------------------------------------------------------------
// Foreground render-pointer accessors
// ---------------------------------------------------------------------------

test("getActiveRenderSession() returns the session set by setActiveRenderSession()", () => {
	__resetState();
	setActiveRenderSession("s1");
	assert.equal(getActiveRenderSession(), "s1");
	assert.deepEqual(getRenderState(), getState("s1"));
});

test("clearActiveRenderSession() resets the pointer; getRenderState() returns a fresh EMPTY_STATE", () => {
	__resetState();
	commitState("s1", { tasks: [makeTask(1)], nextId: 2 });
	setActiveRenderSession("s1");
	assert.deepEqual(getRenderState().tasks, [makeTask(1)]);
	clearActiveRenderSession();
	assert.equal(getActiveRenderSession(), "");
	const rendered = getRenderState();
	assert.deepEqual(rendered.tasks, []);
	assert.equal(rendered.nextId, EMPTY_STATE.nextId);
	assert.notEqual(rendered.tasks, EMPTY_STATE.tasks);
});

test("__resetState() clears the foreground pointer", () => {
	setActiveRenderSession("s1");
	__resetState();
	assert.equal(getActiveRenderSession(), "");
});