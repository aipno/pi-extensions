/**
 * grep tool — self-implemented search replacing pi's built-in `grep`.
 *
 * Strategy: when the `rg` binary is on PATH it is used as the fast path
 * (spawned with the same JSON protocol pi's built-in uses). Otherwise a
 * pure-TypeScript engine walks the tree (gitignore-aware) and matches lines
 * directly. Output format and details match pi's built-in exactly so the
 * model experience is drop-in identical.
 */

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import { DEFAULT_LIMIT, type FileMatch, searchFiles, type SearchMode } from "../engine/search.ts";
import { resolveToolPath } from "../lib/path-utils.ts";
import { findRg, type RgMatch, runRg } from "../lib/rg.ts";
import { renderToolCall, renderToolResult } from "./render.ts";

export const GREP_MAX_LINE_LENGTH = 500;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Pattern to search for (regular expression)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(
		Type.String({
			description:
				"Glob filter for file paths, e.g. '**/*.ts'. Only files matching the glob are searched. Prefix with ! to exclude, e.g. '!**/*.test.ts'.",
		}),
	),
	ignoreCase: Type.Optional(
		Type.Boolean({ description: "Case-insensitive search (default: smart-case, i.e. case-sensitive only when the pattern contains uppercase)" }),
	),
	literal: Type.Optional(Type.Boolean({ description: "Treat the pattern as a literal string instead of a regular expression" })),
	context: Type.Optional(Type.Number({ description: "Number of context lines to show before and after each match" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	outputMode: Type.Optional(
		StringEnum(["content", "count", "filesWithMatches"] as const, {
			description:
				"Output mode: content (default) returns matched lines, count returns per-file counts, filesWithMatches returns matching file paths only",
		}),
	),
});

type GrepParams = Static<typeof grepSchema>;

export interface GrepToolDetails {
	truncation?: { truncated: boolean; maxBytes?: number };
	matchLimitReached?: number;
	linesTruncated?: boolean;
	/** Which engine produced the result: "rg" (fast path) or "ts" (pure TS). */
	backend?: "rg" | "ts";
}

export interface GrepToolConfig {
	/** Prefer the rg binary when available. Default: true. */
	rgFirst?: boolean;
}

const grepDescription = `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`;

export function registerGrepTool(pi: ExtensionAPI, config: GrepToolConfig = {}): void {
	const definition: ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> = {
		name: "grep",
		label: "Grep",
		description: grepDescription,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeGrep(params, config, signal, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return renderGrepCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderGrepResult(result, options, theme, context);
		},
	};
	pi.registerTool(definition);
}

export async function executeGrep(
	params: GrepParams,
	config: GrepToolConfig,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: GrepToolDetails | undefined }> {
	const searchPath = resolveToolPath(params.path ?? ".", cwd);
	let isDirectory = false;
	try {
		isDirectory = (await stat(searchPath)).isDirectory();
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}

	const contextValue = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
	const mode: SearchMode = params.outputMode ?? "content";

	// rg fast path (content mode only); fall back to the TS engine.
	if (mode === "content" && config.rgFirst !== false && (await findRg())) {
		let rgMatches: RgMatch[];
		let limitReached = false;
		try {
			const result = await runRg({
				root: searchPath,
				rootIsDirectory: isDirectory,
				pattern: params.pattern,
				signal,
				ignoreCase: params.ignoreCase,
				literal: params.literal,
				glob: params.glob,
				limit: effectiveLimit,
				context: contextValue,
			});
			rgMatches = result.matches;
			limitReached = result.limitReached;
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			// rg failed (regex dialect, permissions, ...): fall back to the TS
			// engine. An invalid pattern surfaces as the TS engine's error.
			rgMatches = [];
			limitReached = false;
			const tsResult = await searchFiles(params.pattern, {
				root: searchPath,
				signal,
				limit: effectiveLimit,
				context: contextValue,
				glob: params.glob,
				pattern: { literal: params.literal, ignoreCase: params.ignoreCase },
				mode,
			});
			return formatTsResult(tsResult.files, tsResult.limitReached, searchPath, isDirectory, contextValue, effectiveLimit);
		}
		return await formatRgResult(rgMatches, limitReached, searchPath, isDirectory, contextValue, effectiveLimit, signal);
	}

	// Pure-TS engine (also covers count / filesWithMatches modes).
	const result = await searchFiles(params.pattern, {
		root: searchPath,
		signal,
		limit: effectiveLimit,
		context: contextValue,
		glob: params.glob,
		pattern: { literal: params.literal, ignoreCase: params.ignoreCase },
		mode,
	});
	return formatTsResult(result.files, result.limitReached, searchPath, isDirectory, contextValue, effectiveLimit);
}

function formatPath(searchPath: string, isDirectory: boolean, filePath: string): string {
	if (isDirectory) {
		const posix = filePath.split(path.sep).join("/").replace(/^\.\//, "");
		if (posix && !posix.startsWith("..")) return posix;
	}
	return path.basename(filePath);
}

async function readFileLines(absolutePath: string): Promise<string[]> {
	try {
		const content = await readFile(absolutePath, "utf8");
		return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	} catch {
		return [];
	}
}

function formatTsResult(
	files: FileMatch[],
	limitReached: boolean,
	searchPath: string,
	isDirectory: boolean,
	contextValue: number,
	effectiveLimit: number,
) {
	const outputLines: string[] = [];
	let linesTruncated = false;
	for (const file of files) {
		if (file.matchCount === 0 && file.lines.length === 0) continue;
		const rel = formatPath(searchPath, isDirectory, file.relPath);
		for (const line of file.lines) {
			const { text, wasTruncated } = truncateLine(line.text);
			if (wasTruncated) linesTruncated = true;
			const marker = line.isMatch ? ":" : "-";
			outputLines.push(`${rel}${marker}${line.lineNumber}${marker} ${text}`);
		}
	}
	return assembleOutput(outputLines, limitReached, effectiveLimit, linesTruncated, "ts");
}

async function formatRgResult(
	matches: RgMatch[],
	limitReached: boolean,
	searchPath: string,
	isDirectory: boolean,
	contextValue: number,
	effectiveLimit: number,
	signal?: AbortSignal,
) {
	const outputLines: string[] = [];
	let linesTruncated = false;
	const fileCache = new Map<string, string[]>();
	for (const match of matches) {
		if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
		const rel = formatPath(searchPath, isDirectory, match.filePath);
		if (contextValue === 0) {
			const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
			const { text, wasTruncated } = truncateLine(sanitized);
			if (wasTruncated) linesTruncated = true;
			outputLines.push(`${rel}:${match.lineNumber}: ${text}`);
			continue;
		}
		// Context blocks are built by re-reading the file (pi behavior), so
		// context rendering is identical across engines.
		const abs = isDirectory ? path.join(searchPath, ...match.filePath.split("/")) : searchPath;
		let lines = fileCache.get(abs);
		if (!lines) {
			lines = await readFileLines(abs);
			fileCache.set(abs, lines);
		}
		if (lines.length === 0) {
			outputLines.push(`${rel}:${match.lineNumber}: (unable to read file)`);
			continue;
		}
		const start = Math.max(1, match.lineNumber - contextValue);
		const end = Math.min(lines.length, match.lineNumber + contextValue);
		for (let current = start; current <= end; current++) {
			const lineText = lines[current - 1] ?? "";
			const sanitized = lineText.replace(/\r/g, "");
			const { text, wasTruncated } = truncateLine(sanitized);
			if (wasTruncated) linesTruncated = true;
			if (current === match.lineNumber) {
				outputLines.push(`${rel}:${current}: ${text}`);
			} else {
				outputLines.push(`${rel}-${current}- ${text}`);
			}
		}
	}
	return assembleOutput(outputLines, limitReached, effectiveLimit, linesTruncated, "rg");
}

function assembleOutput(
	outputLines: string[],
	matchLimitReached: boolean,
	effectiveLimit: number,
	linesTruncated: boolean,
	backend: "rg" | "ts",
): { content: { type: "text"; text: string }[]; details: GrepToolDetails | undefined } {
	if (outputLines.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	}
	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: GrepToolDetails = { backend };
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = { truncated: true, maxBytes: DEFAULT_MAX_BYTES };
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text: output }], details };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderGrepCall(args: GrepParams, theme: Theme, context: { lastComponent?: unknown }): Component {
	const pattern = args.pattern ?? "";
	const pathDisplay = args.path ?? ".";
	const detail = `${theme.fg("accent", `/${pattern}/`)}${args.ignoreCase ? " (i)" : ""} in ${theme.fg("toolOutput", pathDisplay)}`;
	const cached = context.lastComponent;
	const text = theme.fg("toolTitle", theme.bold("grep")) + ` ${detail}`;
	if (cached && typeof cached === "object" && cached !== null && "setText" in cached) {
		const settable = cached as { setText?: (t: string) => void };
		if (typeof settable.setText === "function") {
			settable.setText(text);
			return cached as unknown as Component;
		}
	}
	return renderToolCall("grep", "", detail, theme);
}

function renderGrepResult(
	result: { content?: unknown; isError?: boolean; details?: unknown },
	options: ToolRenderResultOptions,
	theme: Theme,
	_context: { lastComponent?: unknown },
): Component {
	return renderToolResult(result, options, theme);
}