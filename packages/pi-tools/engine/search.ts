/**
 * Pure-TypeScript line search engine — the grep fallback core.
 *
 * Features: smart-case, literal matching, context lines, global match limit,
 * per-file byte cap, binary skip, multiline-tolerant newline splitting via
 * streaming chunk reads. Output is collected as per-file structured matches
 * that the grep tool formats pi-compatibly (`path:line: text`).
 */

import { readFile } from "node:fs/promises";
import { isProbablyBinary } from "../lib/binary.ts";
import { walkFiles } from "./walker.ts";

export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LIMIT = 100;

/** smart-case: a pattern with no uppercase letters searches case-insensitively. */
export function hasUpperCase(pattern: string): boolean {
	return /[A-Z]/.test(pattern);
}

export interface PatternOptions {
	/** Treat the pattern as a literal string (escaped). */
	literal?: boolean;
	/** Force case-insensitive matching. Overrides smart-case. */
	ignoreCase?: boolean;
	/** Disable smart-case (always case-sensitive unless ignoreCase). */
	noSmartCase?: boolean;
}

/** Build the RegExp for a pattern honoring smart-case / literal rules. */
export function buildMatcher(pattern: string, options: PatternOptions = {}): RegExp {
	const flags: string[] = [];
	if (options.ignoreCase) {
		flags.push("i");
	} else if (!options.noSmartCase && !hasUpperCase(pattern)) {
		// ripgrep default: smart-case.
		flags.push("i");
	}
	const source = options.literal ? escapeRegExp(pattern) : pattern;
	return new RegExp(source, flags.join(""));
}

export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MatchLine {
	/** 1-based line number. */
	lineNumber: number;
	/** Line text without the trailing newline. */
	text: string;
	/** True for actual matches, false for context lines. */
	isMatch: boolean;
}

export interface FileMatch {
	/** Absolute path. */
	absolutePath: string;
	/** Posix path relative to the search root. */
	relPath: string;
	/** Matched lines plus context, in line order. */
	lines: MatchLine[];
	/** Total matches in this file (independent of context). */
	matchCount: number;
	/** True when the file was skipped entirely. */
	skipped?: "binary" | "too-large";
}

/** Search mode: content lines, per-file counts, or matching file paths. */
export type SearchMode = "content" | "count" | "filesWithMatches";

export interface SearchFilesOptions {
	/** Absolute search root. */
	root: string;
	/** Abort signal. */
	signal?: AbortSignal;
	/**
	 * Global stop condition: content mode counts matches, count mode and
	 * filesWithMatches mode count matching files.
	 */
	limit?: number;
	/** Context lines before/after each match (content mode only). */
	context?: number;
	/** Glob filter for file paths (rg `--glob`). */
	glob?: string;
	/** Glob case-insensitive. */
	globIgnoreCase?: boolean;
	/** Pattern options (literal, ignoreCase, smart-case control). */
	pattern: PatternOptions;
	/** Per-file byte cap. */
	maxFileBytes?: number;
	/** Walk concurrency. */
	concurrency?: number;
	/** When true, ignore files are not consulted. */
	noIgnore?: boolean;
	/** Output mode. Default: "content". */
	mode?: SearchMode;
}

export interface SearchFilesResult {
	files: FileMatch[];
	/** Total match count across files (respects limit). */
	totalMatches: number;
	/** True when the global limit stopped the search early. */
	limitReached: boolean;
	skippedFiles: number;
}

function countMatchesInText(text: string, re: RegExp): number {
	const clone = new RegExp(re.source, re.flags + "g");
	clone.lastIndex = 0;
	let count = 0;
	for (const _ of text.matchAll(clone)) count++;
	return count;
}

/**
 * Search a single file's text. `text` has LF line endings.
 */
