import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { closeDanglingInverseAnsi } from "./ansi-utils.ts";

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

export function splitWriteContentLines(content: string): string[] {
	if (!content) {
		return [];
	}

	const normalized = content.replace(/\r/g, "");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

export function normalizeCodeWhitespace(text: string): string {
	return text.replace(/\t/g, "    ");
}

export function fitToWidth(text: string, width: number): string {
	const trimmed = truncateToWidth(text, width, "");
	// 超宽行截断可能切掉反显区间的 `\x1b[27m`，收尾补发防止残留反显蔓延。
	const closed = closeDanglingInverseAnsi(trimmed);
	const gap = Math.max(0, width - visibleWidth(closed));
	return gap > 0 ? `${closed}${" ".repeat(gap)}` : closed;
}

export function wrapToWidth(text: string, width: number, wordWrap: boolean): string[] {
	if (width <= 0) {
		return [""];
	}

	if (!wordWrap) {
		return [fitToWidth(text, width)];
	}

	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length === 0) {
		return [fitToWidth("", width)];
	}

	return wrapped.map((line) => fitToWidth(line, width));
}
