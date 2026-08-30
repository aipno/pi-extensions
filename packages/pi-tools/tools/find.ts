/**
 * find tool — self-implemented glob file search replacing pi's built-in `find`.
 *
 * Uses the package's own glob engine and gitignore-aware walker. Output
 * format matches pi's built-in (relative paths, one per line).
 */

import { stat } from "node:fs/promises";
import type { ExtensionAPI, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import { globToRegExp } from "../engine/glob.ts";
import { walkFiles } from "../engine/walker.ts";
import { resolveToolPath } from "../lib/path-utils.ts";
import { renderToolCall, renderToolResult } from "./render.ts";

export const FIND_DEFAULT_LIMIT = 1000;

const findSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match file paths against, e.g. '**/*.ts' or '*.spec.ts'" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 1000)" })),
});

type FindParams = Static<typeof findSchema>;

export interface FindToolDetails {
	truncation?: { truncated: boolean; maxBytes?: number };
	resultLimitReached?: number;
}

const findDescription = `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`;

export function registerFindTool(pi: ExtensionAPI): void {
	const definition: ToolDefinition<typeof findSchema, FindToolDetails | undefined> = {
		name: "find",
		label: "Find",
		description: findDescription,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeFind(params, signal, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return renderFindCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme);
		},
	};
	pi.registerTool(definition);
}

export async function executeFind(
	params: FindParams,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: FindToolDetails | undefined }> {
	const searchPath = resolveToolPath(params.path ?? ".", cwd);
	try {
		if (!(await stat(searchPath)).isDirectory()) {
			throw new Error("Not a directory");
		}
	} catch (err) {
		if (err instanceof Error && err.message === "Not a directory") {
			throw new Error(`Path is not a directory: ${searchPath}`);
		}
		throw new Error(`Path not found: ${searchPath}`);
	}

	const effectiveLimit = Math.max(1, params.limit ?? FIND_DEFAULT_LIMIT);
	const results: string[] = [];
	// Mirror fd's semantics: a path-containing pattern (e.g. 'src/**/*.ts')
	// matches against the full relative path, anything else matches the
	// basename at any depth.
	const pattern = params.pattern;
	const basenameOnly = !pattern.includes("/");
	const regex = globToRegExp(pattern, { basenameOnly });

	await walkFiles({
		root: searchPath,
		signal,
		onFile: (file) => {
			if (results.length >= effectiveLimit) return;
			if (regex.test(file.relPath)) results.push(file.relPath);
		},
	});

	const resultLimitReached = results.length >= effectiveLimit;
	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached`);
		details.resultLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = { truncated: true, maxBytes: DEFAULT_MAX_BYTES };
	}
	let output = truncation.content;
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	if (results.length === 0) {
		return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

function renderFindCall(args: FindParams, theme: Theme, context: { lastComponent?: unknown }): Component {
	const detail = `${theme.fg("accent", args.pattern)} in ${theme.fg("toolOutput", args.path ?? ".")}`;
	return renderToolCall("find", "", detail, theme);
}