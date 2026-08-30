/**
 * read tool — self-implemented file reader replacing pi's built-in `read`.
 *
 * Text behavior (offset/limit, truncation notices, error strings) mirrors
 * pi's built-in exactly. Adds: binary detection, image attachments
 * (png/jpg/gif/webp/bmp), SQLite previews (node:sqlite), and ZIP/TAR archive
 * reading via the `::` member separator (`archive.zip::dir/file.txt`).
 */

import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, Theme, ToolDefinition, ToolRenderResultOptions, TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import { isProbablyBinary } from "../lib/binary.ts";
import { normalizeToLF } from "../lib/eol.ts";
import { resolveToolPath } from "../lib/path-utils.ts";
import { formatSqlitePreview, previewSqlite } from "../formats/sqlite.ts";
import { parseZip, readZipEntry, type ZipEntry } from "../formats/zip.ts";
import { loadTar, readTarEntry, type TarEntry } from "../formats/tar.ts";
import { renderToolCall, renderToolResult, type ToolContent } from "./render.ts";

type ToolReadResult = { content: ToolContent[]; details: ReadToolDetails | undefined };

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute). For archives use 'archive.zip::member/path'." }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

type ReadParams = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

const readDescription = `Read the contents of a file. Supports text files, images (jpg, png, gif, webp, bmp — sent as attachments), SQLite databases (table + row preview), and ZIP/TAR archives ('archive.zip::member' for member reading, plain 'archive.zip' lists entries). For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;

const IMAGE_MIME_BY_MAGIC: Array<{ mime: string; magic: number[] }> = [
	{ mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
	{ mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
	{ mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
	{ mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF....WEBP"
	{ mime: "image/bmp", magic: [0x42, 0x4d] },
];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ARCHIVE_LIST_LIMIT = 500;

export function registerReadTool(pi: ExtensionAPI): void {
	const definition: ToolDefinition<typeof readSchema, ReadToolDetails | undefined> = {
		name: "read",
		label: "read",
		description: readDescription,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeRead(params, signal, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return renderReadCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme);
		},
	};
	pi.registerTool(definition);
}

export async function executeRead(
	params: ReadParams,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<ToolReadResult> {
	if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");

	// Archive member access: `archive.zip::member/path`.
	const archiveSep = params.path.indexOf("::");
	if (archiveSep !== -1) {
		const archivePath = resolveToolPath(params.path.slice(0, archiveSep), cwd);
		const member = params.path.slice(archiveSep + 2).replace(/^\/+/, "");
		return readArchiveMember(archivePath, member, params, signal);
	}

	const absolutePath = resolveToolPath(params.path, cwd);
	let fileStat;
	try {
		fileStat = await stat(absolutePath);
	} catch {
		throw new Error(`Path not found: ${absolutePath}`);
	}
	if (fileStat.isDirectory()) {
		throw new Error(`Is a directory: ${absolutePath}. Use ls to list its contents.`);
	}

	const buf = await readFile(absolutePath);

	// Image attachments (magic-based).
	const mime = detectImageMime(buf);
	if (mime) {
		if (buf.length > MAX_IMAGE_BYTES) {
			return {
				content: [
					{
						type: "text",
						text: `Read image file [${mime}] but it is ${formatSize(buf.length)} (> ${formatSize(MAX_IMAGE_BYTES)}); not attached. Use bash to resize or inspect it.`,
					},
				],
				details: undefined,
			};
		}
		return {
			content: [
				{ type: "text", text: `Read image file [${mime}]` },
				{ type: "image", data: buf.toString("base64"), mimeType: mime },
			],
			details: undefined,
		};
	}

	// SQLite preview.
	if (isSqlitePath(absolutePath) && buf.subarray(0, 16).toString("utf8").startsWith("SQLite format 3")) {
		const { tables, error } = await previewSqlite(absolutePath, { limit: Math.max(1, params.limit ?? 20) });
		if (error) {
			return { content: [{ type: "text", text: `SQLite preview unavailable: ${error}` }], details: undefined };
		}
		return {
			content: [{ type: "text", text: formatSqlitePreview(tables, Math.max(0, (params.offset ?? 1) - 1), params.limit ?? 20) }],
			details: undefined,
		};
	}

	// Archive listing first: archives are binary at the byte level. Zip is
	// detected by magic; tar by magic (gzip) or by extension (raw .tar).
	if (buf.length > 0) {
		const lower = absolutePath.toLowerCase();
		const looksLikeTar = /\.(tar|tar\.gz|tgz)$/.test(lower);
		const looksLikeZip = /\.(zip|jar|war|ear)$/.test(lower);
		if (isZipArchive(buf) && !looksLikeTar) {
			return listZip(absolutePath, buf, params, signal);
		}
		if (isGzipArchive(buf) || looksLikeTar) {
			return listTar(absolutePath, buf, params, signal, isGzipArchive(buf));
		}
		if (looksLikeZip) {
			// Extension says zip but magic does not: surface a parse error.
			return listZip(absolutePath, buf, params, signal);
		}
	}

	// Binary detection (text fallback for UTF-16 etc. is handled by the sniffer).
	if (isProbablyBinary(buf)) {
		return {
			content: [
				{
					type: "text",
					text: `Binary file detected (${formatSize(buf.length)}). read shows text, SQLite (.db) and archive (.zip/.tar) contents; use bash or grep for anything else.`,
				},
			],
			details: undefined,
		};
	}

	return readText(params, buf);
}

function detectImageMime(buf: Buffer): string | null {
	for (const { mime, magic } of IMAGE_MIME_BY_MAGIC) {
		if (buf.length >= magic.length && magic.every((byte, i) => buf[i] === byte)) {
			if (mime === "image/webp") {
				// RIFF/WEBP: bytes 8-12 must spell WEBP.
				if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return mime;
				continue;
			}
			return mime;
		}
	}
	return null;
}

function isSqlitePath(p: string): boolean {
	return /\.(db|sqlite|sqlite3)$/i.test(p);
}

function isZipArchive(buf: Buffer): boolean {
	return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function isGzipArchive(buf: Buffer): boolean {
	return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function readText(
	params: ReadParams,
	buf: Buffer,
): ToolReadResult {
	const textContent = normalizeToLF(buf.toString("utf8"));
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`);
	}

	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (params.limit !== undefined) {
		const endLine = Math.min(startLine + params.limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}

	const truncation = truncateHead(selectedContent);
	let outputText: string;
	const details: ReadToolDetails | undefined = truncation.truncated ? { truncation } : undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${DEFAULT_MAX_BYTES}]`;
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		outputText = truncation.content;
	}
	return { content: [{ type: "text", text: outputText }], details };
}

// ---------------------------------------------------------------------------
// Archive support
// ---------------------------------------------------------------------------

async function listArchive(
	archivePath: string,
	buf: Buffer,
	params: ReadParams,
	signal?: AbortSignal,
): Promise<ToolReadResult> {
	if (isGzipArchive(buf)) {
		return listTar(archivePath, buf, params, signal);
	}
	return listZip(archivePath, buf, params, signal);
}

function listZip(
	archivePath: string,
	buf: Buffer,
	params: ReadParams,
	signal?: AbortSignal,
): ToolReadResult {
	if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
	let entries: ZipEntry[];
	try {
		entries = parseZip(buf);
	} catch (err) {
		throw new Error(`Cannot read zip archive ${archivePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const out: string[] = [];
	const limit = Math.max(1, params.limit ?? ARCHIVE_LIST_LIMIT);
	const truncated = entries.length > limit;
	for (const entry of entries.slice(0, limit)) {
		out.push(entry.isDirectory ? `${entry.name}` : `${entry.size}\t${entry.name}`);
	}
	if (truncated) out.push(`[${entries.length - limit} more entries. Use read with limit= to see more, or 'archive.zip::dir/' to list a directory.]`);
	out.unshift(`Archive: ${archivePath} (${entries.length} entries)`);
	return { content: [{ type: "text", text: out.join("\n") }], details: undefined };
}