export function searchInText(
	text: string,
	re: RegExp,
	context = 0,
	limit?: number,
): { lines: MatchLine[]; matchCount: number } {
	const isGlobal = re.flags.includes("g");
	const matchRe = isGlobal ? re : new RegExp(re.source, re.flags + "g");
	const lines = text.split("\n");
	// A trailing newline yields a final empty line that rg does not report.
	if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) {
		lines.pop();
	}

	const matched = new Set<number>();
	let matchCount = 0;
	for (let i = 0; i < lines.length && (limit === undefined || matchCount < limit); i++) {
		matchRe.lastIndex = 0;
		if (matchRe.test(lines[i])) {
			matched.add(i);
			matchCount++;
		}
	}

	if (context === 0 && limit === undefined) {
		// Fast path: no context bookkeeping needed.
		const out: MatchLine[] = [];
		for (const i of matched) out.push({ lineNumber: i + 1, text: lines[i], isMatch: true });
		return { lines: out, matchCount };
	}

	// Context windowing.
	const output: MatchLine[] = [];
	const seen = new Set<number>();
	const sorted = [...matched].sort((a, b) => a - b);
	let emitted = 0;
	for (const mi of sorted) {
		if (limit !== undefined && emitted >= limit) break;
		const start = context > 0 ? Math.max(0, mi - context) : mi;
		const end = context > 0 ? Math.min(lines.length - 1, mi + context) : mi;
		for (let i = start; i <= end; i++) {
			if (seen.has(i)) continue;
			seen.add(i);
			output.push({ lineNumber: i + 1, text: lines[i], isMatch: i === mi || matched.has(i) });
			emitted++;
			if (limit !== undefined && emitted >= limit) break;
		}
	}
	return { lines: output, matchCount };
}

/**
 * Search all files under `root` with the pure-TS engine.
 * Files that fail to read, are binary, or exceed the byte cap are skipped.
 */
export async function searchFiles(
	pattern: string,
	options: SearchFilesOptions,
): Promise<SearchFilesResult> {
	const re = buildMatcher(pattern, options.pattern);
	const limit = options.limit ?? DEFAULT_LIMIT;
	const context = options.context ?? 0;
	const mode = options.mode ?? "content";
	let totalMatches = 0;
	let limitReached = false;
	let skippedFiles = 0;
	const files: FileMatch[] = [];

	await walkFiles({
		root: options.root,
		signal: options.signal,
		concurrency: options.concurrency,
		glob: options.glob,
		globOptions: options.globIgnoreCase ? { ignoreCase: true } : undefined,
		maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		noIgnore: options.noIgnore,
		onSkip: (file, reason) => {
			if (reason !== "glob") skippedFiles++;
			void file;
		},
		onFile: async (file) => {
			if (limitReached) return;
			let buf: Buffer;
			try {
				buf = await readFile(file.absolutePath);
			} catch {
				return;
			}
		if (isProbablyBinary(buf)) {
			skippedFiles++;
			return;
		}
			const text = normalizeToLF(buf.toString("utf8"));
			if (mode === "count") {
				const count = countMatchesInText(text, re);
				if (count === 0) return;
				files.push({ absolutePath: file.absolutePath, relPath: file.relPath, lines: [], matchCount: count });
				totalMatches += count;
				if (files.length >= limit) limitReached = true;
				return;
			}
			if (mode === "filesWithMatches") {
				const { matchCount } = searchInText(text, re, 0, 1);
				if (matchCount === 0) return;
				files.push({ absolutePath: file.absolutePath, relPath: file.relPath, lines: [], matchCount: 1 });
				totalMatches += 1;
				if (files.length >= limit) limitReached = true;
				return;
			}
			const remaining = limit - totalMatches;
			const { lines, matchCount } = searchInText(text, re, context, remaining > 0 ? remaining : 0);
			if (matchCount === 0 && lines.length === 0) return;
			totalMatches += matchCount;
			files.push({
				absolutePath: file.absolutePath,
				relPath: file.relPath,
				lines,
				matchCount,
			});
			if (totalMatches >= limit) limitReached = true;
		},
	});

	return { files, totalMatches, limitReached, skippedFiles };
}

function normalizeToLF(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}