/**
 * TUI rendering for subagent tool calls/results and notification messages.
 *
 * Learned from nicobailon/pi-subagents src/tui/render.ts: use pi-tui
 * primitives (Box/Text), color by status, keep the body expandable and
 * bounded.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import * as path from "node:path";
import type { Details, SingleResult, ToolResult } from "../shared/types.ts";
import { defaultRunsDir, formatCost, formatDuration, formatTokens, shortenPath, truncationInfo } from "../shared/utils.ts";

function statusLabel(result: SingleResult): { label: string; color: "success" | "error" | "warning" | "muted" } {
	if (result.interrupted) return { label: "interrupted", color: "warning" };
	if (result.timedOut) return { label: "timed out", color: "error" };
	if (result.error) return { label: "failed", color: "error" };
	return { label: "completed", color: "success" };
}

/** Compact one-line summary used for the collapsed tool result. */
export function renderSubagentSummary(result: ToolResult<Details>, theme: Theme): Component {
	const first = result.details?.results[0];
	// L4: old/corrupt result files may lack the usage object entirely;
	// never let a missing field crash the renderer.
	const usage = first?.usage ?? { turns: 0, tokens: 0, cost: 0 };
	const agentName = first?.agent ?? "subagent";
	const status = first ? statusLabel(first) : { label: result.isError ? "failed" : "completed", color: result.isError ? ("error" as const) : ("success" as const) };
	const icon = status.color === "success" ? "✓" : status.color === "error" ? "✗" : "■";
	let text = `${icon} ${theme.fg(status.color, agentName)} ${theme.fg("dim", status.label)}`;
	if (first) {
		const parts: string[] = [];
		if (first.durationMs) parts.push(formatDuration(first.durationMs));
		if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
		if (usage.tokens) parts.push(`${formatTokens(usage.tokens)} tok`);
		const cost = formatCost(usage.cost);
		if (cost) parts.push(cost);
		if (parts.length) text += ` ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}`;
	}
	const output = first?.finalOutput ?? (typeof result.content === "string" ? result.content : "");
	const info = truncationInfo(output);
	const contentLines = output.split("\n").filter((line) => line.trim() && !line.includes("… [truncated"));
	const firstLine = contentLines[0] ?? "";
	if (firstLine.trim()) text += `\n  ${theme.fg("dim", `⎿  ${truncateToWidth(firstLine.trim(), 100, "…")}`)}`;
	// Distinguish "folded for display" from "truncated at the source":
	// folded output is complete in the expanded view, a truncated report
	// additionally points at the persisted full text.
	const hints: string[] = [];
	if (contentLines.length > 1) hints.push(`+${contentLines.length - 1} lines folded`);
	if (info.fullPath) hints.push(`full output: ${shortenPath(info.fullPath)}`);
	if (info.truncated && !info.fullPath) hints.push("truncated at the source");
	if (hints.length) text += `\n  ${theme.fg("dim", `${hints.join(" · ")} — Ctrl+O for full view`)}`;
	return new Text(text, 0, 0);
}

/**
 * Fold a report body to `maxLines` for the compact result view. The folded
 * text stays complete in the expanded view; explicit markers tell the
 * reader when it was folded, when the source truncated it, and where the
 * persisted full output lives.
 */
function foldBody(body: string, maxLines: number): string {
	const raw = body.split("\n");
	const info = truncationInfo(body);
	const total = raw.filter((line) => line.trim() && !line.includes("… [truncated")).length;
	let text = raw.slice(0, maxLines).join("\n");
	if (total > maxLines) text += `\n… +${total - maxLines} more lines folded`;
	if (info.fullPath && !text.includes(info.fullPath)) text += `\n… full output: ${shortenPath(info.fullPath)}`;
	if (info.truncated && !info.fullPath) text += "\n… truncated at the source";
	return text;
}

/** Full result card used when the tool result is expanded. */
export function renderSubagentResult(result: ToolResult<Details>, options: { expanded: boolean }, theme: Theme): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	const first = result.details?.results[0];
	if (!first) {
		const text = typeof result.content === "string" ? result.content : "[no output]";
		container.addChild(new Text(theme.fg(result.isError ? "error" : "dim", text), 0, 0));
		return container;
	}
	// L4: corrupt/old result files may omit usage; never crash the renderer.
	const usage = first.usage ?? { turns: 0, tokens: 0, cost: 0 };
	const status = statusLabel(first);
	const parts: string[] = [
		theme.bold(`${status.color === "success" ? "✓" : status.color === "error" ? "✗" : "■"} ${first.agent}`),
		theme.fg(status.color, status.label),
	];
	if (first.model) parts.push(theme.fg("muted", first.model));
	const meta: string[] = [];
	if (first.durationMs) meta.push(formatDuration(first.durationMs));
	if (usage.turns) meta.push(`${usage.turns} turns`);
	if (usage.tokens) meta.push(`${formatTokens(usage.tokens)} tokens`);
	const cost = formatCost(usage.cost);
	if (cost) meta.push(cost);
	if (meta.length) parts.push(theme.fg("dim", `· ${meta.join(" · ")}`));

	const header = new Text(parts.join("  "), 0, 0);
	container.addChild(header);
	container.addChild(new Spacer(1));

	if (first.error && !first.finalOutput?.startsWith(first.error)) {
		container.addChild(new Text(theme.fg("error", first.error), 0, 0));
		container.addChild(new Spacer(1));
	}

	const body = first.finalOutput || first.error || "(no output)";
	const width = 100;
	const lines = options.expanded
		? wrapTextWithAnsi(body, width)
		: wrapTextWithAnsi(foldBody(body, 8), width);
	if (lines.length === 0) lines.push("(no output)");
	const bodyText = new Text(lines.map((line) => `  ${line}`).join("\n"), 0, 0);
	container.addChild(bodyText);

	if (first.progress?.recentTools?.length) {
		container.addChild(new Spacer(1));
		const tools = first.progress.recentTools.slice(-5).map((t) => t.tool).join(", ");
		container.addChild(new Text(theme.fg("dim", `tools: ${tools}`), 0, 0));
	}
	return container;
}

