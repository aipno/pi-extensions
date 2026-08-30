import {
	ANSI_SGR_PATTERN,
	expandSgrReset,
	filterSgrSequences,
	readSgrColorSequence,
	sequenceResetsInverse,
	toSgrParams,
	INVERSE_OPEN_ANSI,
	INVERSE_CLOSE_ANSI,
} from "./ansi-utils.ts";
import { ansi256ToRgb } from "../../../utils/ansi-color.ts";
import { rgbToBgAnsiForTerminal } from "../../../utils/terminal-capabilities.ts";
import { fitToWidth } from "./diff-text.ts";
import { mergeSpans, type DiffSpan } from "./diff-inline.ts";
import type { DiffLineKind } from "./diff-parse.ts";

export interface DiffTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
}

export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export interface DiffPalette {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
	addEmphasisBgAnsi: string;
	removeEmphasisBgAnsi: string;
}

const ADD_ROW_BACKGROUND_MIX_RATIO = 0.12;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.26;
const REMOVE_INLINE_EMPHASIS_MIX_RATIO = 0.26;
const ADDITION_TINT_TARGET: RgbColor = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET: RgbColor = { r: 232, g: 95, b: 122 };
export const ANSI_BG_RESET = "\x1b[49m";

export function emphasis(theme: DiffTheme, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function sequenceResetsBackground(params: number[]): boolean {
	let index = 0;
	while (index < params.length) {
		const param = params[index] ?? 0;
		if (param === 0 || param === 49) {
			return true;
		}

		const colorSequence = readSgrColorSequence(params, index);
		index += colorSequence ? colorSequence.length : 1;
	}

	return false;
}

function stripBackgroundResetParams(params: number[]): number[] {
	const filtered: number[] = [];

	for (let i = 0; i < params.length; i++) {
		const param = params[i] ?? 0;

		if (param === 0) {
			filtered.push(...expandSgrReset(param)!);
			continue;
		}

		if (param === 49) {
			continue;
		}

		const colorSequence = readSgrColorSequence(params, i);
		if (colorSequence) {
			filtered.push(...colorSequence);
			i += colorSequence.length - 1;
			continue;
		}

		filtered.push(param);
	}

	return filtered;
}

export function stabilizeBackgroundResets(text: string): string {
	if (!text) {
		return text;
	}
	return filterSgrSequences(text, stripBackgroundResetParams);
}

export function keepBackgroundAcrossResets(text: string, rowBg: string): string {
	if (!text) {
		return text;
	}

	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = toSgrParams(rawParams);
		if (params.length === 0 || !sequenceResetsBackground(params)) {
			return sequence;
		}
		return `${sequence}${rowBg}`;
	});
}

export function colorizeSegment(
	theme: DiffTheme,
	color: "dim" | "toolDiffAdded" | "toolDiffRemoved",
	text: string,
	rowBg: string | undefined,
): string {
	let themedText: string;
	try {
		themedText = theme.fg(color, text);
	} catch {
		themedText = text;
	}

	if (!rowBg) {
		return themedText;
	}

	const stableText = keepBackgroundAcrossResets(themedText, rowBg);
	return `${rowBg}${stableText}${rowBg}`;
}

function applyBackgroundToVisualRow(
	text: string,
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string {
	if (width <= 0) {
		return "";
	}

	const fitted = fitToWidth(text, width);
	const withStableBackground = keepBackgroundAcrossResets(fitted, rowBgAnsi);
	return stabilizeBackgroundResets(`${rowBgAnsi}${withStableBackground}${restoreBgAnsi}`);
}

export function applyLineBackgroundToWrappedRows(
	rows: string[],
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string[] {
	if (rows.length === 0) {
		return [applyBackgroundToVisualRow("", width, rowBgAnsi, restoreBgAnsi)];
	}

	return rows.map((row) => applyBackgroundToVisualRow(row, width, rowBgAnsi, restoreBgAnsi));
}

/** utils 版返回 tuple，此处适配为本文件使用的 RgbColor 形状。 */
function ansi256ToRgbColor(code: number): RgbColor {
	const [r, g, b] = ansi256ToRgb(code);
	return { r, g, b };
}

export function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
	if (!ansi) {
		return null;
	}
	const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgbMatch) {
		const r = Number.parseInt(rgbMatch[1] ?? "0", 10);
		const g = Number.parseInt(rgbMatch[2] ?? "0", 10);
		const b = Number.parseInt(rgbMatch[3] ?? "0", 10);
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			return {
				r: Math.max(0, Math.min(255, r)),
				g: Math.max(0, Math.min(255, g)),
				b: Math.max(0, Math.min(255, b)),
			};
		}
	}

	const bitMatch = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
	if (bitMatch) {
		const code = Number.parseInt(bitMatch[1] ?? "0", 10);
		if (Number.isFinite(code)) {
			return ansi256ToRgbColor(code);
		}
	}

	const basicMatch = /\x1b\[(?:3|4)([0-7])m/.exec(ansi);
	if (basicMatch) return ansi256ToRgbColor(Number(basicMatch[1]));
	const brightMatch = /\x1b\[(?:9|10)([0-7])m/.exec(ansi);
	if (brightMatch) return ansi256ToRgbColor(Number(brightMatch[1]) + 8);
	return null;
}

function rgbToBgAnsi(color: RgbColor): string {
	// 终端能力降级：truecolor 直发；非真彩终端量化到 256/16 色板最近色；
	// none（NO_COLOR/dumb）不发背景色（getLineBackground 返回 undefined 兜底）。
	return rgbToBgAnsiForTerminal(color.r, color.g, color.b);
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
	const clamped = Math.max(0, Math.min(1, ratio));
	return {
		r: base.r * (1 - clamped) + tint.r * clamped,
		g: base.g * (1 - clamped) + tint.g * clamped,
		b: base.b * (1 - clamped) + tint.b * clamped,
	};
}

function extractThemeBackgroundAnsi(text: string): string | undefined {
	if (!text || !text.includes("\x1b[")) {
		return undefined;
	}

	ANSI_SGR_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ANSI_SGR_PATTERN.exec(text)) !== null) {
		const parsed = toSgrParams(match[1] ?? "");
		for (let index = 0; index < parsed.length; index += 1) {
			const param = parsed[index] ?? 0;
			if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
				return `\x1b[${param}m`;
			}

			const colorSequence = readSgrColorSequence(parsed, index);
			if (colorSequence?.[0] === 48) {
				return `\x1b[${colorSequence.join(";")}m`;
			}
			if (colorSequence) {
				index += colorSequence.length - 1;
			}
		}
	}

	return undefined;
}

