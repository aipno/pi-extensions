import { MAX_TASKS, type Task, type TaskAction, type TaskMutationParams, type TaskStatus } from "../tool/types.ts";
import { isTransitionValid } from "./invariants.ts";
import type { TaskState } from "./state.ts";
import { detectCycle } from "./task-graph.ts";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive).
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
	| { kind: "create"; taskId: number }
	| {
			kind: "update";
			id: number;
			fromStatus: TaskStatus;
			toStatus: TaskStatus;
			changed: boolean;
			/** Fields that actually differ before/after; empty when only sibling demotion changed the state. */
			changedFields: string[];
	  }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function uniquePreserveOrder(ids: number[] | undefined): number[] {
	if (!ids?.length) return [];
	const seen = new Set<number>();
	const out: number[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const keys = Object.keys(ao);
		if (keys.length !== Object.keys(bo).length) return false;
		return keys.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
	}
	return false;
}

function sameRecord(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	return deepEqual(a ?? null, b ?? null);
}

/**
 * Did this `update` change anything? Compares the task before/after the params
 * are applied. A no-effect update — `status` set to its current value, or any
 * field re-sent unchanged — returns false, letting the response envelope say
 * "No change" instead of "Updated #N". Without this, a no-op update is
 * indistinguishable from a real mutation, which can drive a model to re-issue
 * the same call in a loop.
 *
 * blockedBy is order-sensitive (the reducer preserves insertion order);
 * metadata round-trips through JSON persistence, so JSON-equality is the
 * operative notion of "changed".
 */
function taskChangedFields(before: Task, after: Task): string[] {
	const fields: string[] = [];
	// Field order follows the LLM-facing documentation (A4).
	if (before.subject !== after.subject) fields.push("subject");
	if (before.description !== after.description) fields.push("description");
	if (before.activeForm !== after.activeForm) fields.push("activeForm");
	if (before.status !== after.status) fields.push("status");
	if (before.owner !== after.owner) fields.push("owner");
	if (!sameRecord(before.metadata, after.metadata)) fields.push("metadata");
	if (!sameNumberList(before.blockedBy, after.blockedBy)) fields.push("blockedBy");
	return fields;
}

function taskChanged(before: Task, after: Task): boolean {
	return taskChangedFields(before, after).length > 0;
}

/**
 * Pure reducer: (state, action, params) → (state, op). The response envelope
 * (`tool/response-envelope.ts`) owns formatting, the store (`state/store.ts`)
 * owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles).
 */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			const subject = params.subject?.trim();
			if (!subject) {
				return errorResult(state, "subject required for create");
			}
			const visibleCount = state.tasks.reduce((n, t) => n + (t.status !== "deleted" ? 1 : 0), 0);
			if (visibleCount >= MAX_TASKS) {
				return errorResult(
					state,
					`task limit reached (${MAX_TASKS}); complete, delete, or clear existing tasks`,
				);
			}
			const blockedBy = uniquePreserveOrder(params.blockedBy);
			if (blockedBy.length) {
				for (const dep of blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (blockedBy.length) newTask.blockedBy = blockedBy;
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };
			// A1: both timestamps stamp the moment of creation.
			const now = Date.now();
			newTask.createdAt = now;
			newTask.updatedAt = now;

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation)
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
				);

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(
						state,
						current.status === "completed"
							? `illegal transition completed → ${params.status} (completed is terminal; create a new task for regressions)`
							: `illegal transition ${current.status} → ${params.status}`,
					);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) {
				const nextSubject = params.subject.trim();
				if (!nextSubject) return errorResult(state, "subject must be non-empty");
				updated.subject = nextSubject;
			}
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			// A1: only effective mutations refresh updatedAt. Compute before the
			// demotion loop so a pure sibling-demotion (target unchanged) does not
			// re-stamp the target.
			const changedFields = taskChangedFields(current, updated);
			let demoted = false;
			if (newStatus === "in_progress") {
				for (let i = 0; i < newTasks.length; i++) {
					if (i === idx || newTasks[i].status !== "in_progress") continue;
					newTasks[i] = { ...newTasks[i], status: "pending" };
					demoted = true;
				}
			}
			const changed = changedFields.length > 0 || demoted;
			if (changed) updated.updatedAt = Date.now();
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed,
					changedFields,
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };
			// A2: sweep this id out of every other task's blockedBy so no ghost
			// reference to a tombstone survives (the deleted task itself keeps its
			// own blockedBy for history). Replay snapshots follow automatically.
			const newTasks = state.tasks.map((t) => {
				if (t === current || !t.blockedBy?.includes(current.id)) return t;
				const remaining = t.blockedBy.filter((dep) => dep !== current.id);
				const copy: Task = { ...t };
				if (remaining.length) copy.blockedBy = remaining;
				else delete copy.blockedBy;
				return copy;
			});
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}
	}
}