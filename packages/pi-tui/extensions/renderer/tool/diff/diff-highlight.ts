import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.ts";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import { MAX_HL_CHARS, shikiHighlightCache } from "./shiki-highlight.ts";
import { normalizeCodeWhitespace } from "./diff-text.ts";
import {
	applyInlineSpanHighlight,
	applyInlineSpanInverse,
	getLineBackground,
	resolveShikiTheme,
	type DiffPalette,
	type DiffTheme,
} from "./diff-palette.ts";
import { leadingIndentWidth, visualizeIndentAnsi } from "./diff-stream-guard.ts";
import type { DiffLineEntry, ParsedDiffEntry } from "./diff-parse.ts";
import type { DiffSpan } from "./diff-inline.ts";
import type { DiffEmphasisStyle } from "../../../config/config.ts";

export type CodeLineHighlighter = (line: string, entry: DiffLineEntry) => string;

/** 缩进可视化 cap：深缩进文件避免满屏 `·`（§0.1 定案）。 */
export const MAX_INDENT_GUIDE = 16;

function cleanCodeLine(line: string): string {
	return sanitizeToolResultText(line).replace(/\n/g, "");
}

export function shouldHighlightCodeBlock(code: string): boolean {
	return code.length <= MAX_HL_CHARS;
}

export function resolveLanguageFromPath(rawPath: string | undefined): string | undefined {
	if (!rawPath || !rawPath.trim()) {
		return undefined;
	}
	const normalizedPath = rawPath.replace(/^@/, "").trim();
	if (!normalizedPath) {
		return undefined;
	}
	try {
		return getLanguageFromPath(normalizedPath);
	} catch {
		return undefined;
	}
}

export function createCodeLineHighlighter(
	language: string | undefined,
	theme: DiffTheme,
	entries: readonly ParsedDiffEntry[],
	invalidate?: () => void,
): CodeLineHighlighter {
	const codeEntries = entries.filter((entry): entry is DiffLineEntry => entry.kind === "line");
	const cleanLines = codeEntries.map((entry) =>
		cleanCodeLine(normalizeCodeWhitespace(entry.content)),
	);
	const code = cleanLines.join("\n");
	const shouldHighlight = !!language && shouldHighlightCodeBlock(code);
	const fallbackLines = shouldHighlight
		? (() => {
				try {
					return highlightCode(code, language).map(sanitizeAnsiForThemedOutput);
				} catch {
					return cleanLines.map(sanitizeAnsiForThemedOutput);
				}
			})()
		: cleanLines.map(sanitizeAnsiForThemedOutput);
	const fallbackByEntry = new WeakMap(
		codeEntries.map((entry, index) => [entry, fallbackLines[index] ?? cleanLines[index] ?? ""]),
	);
	if (!shouldHighlight) return (_line, entry) => fallbackByEntry.get(entry) ?? "";

	const shikiTheme = resolveShikiTheme(theme);
	let highlightedByEntry: WeakMap<DiffLineEntry, string> | undefined;
	const resolveHighlighted = () => {
		if (highlightedByEntry) return;
		const highlighted = shikiHighlightCache.get(
			code,
			language,
			shikiTheme,
			fallbackLines,
			invalidate,
		);
		if (highlighted) {
			highlightedByEntry = new WeakMap(
				codeEntries.map((entry, index) => [
					entry,
					sanitizeAnsiForThemedOutput(highlighted[index] ?? fallbackByEntry.get(entry) ?? ""),
				]),
			);
		}
	};
	resolveHighlighted();
	return (_line, entry) => {
		resolveHighlighted();
		return highlightedByEntry?.get(entry) ?? fallbackByEntry.get(entry) ?? "";
	};
}

/** highlightDiffLine 的可选项：缩进可视化与强调样式的运行时开关（live config）。 */
export interface DiffLineHighlightOptions {
	/** 行内改动片段强调：bg = 混合背景色（默认，行为不变）；inverse = SGR 7 反显。 */
	emphasisStyle?: DiffEmphasisStyle;
	/** 行首缩进可视化（`·`，cap 16）。 */
	indentGuide?: boolean;
	/** indentGuide 时 `·` 的着色器（通常 theme.fg("dim", …)）。 */
	indentPaint?: (text: string) => string;
}

export function highlightDiffLine(
	codeText: string,
	entry: DiffLineEntry,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	options: DiffLineHighlightOptions = {},
): { highlighted: string; rowBg: string | undefined } {
	const syntaxHighlighted = highlightLine(codeText, entry);
	const rowBg = getLineBackground(entry.lineKind, palette, false);
	const inlineSpans = inlineHighlights.get(entry) ?? [];
	const emphasisStyle = options.emphasisStyle ?? "bg";
	let highlighted =
		emphasisStyle === "inverse"
			? applyInlineSpanInverse(codeText, syntaxHighlighted, inlineSpans, rowBg)
			: applyInlineSpanHighlight(
					codeText,
					syntaxHighlighted,
					inlineSpans,
					getLineBackground(entry.lineKind, palette, true),
					rowBg,
					containerBgAnsi,
				);
	if (options.indentGuide) {
		const indent = Math.min(leadingIndentWidth(codeText), MAX_INDENT_GUIDE);
		if (indent > 0) {
			const paint =
				options.indentPaint ??
				((text: string) => {
					// 防御：着色器失败（无 dim 色）回退裸 `·`，不产出错误内容。
					return text;
				});
			highlighted = visualizeIndentAnsi(codeText, highlighted, indent, paint);
		}
	}
	return { highlighted, rowBg };
}
