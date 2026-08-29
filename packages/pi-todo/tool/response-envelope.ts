import type { TaskState } from "../state/state.ts";
import type { Op } from "../state/state-reducer.ts";
import { deriveBlocks } from "../state/task-graph.ts";
import { formatCompactBoard } from "./board.ts";
import { sanitizeTerminalText } from "./sanitize.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "./types.ts";

/** Append the compact board to mutation headlines so the model keeps current ids. */
function withBoard(headline: string, op: Op, state: TaskState): string {
	if (op.kind === "list" || op.kind === "get" || op.kind === "error") return headline;
	const board = formatCompactBoard(state);
	return board ? `${headline}\n${board}` : headline;
}

/**
 * Format a single task as a `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 * line. Used by the `list` content branch only — the overlay and `/todos`
 * formatting paths use `view/format.ts` for richer presentations.
 *
 * Blockers that are completed or deleted are dropped from the `⛓` suffix
 * (A3): a completed dependency no longer blocks, and a deleted one is a ghost
 * (legacy snapshots predating A2's source-level sweep). Keeps the model from
 * chasing stale dependency edges.
 */
function formatListLine(t: Task, state: TaskState): string {
	const liveBlockers = (t.blockedBy ?? []).filter((id) => {
		const dep = state.tasks.find((x) => x.id === id);
		return dep && dep.status !== "completed" && dep.status !== "deleted";
	});
	const block = liveBlockers.length ? ` ⛓ ${liveBlockers.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

/**
 * Multi-line presentation for the `get` action. Order of rows is pinned:
 * description, activeForm, blockedBy, blocks, owner.
 */
function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			// Defensive — `op.taskId` always resolves on success path.
			const headline = !t ? `Created #${op.taskId}` : `Created #${t.id}: ${sanitizeTerminalText(t.subject)} (pending)`;
			return withBoard(headline, op, state);
		}
		case "update": {
			if (!op.changed) {
				return withBoard(
					`No change: #${op.id} already matches the requested values (status: ${op.toStatus})`,
					op,
					state,
				);
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			// A4: field-level detail so the model knows exactly what moved without
			// re-reading the board. Empty when only sibling demotion changed state.
			const fields = op.changedFields.length > 0 ? ` · changed: ${op.changedFields.join(", ")}` : "";
			return withBoard(`Updated #${op.id}${transition}${fields}`, op, state);
		}
		case "delete":
			return withBoard(`Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`, op, state);
		case "clear":
			return withBoard(`Cleared ${op.count} tasks`, op, state);
		case "list": {
			// N2: filtering tombstones by status=deleted must not silently return
			// "No tasks" just because includeDeleted was not passed — the tool's
			// own guidance presents deleted as a listable status.
			const includeDeleted = op.includeDeleted || op.statusFilter === "deleted";
			let view = state.tasks;
			if (!includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			if (view.length === 0) return "No tasks";
			// A3: pending-first grouping (stable, so ids stay ordered within each
			// group) at the presentation layer — the reducer/replay shape is
			// untouched.
			const statusRank: Record<TaskStatus, number> = {
				pending: 0,
				in_progress: 1,
				completed: 2,
				deleted: 3,
			};
			const sorted = [...view].sort((a, b) => statusRank[a.status] - statusRank[b.status]);
			return sorted.map((t) => formatListLine(t, state)).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}