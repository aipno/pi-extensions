/**
 * Line-ending handling shared by the read/edit/write tools.
 */

/** Normalize CRLF/CR line endings to LF. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize for fuzzy match (pi edit semantics): NFKC, strip trailing
 * whitespace per line, fold smart quotes/dashes/spaces to ASCII. Used by the
 * edit tool's fallback matching, which lets the model omit trailing spaces
 * and use typographic characters when copying text.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line.
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Dashes/hyphens → - (U+2010..U+2015, U+2212)
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space (NBSP, en/quads, narrow NBSP, math space, ideographic)
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/** Detect the dominant line ending of a text. */
export function detectLineEnding(content: string): string {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Restore line endings after LF-normalized processing. */
export function restoreLineEndings(text: string, ending: string): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Split on LF, preserving a final empty element only when the content ends
 * with a trailing newline (matches `"...\n".split("\n")` semantics).
 */
export function splitLines(content: string): string[] {
	return content.split("\n");
}

/**
 * Split like `diff`/pi do: trailing newline does not produce a phantom empty
 * line, but "a\nb\n\n" (two newlines) does. Lines keep their line endings.
 */
export function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/**
 * Split for the display/unified diff formatters: like
 * `splitLinesWithEndings` but strips the trailing newline of each line so
 * formatters can append their own separators.
 */
export function splitForDiff(content: string): string[] {
	return splitLinesWithEndings(content).map((line) => (line.endsWith("\n") ? line.slice(0, -1) : line));
}

/** Join lines back with LF. */
export function joinLines(lines: string[]): string {
	return lines.join("\n");
}