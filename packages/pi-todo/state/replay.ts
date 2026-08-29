import type { TaskDetails } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches `TaskDetails` wins
 * (last-write-wins). When no matching entry exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 */
function* reverseEntries(branch: Iterable<unknown>): Iterable<unknown> {
	if (Array.isArray(branch)) {
		for (let i = branch.length - 1; i >= 0; i--) yield branch[i];
		return;
	}
	const arr = Array.from(branch);
	for (let i = arr.length - 1; i >= 0; i--) yield arr[i];
}

export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	for (const entry of reverseEntries(ctx.sessionManager.getBranch())) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		return {
			tasks: msg.details.tasks.map((t) => ({ ...t })),
			nextId: msg.details.nextId,
		};
	}
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}