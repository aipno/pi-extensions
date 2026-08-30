/**
 * Self-implemented .gitignore / .ignore parser and matcher.
 *
 * Implements the gitignore pattern semantics used by ripgrep:
 * - `#` comments, `\#`/`\!` escapes
 * - `!` negation (last matching pattern wins)
 * - trailing `/` marks directory-only patterns
 * - leading `/` anchors to the ignore file's directory
 * - patterns without a slash (other than a trailing one) match basenames at
 *   any depth below the ignore file's directory
 * - `*`, `?`, `**` and `[...]` classes
 */

import { globToRegExp } from "./glob.ts";

export interface IgnorePattern {
	/** The pattern source (for diagnostics). */
	source: string;
	/** Negated (`!` prefix). */
	negated: boolean;
	/** Directory-only (trailing `/`). */
	dirOnly: boolean;
	/** Compiled matcher: posix path relative to the ignore file's dir. */
	regex: RegExp;
}

/** Parse one ignore-file line into a pattern (or null for blank/comment). */
export function parseIgnoreLine(rawLine: string): IgnorePattern | null {
	let line = rawLine;
	if (line.endsWith("\r")) line = line.slice(0, -1);

	// Trailing spaces are stripped unless escaped with backslash.
	line = line.replace(/(?<!\\)\s+$/, "");
	line = line.replace(/\\ $/, " ");

	if (line === "") return null;
	// A real comment starts with #; an escaped \# is a literal pattern.
	if (line.startsWith("#")) return null;
	if (line.startsWith("\\#")) line = line.slice(1);
	const bangWasEscaped = line.startsWith("\\!");
	if (bangWasEscaped) line = line.slice(1);

	let negated = false;
	let body = line;
	if (!bangWasEscaped && body.startsWith("!")) {
		negated = true;
		body = body.slice(1);
	}
	if (body === "") return null;

	let dirOnly = false;
	if (body.endsWith("/")) {
		dirOnly = true;
		body = body.slice(0, -1);
	}

	// gitignore patterns starting with a slash are anchored to the ignore
	// file's directory; the slash itself is dropped. Patterns without an
	// internal slash match basenames at any depth.
	let regex: RegExp;
	if (body.startsWith("/")) {
		regex = globToRegExp(body.slice(1), { anchoredOnly: true });
	} else if (body.includes("/")) {
		regex = globToRegExp(body, { basenameOnly: false });
	} else {
		regex = globToRegExp(body, { basenameOnly: true });
	}

	return {
		source: rawLine,
		negated,
		dirOnly,
		regex,
	};
}

export type IgnoreDecision = "ignored" | "allowed" | "none";

/**
 * Matcher for a stack of ignore rules (innermost directory first).
 * A path is ignored when the LAST matching rule says so.
 */
export class IgnoreMatcher {
	private readonly patterns: IgnorePattern[];

	constructor(patterns: IgnorePattern[]) {
		this.patterns = patterns;
	}

	get isEmpty(): boolean {
		return this.patterns.length === 0;
	}

	/**
	 * Evaluate a posix-relative path (from the ignore file's base dir).
	 * Returns "ignored", "allowed" (negation matched), or "none" (no rule
	 * matched — caller keeps earlier decisions).
	 */
	ignored(relPath: string, isDir: boolean): IgnoreDecision {
		let decision: IgnoreDecision = "none";
		for (const p of this.patterns) {
			if (p.dirOnly && !isDir) continue;
			if (p.regex.test(relPath)) {
				decision = p.negated ? "allowed" : "ignored";
			}
		}
		return decision;
	}
}

/**
 * Parse the contents of an ignore file (`.gitignore` or `.ignore`).
 */
export function parseIgnoreFile(content: string): IgnorePattern[] {
	const patterns: IgnorePattern[] = [];
	for (const rawLine of content.split("\n")) {
		const parsed = parseIgnoreLine(rawLine);
		if (parsed) patterns.push(parsed);
	}
	return patterns;
}