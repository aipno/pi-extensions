/**
 * Self-implemented glob pattern matcher.
 *
 * Supports the subset used by ripgrep/fd for `--glob` and the `find` tool:
 * `*`, `?`, `**`, character classes `[abc]` / `[!abc]` / ranges, and brace
 * alternation `{a,b}`. Patterns are matched against posix-normalized paths
 * relative to the search root.
 */

export interface GlobOptions {
	/**
	 * Match against the basename only (fd `--glob` default). A pattern
	 * without `/` always matches basenames at any depth.
	 */
	basenameOnly?: boolean;
	/**
	 * Force path anchoring even when the pattern has no `/` (gitignore
	 * `/pattern` semantics). Ignored when basenameOnly is set.
	 */
	anchoredOnly?: boolean;
	/** Case-insensitive matching (fd --glob defaults to smartcase; we keep explicit). */
	ignoreCase?: boolean;
}

/**
 * Escape regex metacharacters in a literal glob segment.
 */
function escapeRegex(ch: string): string {
	return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function parseCharClass(body: string): string {
	// body is the content between brackets (leading ! or ^ handled here).
	let negated = false;
	let content = body;
	if (content.startsWith("!") || content.startsWith("^")) {
		negated = true;
		content = content.slice(1);
	}
	// Escape regex metacharacters inside the class except ranges and `]`.
	let inner = "";
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === "\\") {
			inner += `\\${content[i + 1] ?? ""}`;
			i++;
		} else if (ch === "-" && i > 0 && i < content.length - 1) {
			inner += "-";
		} else if (/[\\^$.*+?()[\]{}|]/.test(ch)) {
			inner += `\\${ch}`;
		} else {
			inner += ch;
		}
	}
	return `[${negated ? "^" : ""}${inner}]`;
}

interface ParsedGlob {
	/** Segments produced by splitting on `/` (after brace expansion). */
	segments: string[];
	/** True when the pattern contains at least one slash (path-anchored). */
	anchored: boolean;
	source: string;
}

/**
 * Expand `{a,b}` alternations into concrete patterns. Depth-limited to avoid
 * pathological expansion.
 */
function expandBraces(pattern: string, depth = 0): string[] {
	if (depth > 6) return [pattern.replace(/[{}]/g, "")];
	const start = pattern.indexOf("{");
	if (start === -1) return [pattern];
	let depthScan = 0;
	let end = -1;
	for (let i = start; i < pattern.length; i++) {
		if (pattern[i] === "{") depthScan++;
		else if (pattern[i] === "}") {
			depthScan--;
			if (depthScan === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return [pattern.replace(/[{}]/g, "")];
	const alternatives = pattern.slice(start + 1, end).split(",");
	const prefix = pattern.slice(0, start);
	const suffix = pattern.slice(end + 1);
	const out: string[] = [];
	for (const alt of alternatives) {
		for (const expanded of expandBraces(prefix + alt + suffix, depth + 1)) {
			out.push(expanded);
		}
	}
	return out;
}

/** Build a RegExp from a pattern, matching posix paths. */
export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
	const expanded = expandBraces(pattern);
	if (expanded.length === 1) {
		return singleGlobToRegExp(expanded[0], options);
	}
	// Alternation of each brace-expanded pattern against the whole path.
	const alternatives = expanded.map((p) => singleGlobToRegExp(p, options).source);
	// Wrap: match the start of the basename too when basenameOnly wasn't set
	// but an alternative uses `^`. We anchor each alternative.
	return new RegExp(`^(?:${alternatives.map((s) => s.replace(/^\^/, "")).join("|")})$`, options.ignoreCase ? "i" : "");
}

function singleGlobToRegExp(pattern: string, options: GlobOptions): RegExp {
	const basenameOnly =
		options.basenameOnly || (!options.anchoredOnly && !pattern.includes("/"));
	const flag = options.ignoreCase ? "i" : "";

	const parts: string[] = [];
	const segs = pattern.split("/").filter((s) => s !== "");
	let prevWasGlobStar = false;
	for (let i = 0; i < segs.length; i++) {
		const segment = segs[i];
		const isLast = i === segs.length - 1;
		if (segment === "**") {
			if (prevWasGlobStar) continue; // collapse consecutive **
			if (isLast) {
				// Final ** matches everything below the prefix.
				parts.push(i > 0 ? "/.*" : ".*");
			} else {
				// Mid ** swallows both its separators (leading kept explicit).
				parts.push(i > 0 ? "/(?:.*/)?" : "(?:.*/)?");
			}
		} else {
			if (i > 0 && !prevWasGlobStar) parts.push("/");
			parts.push(segmentToRegexSource(segment));
		}
		prevWasGlobStar = segment === "**";
	}

	// Pattern without slashes: match against the trailing basename at any depth.
	if (basenameOnly) {
		return new RegExp(`^(?:.*/)?${parts.join("")}$`, flag);
	}
	// Path-anchored pattern relative to the search root.
	return new RegExp(`^${parts.join("")}$`, flag);
}

function segmentToRegexSource(segment: string): string {
	let out = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		switch (ch) {
			case "*":
				out += "[^/]*";
				break;
			case "?":
				out += "[^/]";
				break;
			case "[":
				{
					const close = segment.indexOf("]", i + 1);
					if (close === -1) {
						out += "\\[";
					} else {
						out += parseCharClass(segment.slice(i + 1, close));
						i = close;
					}
				}
				break;
			case "\\":
				out += escapeRegex(segment[i + 1] ?? "\\");
				i++;
				break;
			default:
				out += escapeRegex(ch);
		}
	}
	return out;
}

/** Test a posix-normalized relative path (or absolute path) against a pattern. */
export function globMatch(pattern: string, path: string, options: GlobOptions = {}): boolean {
	return globToRegExp(pattern, options).test(path);
}