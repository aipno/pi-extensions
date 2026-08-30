/**
 * Minimal TUI rendering for the pi-tools replacements, mirroring the visual
 * shape of pi's built-in tool renderers (tool name + path/pattern, then the
 * result body as uniform tool-output text).
 */

import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";

const textContentOf = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
		.join("");
};

/** Text part of a tool result. */
export type ToolTextContent = { type: "text"; text: string };
/** Image attachment part of a tool result. */
export type ToolImageContent = { type: "image"; data: string; mimeType: string };
/** Union of content parts our tools produce. */
export type ToolContent = ToolTextContent | ToolImageContent;

/** Strip ANSI codes for a raw fallback render. */
function stripAnsi(s: string): string {
	return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Render a tool call line: `name` + bold title + muted args. */
export function renderToolCall(
	name: string,
	title: string,
	detail: string | undefined,
	theme: Theme,
): Component {
	let text = theme.fg("toolTitle", theme.bold(name));
	if (title) text += ` ${theme.fg("accent", title)}`;
	if (detail) text += ` ${theme.fg("toolOutput", detail)}`;
	return new Text(text, 0, 0);
}

/**
 * Render a tool result: the text body, capped at 200 lines when collapsed,
 * with a "N more lines" hint. Mirrors pi's formatToolResult output shape.
 */
export function renderToolResult(
	result: { content?: unknown; details?: unknown; isError?: boolean },
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const output = stripAnsi(textContentOf(result.content)).trim();
	const box = new Box();
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 30;
		const display = lines.slice(0, maxLines);
		if (display.length > 0) {
			box.addChild(new Text(display.map((l) => theme.fg("toolOutput", l)).join("\n"), 0, 0));
		}
		if (lines.length > maxLines) {
			const remaining = lines.length - maxLines;
			box.addChild(new Text(theme.fg("muted", `\n... (${remaining} more lines)`), 0, 0));
		}
	}
	return box;
}