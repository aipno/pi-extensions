/**
 * write tool — self-implemented file writer replacing pi's built-in `write`.
 *
 * Atomic (temp file + rename), creates parent directories, participates in
 * pi's per-file mutation queue so parallel edits/writes to the same file stay
 * serialized.
 */

import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import { resolveToolPath } from "../lib/path-utils.ts";
import { renderToolCall, renderToolResult } from "./render.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path of the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full content to write to the file (overwrites existing content)" }),
});

type WriteParams = Static<typeof writeSchema>;

const writeDescription = "Create or overwrite a file with the given content. Parent directories are created automatically. Use only for new files or complete rewrites; for precise changes use the edit tool.";

export function registerWriteTool(pi: ExtensionAPI): void {
	const definition: ToolDefinition<typeof writeSchema, undefined> = {
		name: "write",
		label: "write",
		description: writeDescription,
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: writeSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWrite(params, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return renderWriteCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme);
		},
	};
	pi.registerTool(definition);
}

export async function executeWrite(
	params: WriteParams,
	cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: undefined }> {
	const absolutePath = resolveToolPath(params.path, cwd);

	return withFileMutationQueue(absolutePath, async () => {
		const dir = path.dirname(absolutePath);
		let existed = false;
		try {
			existed = (await stat(absolutePath)).isFile();
		} catch {
			// new file
		}
		await mkdir(dir, { recursive: true });

		// Atomic write: temp file in the same directory, then rename.
		const tmpPath = path.join(dir, `.pi-tools-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
		try {
			await writeFile(tmpPath, params.content, "utf8");
			await rename(tmpPath, absolutePath);
		} catch (err) {
			// Best-effort temp cleanup on failure.
			try {
				await rm(tmpPath, { force: true });
			} catch {
				// already gone
			}
			throw err;
		}

		const action = existed ? "Updated" : "Created";
		const bytes = Buffer.byteLength(params.content, "utf8");
		return {
			content: [
				{
					type: "text",
					text: `${action} ${params.path} (${bytes} bytes)`,
				},
			],
			details: undefined,
		};
	});
}

function renderWriteCall(args: WriteParams, theme: Theme, context: { lastComponent?: unknown }): Component {
	const detail = theme.fg("toolOutput", args.path);
	return renderToolCall("write", "", detail, theme);
}