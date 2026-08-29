/**
 * Minimal YAML frontmatter parser for agent definition files.
 *
 * Learned from nicobailon/pi-subagents src/agents/frontmatter.ts:
 * - Supports flat `key: value` and nested block values (`key:\n  sub: val`)
 * - Folded (`>`) and literal (`|`) block scalars
 * - List values may be comma-separated or `- item` blocks
 */

/** Fold a YAML folded block scalar while preserving more-indented lines and blank-line separators. */
function foldBlock(block: string): string {
	let folded = "";
	let hasContent = false;
	let previousIsMoreIndented = false;
	let blankLines = 0;
	for (const line of block.split("\n")) {
		const current = line.trimEnd();
		if (current.trim() === "") {
			if (hasContent) blankLines++;
			continue;
		}
		const currentIsMoreIndented = current.length > current.trimStart().length;
		if (hasContent) {
			if (blankLines > 0) {
				folded += "\n".repeat(blankLines + (previousIsMoreIndented || currentIsMoreIndented ? 1 : 0));
			} else {
				folded += previousIsMoreIndented || currentIsMoreIndented ? "\n" : " ";
			}
		}
		folded += current;
		hasContent = true;
		previousIsMoreIndented = currentIsMoreIndented;
		blankLines = 0;
	}
	return folded.trim();
}

/**
 * Normalize a frontmatter list: `a, b` or `- a\n- b` both yield ["a", "b"].
 */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split("\n")
		.flatMap((line) => {
			const value = line.trim();
			const listItem = value.match(/^-\s+(.+)$/);
			return (listItem?.[1] ?? value).split(",");
		})
		.map((value) => value.trim())
		.filter(Boolean);
}

export interface ParsedFrontmatter {
	frontmatter: Record<string, string>;
	body: string;
}

/**
 * Parse `---`-delimited frontmatter. Exact knowledge of the block structure
 * is not required; nested values are stored as strings with embedded
 * newlines and interpreted by the agent loader.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	// L9: find the closing delimiter line-by-line instead of a raw
	// indexOf("\n---") — a literal `---` line inside a block scalar (or any
	// earlier content) would have truncated the body prematurely. The
	// closing `---` must sit at column 0 (indented lines belong to block
	// scalars, not to the delimiter).
	const lines = normalized.slice(3).split("\n");
	let closeAt = -1;
	for (let i = 1; i < lines.length; i++) {
		if (/^---\s*$/.test(lines[i]!)) {
			closeAt = i;
			break;
		}
	}
	if (closeAt === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = lines.slice(1, closeAt).join("\n");
	const body = lines.slice(closeAt + 1).join("\n").trim();
	const fmLines = frontmatterBlock.split("\n");

	let currentKey: string | null = null;
	let currentBlockLines: string[] | null = null;
	let currentIndent: number | null = null;
	let currentFolded = false;
	let currentLiteral = false;

	const flush = () => {
		if (currentKey === null || currentBlockLines === null) return;
		const rawBlock = currentBlockLines.join("\n");
		const leadingSpaces = rawBlock.match(/^[ \t]+(?=\S)/m);
		const prefix = leadingSpaces?.[0] ?? "";
		const stripped = prefix
			? rawBlock.replace(new RegExp(`^${prefix}`, "gm"), "").replace(/^\n/, "")
			: rawBlock;
		frontmatter[currentKey] = currentFolded ? foldBlock(stripped) : stripped;
		currentKey = null;
		currentBlockLines = null;
		currentIndent = null;
		currentFolded = false;
		currentLiteral = false;
	};

	for (const line of fmLines) {
		const indent = line.search(/\S|$/);
		const trimmed = line.trim();
		if (currentKey !== null && currentBlockLines !== null && (indent > (currentIndent ?? 0) || ((currentFolded || currentLiteral) && trimmed === ""))) {
			currentBlockLines.push(line);
			continue;
		}
		flush();
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1];
		const rawValue = (match[2] ?? "").trim();
		if (key === undefined) continue;
		const isQuoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
		const value = isQuoted ? rawValue.slice(1, -1) : rawValue;
		const isFolded = !isQuoted && (rawValue === ">" || rawValue === ">-");
		const isLiteral = !isQuoted && (rawValue === "|" || rawValue === "|-");
		if (value === "" || isFolded || isLiteral) {
			currentKey = key;
			currentBlockLines = [];
			currentIndent = indent;
			currentFolded = isFolded;
			currentLiteral = isLiteral;
		} else {
			frontmatter[key] = value;
		}
	}
	flush();
	// NB: the trimmed body is returned — the raw `normalized` fallback is
	// only for the no-frontmatter / unterminated cases above.
	return { frontmatter, body };
}