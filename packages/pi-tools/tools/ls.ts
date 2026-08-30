/**
 * ls tool — self-implemented directory listing replacing pi's built-in `ls`.
 *
 * Sorted names, `/` suffix for directories, dotfiles included. Output format
 * matches pi's built-in.
 */

import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import { resolveToolPath } from "../lib/path-utils.ts";
import { renderToolCall, renderToolResult } from "./render.ts";

export const LS_DEFAULT_LIMIT = 500;

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

type LsParams = Static<typeof lsSchema>;

export interface LsToolDetails {
	truncation?: { truncated: boolean; maxBytes?: number };
	entryLimitReached?: number;
}

const lsDescription = `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`;

export function registerLsTool(pi: ExtensionAPI): void {
	const definition: ToolDefinition<typeof lsSchema, LsToolDetails | undefined> = {
		name: "ls",
		label: "Ls",
		description: lsDescription,
		promptSnippet: "List directory contents",
		parameters: lsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeLs(params, signal, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return renderLsCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme);
		},
	};
	pi.registerTool(definition);
}

export async function executeLs(
	params: LsParams,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: LsToolDetails | undefined }> {
	const target = resolveToolPath(params.path ?? ".", cwd);
	let entries;
	try {
		if (!(await stat(target)).isDirectory()) {
			throw new Error(`Not a directory: ${target}`);
		}
		entries = await readdir(target);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Not a directory:")) throw err;
		throw new Error(`Path not found: ${target}`);
	}

	if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");

	const effectiveLimit = Math.max(1, params.limit ?? LS_DEFAULT_LIMIT);
	// Sort alphabetically, case-insensitive (pi built-in behavior).
	const sorted = entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const results: string[] = [];
	for (const name of sorted) {
		if (results.length >= effectiveLimit) break;
		try {
			const entryStat = await stat(path.join(target, name));
			results.push(entryStat.isDirectory() ? `${name}/` : name);
		} catch {
			// Skip entries we cannot stat (pi built-in behavior).
			continue;
		}
	}

	const entryLimitReached = results.length >= effectiveLimit;
	if (results.length === 0) {
		return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
	}
	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const details: LsToolDetails = {};
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		details.entryLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = { truncated: true, maxBytes: DEFAULT_MAX_BYTES };
	}
	let output = truncation.content;
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

function renderLsCall(args: LsParams, theme: Theme, context: { lastComponent?: unknown }): Component {
	const detail = theme.fg("toolOutput", args.path ?? ".");
	return renderToolCall("ls", "", detail, theme);
}