/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), Pi tool-output expansion awareness, auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.ts";
import { formatStatusLabel, t } from "./state/i18n-bridge.ts";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.ts";
import { getRenderState } from "./state/store.ts";
import { formatOverlayTaskLine } from "./view/format.ts";

const WIDGET_KEY = "pi-todos";

/** Frame-to-glyph cadence: one glyph per N animation frames (150ms each). */
export const ACTIVE_SPINNER_FRAMES_PER_GLYPH = 2;

/** Animation tick interval in ms (B3): frames advance ONLY here, never in render. */
export const ANIMATION_TICK_MS = 150;

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private collapsed = false;
	// B3: animation frame counter — advanced only by the dedicated interval,
	// never incremented inside render (render speed would otherwise vary with
	// agent busyness).
	private frame = 0;
	private animationTimer: ReturnType<typeof setInterval> | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		// B3: stop the ticker when there is nothing left to animate — even
		// before the unregister branch below runs.
		this.syncAnimation(snapshot.tasks.some((task) => task.status === "in_progress"));

		if (visible.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		this.trackNewlyDisplayedCompleted(visible);

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private getSnapshot() {
		const state = getRenderState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: state.tasks, nextId: state.nextId };
	}

	private trackNewlyDisplayedCompleted(overlayTasks: ReturnType<TodoOverlay["selectOverlayTasks"]>): void {
		for (const task of overlayTasks) {
			if (
				task.status === "completed" &&
				!this.completedTaskIdsPendingHide.has(task.id) &&
				!this.hiddenCompletedTaskIds.has(task.id)
			) {
				this.completedTaskIdsPendingHide.add(task.id);
			}
		}
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	/**
	 * B3: render entry point with a hard guard — a widget render exception must
	 * never take the host process down. Drops the paint and lets Pi's normal
	 * cadence retry.
	 */
	private renderWidget(theme: Theme, width: number): string[] {
		try {
			return this.renderWidgetInner(theme, width);
		} catch {
			return [];
		}
	}

	/**
	 * B3: spinner ticker lifecycle. Frames advance only inside a dedicated
	 * interval, never in render. Runs only while at least one in_progress task
	 * exists; `unref` so an idle pi-todo never keeps the host process alive.
	 * Called from render (after `tui` is bound) and from `update`/`dispose` so
	 * the timer cannot outlive the widget.
	 */
	private syncAnimation(hasInProgress: boolean): void {
		if (hasInProgress && !this.animationTimer) {
			this.animationTimer = setInterval(() => {
				this.frame++;
				// No requestRender while collapsed — frames advance silently so the
				// spinner resumes mid-cycle on expand.
				if (!this.collapsed) this.tui?.requestRender();
			}, ANIMATION_TICK_MS);
			this.animationTimer.unref?.();
		} else if (!hasInProgress && this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}

	/** Test/shortcut hook: whether the animation ticker is currently running. */
	isAnimating(): boolean {
		return this.animationTimer !== undefined;
	}

	private renderWidgetInner(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		this.syncAnimation(snapshot.tasks.some((task) => task.status === "in_progress"));

		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const showIds = selectShowTaskIds(overlayState);

		const headingTextBuilder = () => {
			// B1: heading shows the pending / in_progress split (when non-zero)
			// in addition to completed/total — mirroring the /todos header.
			const parts = [`${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`];
			if (counts.pending > 0) parts.push(`${counts.pending} ${formatStatusLabel("pending")}`);
			if (counts.inProgress > 0) parts.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			return parts.join(" · ");
		};
		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = headingTextBuilder();
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		// Collapsed view: just the heading + a dim "└─" expand hint, then the
		// trailing spacer. Short-circuit before the budget math and the completed-
		// display tracking — nothing is shown to track. The hint splices the
		// resolved key into the {key} placeholder (per-render); a config edit
		// needs /reload to re-bind the actual shortcut. The "off" sentinel is
		// reachable here mid-session (config edited after the shortcut was bound
		// and the overlay collapsed) — render a static collapsed label instead of
		// splicing the sentinel into the placeholder.
		if (this.collapsed) {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
		}

		const lines: string[] = [heading];
		// Budget for content rows (heading + tasks/summary). The rendered widget is
		// one line taller — withTrailingSpacer() appends a blank row below the panel.
		// Pi's global tool-output expansion mode is read on every render so its
		// expand/collapse shortcut also expands this live widget. Optional chaining
		// preserves compatibility with hosts predating getToolsExpanded().
		const bodyBudget = this.uiCtx?.getToolsExpanded?.() === true ? overlayTasks.length : getMaxWidgetLines() - 1;
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		for (const task of layout.visible) {
			lines.push(
				truncate(
					`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds, Math.floor(this.frame / ACTIVE_SPINNER_FRAMES_PER_GLYPH))}`,
				),
			);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedPending === 0 && layout.truncatedInProgress === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedPending + layout.truncatedInProgress;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		// N1: label each truncated group by its real status — in_progress tasks
		// must never be counted as pending.
		if (layout.truncatedPending > 0) overflowParts.push(`${layout.truncatedPending} ${formatStatusLabel("pending")}`);
		if (layout.truncatedInProgress > 0)
			overflowParts.push(`${layout.truncatedInProgress} ${formatStatusLabel("in_progress")}`);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return this.withTrailingSpacer(lines);
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "+N more" summary) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		this.frame = 0;
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.collapsed = false;
		this.resetCompletedDisplayState();
	}
}