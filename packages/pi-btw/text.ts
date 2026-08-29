/**
 * Small text helpers shared by the btw UI (sanitization, terminal escaping).
 */

/** Collapse whitespace and strip control characters from a single display line. */
export function sanitizeSingleLine(text: string): string {
	return [...text.replace(/[\r\n\t]/gu, " ")]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && (code < 127 || code > 159);
		})
		.join("")
		.replace(/ +/gu, " ")
		.trim();
}

/** Escape control characters as \xNN so renderers cannot be spoofed by message content. */
export function escapeTerminalControls(text: string): string {
	return [...text]
		.map((character) => {
			const code = character.charCodeAt(0);
			if (code <= 31 || (code >= 127 && code <= 159)) {
				return `\\x${code.toString(16).padStart(2, "0")}`;
			}
			return character;
		})
		.join("");
}

/** Truncate a single-line preview with an ellipsis. */
export function truncatePreview(text: string, maxLength = 72): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}