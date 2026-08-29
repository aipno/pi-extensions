import { selectVisibleTasks } from "../state/selectors.ts";
import type { TaskState } from "../state/state.ts";
import { sanitizeTerminalText } from "./sanitize.ts";
import type { Task } from "./types.ts";

/**
 * A task is stale when it is in_progress and its `updatedAt` predates the
 * N-th lookback turn (B4). Legacy tasks without timestamps are never flagged.
 * After `staleTurns` turns with no effective update the hint fires.
 */
export function isTaskStale(t: Task, turnTimes: readonly number[], staleTurns: number): boolean {
	if (t.status !== "in_progress") return false;
	if (typeof t.updatedAt !== "number") return false;
	if (turnTimes.length < staleTurns + 1) return false;
	return t.updatedAt < turnTimes[turnTimes.length - (staleTurns + 1)]!;
}

/**
 * Stale-task reminder lines appended to the injected board (B4). Pure and
 * unit-testable; `turnTimes` is the per-session before_agent_start timestamp
 * log (newest last). One line per stale task, capped at `maxLines` so a
 * pathological board cannot flood the prompt.
 */
export function formatStaleReminderLines(
	state: TaskState,
	turnTimes: readonly number[],
	staleTurns = 2,
	maxLines = 3,
): string[] {
	const stale = state.tasks
		.filter((t) => isTaskStale(t, turnTimes, staleTurns))
		.slice(0, maxLines);
	if (stale.length === 0) return [];
	const lines = stale.map(
		(t) =>
			`! #${t.id} [in_progress] ${sanitizeTerminalText(t.subject)} — no update for ${staleTurns} turns` +
			`; if stalled, update the status or fall back to pending`,
	);
	return ["Stale: (no progress for several turns)", ...lines];
}

/**
 * Compact, LLM-facing board. One line per visible task. Used both as the
 * mutation-result suffix (so the model always has current ids) and as the
 * `before_agent_start` system-prompt injection (so the board survives
 * compaction without a `list` round-trip).
 */
export function formatCompactBoard(state: TaskState): string {
	const visible = selectVisibleTasks(state);
	if (visible.length === 0) return "";
	return visible.map(formatCompactBoardLine).join("\n");
}

export function formatCompactBoardLine(t: Task): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const owner = t.owner ? ` @${sanitizeTerminalText(t.owner)}` : "";
	return `#${t.id} [${t.status}] ${sanitizeTerminalText(t.subject)}${form}${block}${owner}`;
}
