import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatStatusLabel } from "../state/i18n-bridge.ts";
import { selectTaskSubjectById } from "../state/selectors.ts";
import type { TaskState } from "../state/state.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types.ts";

// Re-export so legacy import paths (todo.ts, tests) continue to resolve;
// the canonical definition lives in the i18n bridge.
export { formatStatusLabel };

// ---------------------------------------------------------------------------
// Status presentation tables — the single source of truth for glyph/color.
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

/**
 * Color palette for the renderResult status echo. `deleted` uses `muted` so a
 * successful delete is visually distinct from the error branch (which uses
 * `error` + `✗`).
 */
export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

/**
 * Per-action prefix glyph for renderCall. `+` create, `→` update, `×` delete,
 * `›` get, `☰` list, `∅` clear.
 */
export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

/**
 * Spinner glyphs for the active (in_progress) overlay row (B3). Owned here,
 * not by the overlay, so todo-overlay can import them without a cycle.
 * Frames-per-glyph cadence is the overlay's animation policy.
 */
export const ACTIVE_SPINNER_GLYPHS = ["◐", "◑", "◒", "◓"] as const;

/** Resolve the animated in_progress glyph for a frame index (B3). */
export function activeSpinnerGlyph(frame: number): string {
	return ACTIVE_SPINNER_GLYPHS[Math.abs(frame) % ACTIVE_SPINNER_GLYPHS.length]!;
}

/**
 * Glyph for the persistent overlay's per-task row. Differs from `STATUS_GLYPH`
 * for `completed` (`✓` vs `●`) and `deleted` (`✗` vs `⊘`) because the
 * overlay caller never renders a `deleted` row but uses `✗` in its
 * error-toned palette. `frame` (B3) animates the in_progress glyph; absence
 * falls back to the static `◐`.
 */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme, frame?: number): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", frame === undefined ? "◐" : activeSpinnerGlyph(frame));
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/**
 * Format a single task row for the persistent overlay. The subject color
 * reflects task state while IDs and supporting metadata stay visually quiet.
 */
export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean, frame?: number): string {
	const glyph = overlayStatusGlyph(t.status, theme, frame);
	const subjectColor =
		t.status === "in_progress" ? "accent" : t.status === "completed" || t.status === "deleted" ? "muted" : "text";
	let subject = theme.fg(subjectColor, sanitizeTerminalText(t.subject));
	if (t.status === "completed" || t.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph}`;
	if (showId) line += ` ${theme.fg("dim", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.owner) {
		line += ` ${theme.fg("muted", `@${sanitizeTerminalText(t.owner)}`)}`;
	}
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("muted", `(${sanitizeTerminalText(t.activeForm)})`)}`;
	}
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("muted", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/**
 * Format a single task line for the `/todos` slash command (no glyph color,
 * indented bullet prefix).
 */
export function formatCommandTaskLine(t: Task, glyph: string): string {
	const owner = t.owner ? ` @${sanitizeTerminalText(t.owner)}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${t.id} ${sanitizeTerminalText(t.subject)}${owner}${form}${block}`;
}

// ---------------------------------------------------------------------------
// Tool render hooks — wrapped so `todo.ts` becomes a thin call-site.
// ---------------------------------------------------------------------------

/**
 * `renderCall` body. Receives the parsed args, the theme, and the live
 * `TaskState` (resolved by the caller via `getState()`). Returns a `Text`
 * node.
 */
export function renderTodoCall(
	args: TaskMutationParams & { action: TaskAction },
	theme: Theme,
	state: TaskState,
): Text {
	const glyph = ACTION_GLYPH[args.action] ?? args.action;
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

	if (args.action === "create" && args.subject) {
		text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
	} else if (
		(args.action === "update" || args.action === "get" || args.action === "delete") &&
		args.id !== undefined
	) {
		const subject = selectTaskSubjectById(state, args.id);
		text += ` ${theme.fg("accent", subject ? sanitizeTerminalText(subject) : `#${args.id}`)}`;
	} else if (args.action === "list" && args.status) {
		text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
	}
	return new Text(text, 0, 0);
}

/**
 * `renderResult` body. Inspects `details` to pick the per-action status echo
 * (only `create`/`update`/`delete` advertise a status; `list`/`get`/`clear`
 * fall back to plain `✓`).
 */
export function renderTodoResult(result: { details?: unknown }, theme: Theme): Text {
	const details = result.details as TaskDetails | undefined;
	let status: TaskStatus | undefined;
	if (details) {
		const params = details.params as TaskMutationParams;
		switch (details.action) {
			case "create":
				status = details.tasks[details.tasks.length - 1]?.status;
				break;
			case "update":
				status = params.status ?? details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "delete":
				status = details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "list":
			case "get":
			case "clear":
				break;
		}
	}
	if (status) {
		return new Text(theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${formatStatusLabel(status)}`), 0, 0);
	}
	return new Text(theme.fg("success", "✓"), 0, 0);
}