/** Inline renderer for tool-call lines: `subagent scout [async]`. */
export function renderSubagentCall(
	args: { agent?: string; async?: boolean; context?: string; workflowScript?: string },
	theme: Theme,
): Component {
	const title = theme.fg("toolTitle", theme.bold("subagent"));
	const target = args.agent ? theme.fg("accent", args.agent) : theme.fg("accent", "?");
	const asyncBadge = args.async === true ? ` ${theme.fg("warning", "[async]")}` : "";
	const contextBadge = args.context === "fork" ? ` ${theme.fg("muted", "[fork]")}` : "";
	return new Text(`${title} ${target}${asyncBadge}${contextBadge}`, 0, 0);
}

/** Notification card for completed background runs. */
export function renderAsyncNotify(details: { agent: string; status: string; taskLabel?: string; durationMs?: number; resultPreview: string; runId: string; sessionLabel?: string; sessionValue?: string; cost?: number; tokens?: number }, theme: Theme): Component {
	const icon = details.status === "completed"
		? theme.fg("success", "✓")
		: theme.fg("error", "✗");
	let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
	const meta: string[] = [];
	if (details.durationMs !== undefined) meta.push(formatDuration(details.durationMs));
	const cost = details.cost ? formatCost(details.cost) : "";
	if (cost) meta.push(cost);
	if (meta.length) text += ` ${theme.fg("dim", "·")} ${meta.map((m) => theme.fg("dim", m)).join(" · ")}`;
	const preview = details.resultPreview.trim();
	const allLines = preview.split("\n").filter((line) => line.trim());
	const firstLines = allLines.slice(0, 3);
	for (const line of firstLines) {
		text += `\n  ${theme.fg("dim", `⎿  ${truncateToWidth(line, 100, "…")}`)}`;
	}
	// The card only ever shows the first 3 lines; say so, and point at the
	// persisted full report, instead of looking like the report was cut.
	if (allLines.length > 3 || truncationInfo(preview).truncated) {
		const hints: string[] = [];
		if (allLines.length > 3) hints.push(`+${allLines.length - 3} more lines folded`);
		hints.push(`full output: ${shortenPath(path.join(defaultRunsDir(), details.runId, "result.json"))}`);
		text += `\n  ${theme.fg("dim", `⎿  ${hints.join(" · ")}`)}`;
	}
	if (details.sessionLabel && details.sessionValue) {
		text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
	}
	text += `\n  ${theme.fg("muted", `run: ${details.runId.slice(0, 8)}`)}`;
	return new Text(text, 0, 0);
}

/** Config card for /subagents-config. */
export function renderConfigCard(details: {
	path: string;
	message?: string;
	entries: Array<{ key: string; value: string; source: "default" | "file" }>;
}, theme: Theme): Component {
	const container = new Container();
	container.addChild(new Text(theme.bold("Subagent config"), 0, 0));
	if (details.message) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("success", details.message), 0, 0));
	}
	container.addChild(new Spacer(1));
	for (const entry of details.entries) {
		const source = entry.source === "file" ? theme.fg("accent", "file") : theme.fg("muted", "default");
		container.addChild(new Text(`${theme.bold(entry.key)} ${theme.fg("dim", "=")} ${entry.value} ${theme.fg("dim", "·")} ${source}`, 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", `config file: ${details.path}`), 0, 0));
	return container;
}

/** Run list for /subagents-runs. */
export function renderRunsList(details: { runs: Array<{ runId: string; agent: string; status: string; startedAt: number; finishedAt?: number }> }, theme: Theme): Component {
	const container = new Container();
	if (details.runs.length === 0) {
		container.addChild(new Text(theme.fg("dim", "No subagent runs recorded yet."), 0, 0));
		return container;
	}
	container.addChild(new Text(theme.bold(`Subagent runs (${details.runs.length})`), 0, 0));
	container.addChild(new Spacer(1));
	for (const run of details.runs) {
		const statusColor = run.status === "completed" ? "success" : run.status === "running" ? "accent" : run.status === "failed" ? "error" : "warning";
		const when = new Date(run.startedAt).toLocaleTimeString();
		const duration = run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : "";
		container.addChild(new Text(
			`${theme.bold(run.agent)} ${theme.fg(statusColor, run.status)} ${theme.fg("dim", `${when}${duration ? ` · ${duration}` : ""} · ${run.runId.slice(0, 8)}`)}`,
			0, 0,
		));
	}
	return container;
}

export function ResultBox(result: ToolResult<Details>, options: { expanded: boolean }, theme: Theme): Component {
	const box = new Box(1, 1, (text: string) => theme.bg(result.isError ? "toolErrorBg" : "toolSuccessBg", text));
	box.addChild(renderSubagentResult(result, options, theme));
	return box;
}