export function readThemeAnsi(
	theme: DiffTheme,
	kind: "fg" | "bg",
	slot: string,
): string | undefined {
	try {
		if (kind === "fg" && typeof theme.getFgAnsi === "function") {
			return theme.getFgAnsi(slot);
		}
		if (kind === "bg") {
			if (typeof theme.getBgAnsi === "function") {
				return theme.getBgAnsi(slot);
			}
			if (typeof theme.bg === "function") {
				return extractThemeBackgroundAnsi(theme.bg(slot, " "));
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function resolveDiffPalette(theme: DiffTheme): DiffPalette {
	const baseBg = parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolSuccessBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg")) ?? { r: 32, g: 35, b: 42 };
	const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded")) ?? {
		r: 88,
		g: 173,
		b: 88,
	};
	const removeFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffRemoved")) ?? {
		r: 196,
		g: 98,
		b: 98,
	};
	const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
	const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);

	const addRowBg = mixRgb(baseBg, addTint, ADD_ROW_BACKGROUND_MIX_RATIO);
	const removeRowBg = mixRgb(baseBg, removeTint, REMOVE_ROW_BACKGROUND_MIX_RATIO);
	const addEmphasisBg = mixRgb(baseBg, addTint, ADD_INLINE_EMPHASIS_MIX_RATIO);
	const removeEmphasisBg = mixRgb(baseBg, removeTint, REMOVE_INLINE_EMPHASIS_MIX_RATIO);

	return {
		addRowBgAnsi: rgbToBgAnsi(addRowBg),
		removeRowBgAnsi: rgbToBgAnsi(removeRowBg),
		addEmphasisBgAnsi: rgbToBgAnsi(addEmphasisBg),
		removeEmphasisBgAnsi: rgbToBgAnsi(removeEmphasisBg),
	};
}

export function getLineBackground(
	kind: DiffLineKind,
	palette: DiffPalette,
	emphasis: boolean,
): string | undefined {
	// none 终端：调色板里的背景 ANSI 为空串，按 undefined 处理（调用方跳过背景）。
	if (kind === "add") {
		const ansi = emphasis ? palette.addEmphasisBgAnsi : palette.addRowBgAnsi;
		return ansi || undefined;
	}
	if (kind === "remove") {
		const ansi = emphasis ? palette.removeEmphasisBgAnsi : palette.removeRowBgAnsi;
		return ansi || undefined;
	}
	return undefined;
}

function applySgrToVisibleRange(
	ansiText: string,
	start: number,
	end: number,
	openSgr: string,
	restoreSgr: string,
): string {
	if (!ansiText || start >= end || end <= 0) {
		return ansiText;
	}

	const rangeStart = Math.max(0, start);
	const rangeEnd = Math.max(rangeStart, end);
	let output = "";
	let visibleIndex = 0;
	let index = 0;
	let inRange = false;

	while (index < ansiText.length) {
		if (ansiText[index] === "\x1b") {
			const sequenceEnd = ansiText.indexOf("m", index);
			if (sequenceEnd !== -1) {
				output += ansiText.slice(index, sequenceEnd + 1);
				index = sequenceEnd + 1;
				continue;
			}
		}

		if (visibleIndex === rangeStart && !inRange) {
			output += openSgr;
			inRange = true;
		}
		if (visibleIndex === rangeEnd && inRange) {
			output += restoreSgr;
			inRange = false;
		}

		output += ansiText[index] ?? "";
		visibleIndex++;
		index++;
	}

	if (inRange) {
		output += restoreSgr;
	}

	return output;
}

export function applyInlineSpanHighlight(
	plainText: string,
	renderedText: string,
	spans: DiffSpan[],
	emphasisBgAnsi: string | undefined,
	rowBgAnsi: string | undefined,
	fallbackBgAnsi: string | undefined,
): string {
	if (!renderedText || !plainText || spans.length === 0 || !emphasisBgAnsi) {
		return renderedText;
	}

	const sorted = mergeSpans(
		spans
			.map((span) => ({
				start: Math.max(0, Math.min(plainText.length, span.start)),
				end: Math.max(0, Math.min(plainText.length, span.end)),
			}))
			.filter((span) => span.end > span.start),
	);
	if (sorted.length === 0) {
		return renderedText;
	}

	const restoreBackgroundAnsi = rowBgAnsi ?? fallbackBgAnsi ?? ANSI_BG_RESET;
	let highlighted = renderedText;
	for (let index = sorted.length - 1; index >= 0; index--) {
		const span = sorted[index];
		if (!span) {
			continue;
		}
		highlighted = applySgrToVisibleRange(
			highlighted,
			span.start,
			span.end,
			emphasisBgAnsi,
			restoreBackgroundAnsi,
		);
	}

	return highlighted;
}

/**
 * 行内改动片段的 inverse 反显（SGR 7/27）：区间内序列变换，与 keepBackgroundAcrossResets
 * 同语义——遇 reset（0 或 27）后重开 inverse + 重发 rowBg，保证区间内背景连续。
 * 区间结束 `\x1b[27m` 后无需重发 rowBg（27m 不改 fg/bg 状态）。
 * 行背景本身的兜底仍由调用方（applyLineBackgroundToWrappedRows + keepBackgroundAcrossResets）负责。
 */
export function applyInlineSpanInverse(
	plainText: string,
	renderedText: string,
	spans: DiffSpan[],
	rowBgAnsi: string | undefined,
): string {
	if (!renderedText || !plainText || spans.length === 0) {
		return renderedText;
	}

	const sorted = mergeSpans(
		spans
			.map((span) => ({
				start: Math.max(0, Math.min(plainText.length, span.start)),
				end: Math.max(0, Math.min(plainText.length, span.end)),
			}))
			.filter((span) => span.end > span.start),
	);
	if (sorted.length === 0) {
		return renderedText;
	}

	let highlighted = renderedText;
	for (let index = sorted.length - 1; index >= 0; index--) {
		const span = sorted[index];
		if (!span) {
			continue;
		}
		highlighted = applyInverseToVisibleRange(highlighted, span.start, span.end, rowBgAnsi);
	}

	return highlighted;
}

/**
 * 对可见区间 [start, end) 施加反显：区间开头 `\x1b[7m`、区间结束 `\x1b[27m`；
 * 区间内的 reset 序列变换为 `序列 + rowBg(如有) + \x1b[7m`（重开反显 + 重发行背景）。
 */
function applyInverseToVisibleRange(
	ansiText: string,
	start: number,
	end: number,
	rowBgAnsi: string | undefined,
): string {
	if (!ansiText || start >= end || end <= 0) {
		return ansiText;
	}

	const rangeStart = Math.max(0, start);
	const rangeEnd = Math.max(rangeStart, end);
	const SGR_CONTENT = /\x1b\[([0-9;]*)m/y;
	let output = "";
	let visibleIndex = 0;
	let index = 0;
	let inRange = false;

	while (index < ansiText.length) {
		if (ansiText[index] === "\x1b") {
			SGR_CONTENT.lastIndex = index;
			const sgr = SGR_CONTENT.exec(ansiText);
			if (sgr && sgr.index === index) {
				let sequence = sgr[0];
				if (inRange && sequenceResetsInverse(sgr[1] ?? "")) {
					// reset → 重开 inverse + 重发 rowBg（与 keepBackgroundAcrossResets 同语义）。
					sequence = `${sequence}${rowBgAnsi ?? ""}${INVERSE_OPEN_ANSI}`;
				}
				output += sequence;
				index += sgr[0].length;
				continue;
			}
		}

		if (visibleIndex === rangeStart && !inRange) {
			output += INVERSE_OPEN_ANSI;
			inRange = true;
		}
		if (visibleIndex === rangeEnd && inRange) {
			output += INVERSE_CLOSE_ANSI;
			inRange = false;
		}

		output += ansiText[index] ?? "";
		visibleIndex++;
		index++;
	}

	if (inRange) {
		output += INVERSE_CLOSE_ANSI;
	}

	return output;
}

export function resolveShikiTheme(theme: DiffTheme): string {
	if (process.env.DIFF_THEME) return process.env.DIFF_THEME;
	const background =
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolSuccessBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg"));
	if (!background) return "github-dark";
	const luminance = (background.r * 299 + background.g * 587 + background.b * 114) / 1000;
	return luminance >= 128 ? "github-light" : "github-dark";
}