function listTar(
	archivePath: string,
	buf: Buffer,
	params: ReadParams,
	signal?: AbortSignal,
	isGzip = true,
): ToolReadResult {
	if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
	try {
		const { entries } = loadTar(buf, isGzip);
		const out: string[] = [];
		const limit = Math.max(1, params.limit ?? ARCHIVE_LIST_LIMIT);
		const truncated = entries.length > limit;
		for (const entry of entries.slice(0, limit)) {
			out.push(entry.isDirectory ? `${entry.name}/` : `${entry.size}\t${entry.name}`);
		}
		if (truncated) out.push(`[${entries.length - limit} more entries. Use 'archive.tar.gz::path/' to list a directory or '::file' to read one.]`);
		out.unshift(`Archive: ${archivePath} (${entries.length} entries)`);
		return { content: [{ type: "text", text: out.join("\n") }], details: undefined };
	} catch (err) {
		throw new Error(`Cannot read tar archive ${archivePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function readArchiveMember(
	archivePath: string,
	member: string,
	params: ReadParams,
	signal?: AbortSignal,
): Promise<ToolReadResult> {
	if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
	let buf: Buffer;
	try {
		buf = await readFile(archivePath);
	} catch {
		throw new Error(`Path not found: ${archivePath}`);
	}

	const memberPath = member.replace(/\/$/, "");
	const isDirRequest = member.endsWith("/") || member === "";

	const lowerArchive = archivePath.toLowerCase();
	const looksLikeTar = /\.(tar|tar\.gz|tgz)$/.test(lowerArchive);
	const looksLikeZip = /\.(zip|jar|war|ear)$/.test(lowerArchive);
	if (isZipArchive(buf) && !looksLikeTar) {
		let entries: ZipEntry[];
		try {
			entries = parseZip(buf);
		} catch (err) {
			throw new Error(`Cannot read zip archive ${archivePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const normalized = entries.map((e) => ({ e, path: e.name.replace(/\/$/, "") }));
		if (isDirRequest || member === "") {
			const prefix = memberPath === "" ? "" : `${memberPath}/`;
			// Immediate children only (no deeper nesting), dirs first.
			const children = normalized
				.filter(({ e, path: p }) => {
					if (prefix !== "" && !p.startsWith(prefix)) return false;
					const rest = prefix === "" ? p : p.slice(prefix.length);
					return rest !== "" && !rest.includes("/");
				})
				.sort((a, b) => (a.e.isDirectory === b.e.isDirectory ? a.path.localeCompare(b.path) : a.e.isDirectory ? -1 : 1));
			const out: string[] = [];
			for (const { e } of children) {
				out.push(e.isDirectory ? `${e.name}` : `${e.size}\t${e.name}`);
			}
			if (out.length === 0) out.push("(no entries)");
			return { content: [{ type: "text", text: out.join("\n") }], details: undefined };
		}
		const entry = entries.find((e) => e.name.replace(/\/$/, "") === memberPath || e.name === `${memberPath}/`);
		if (!entry) {
			throw new Error(`Archive member not found: ${member} in ${archivePath}`);
		}
		return renderArchiveMemberContent(entry.name, readZipEntry(buf, entry), params);
	}

	if (isGzipArchive(buf) || looksLikeTar) {
		const { entries, data } = loadTar(buf, isGzipArchive(buf));
		const entry = entries.find((e) => e.name.replace(/\/$/, "") === memberPath || e.name === `${memberPath}/`);
		if (!entry) {
			throw new Error(`Archive member not found: ${member} in ${archivePath}`);
		}
		return renderArchiveMemberContent(entry.name, readTarEntry(data, entry), params);
	}

	throw new Error(`Not an archive: ${archivePath}. Supported: .zip, .jar, .tar.gz, .tgz`);
}

function renderArchiveMemberContent(
	entryName: string,
	buf: Buffer,
	params: ReadParams,
): ToolReadResult {
	const mime = detectImageMime(buf);
	if (mime) {
		if (buf.length > MAX_IMAGE_BYTES) {
			return { content: [{ type: "text", text: `Image member [${mime}] too large (${formatSize(buf.length)}); not attached.` }], details: undefined };
		}
		return {
			content: [
				{ type: "text", text: `Read image member [${mime}] ${entryName}` },
				{ type: "image", data: buf.toString("base64"), mimeType: mime },
			],
			details: undefined,
		};
	}
	if (isProbablyBinary(buf)) {
		return { content: [{ type: "text", text: `Binary member (${formatSize(buf.length)}): ${entryName} — not shown.` }], details: undefined };
	}
	return readText({ ...params, path: entryName }, buf);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderReadCall(args: ReadParams, theme: Theme, context: { lastComponent?: unknown }): Component {
	const detail = theme.fg("toolOutput", args.path);
	const extras: string[] = [];
	if (args.offset !== undefined) extras.push(`offset ${args.offset}`);
	if (args.limit !== undefined) extras.push(`limit ${args.limit}`);
	const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
	return renderToolCall("read", "", `${detail}${theme.fg("muted", suffix)}`, theme);
}