/**
 * 流式 diff 显示辅助（omp `tool-execution.ts` stripTrailingUnbalancedRemoval +
 * `diff.ts` visualizeIndent 的移植）。
 *
 * stripTrailing：edit partial result 的 details.diff 是"半截" unified diff——
 * 尾部常出现「一批 `-old` 已到、配对的 `+new` 还没到」或「`@@` hunk 头后面还没有行」的
 * 断头状态。直接渲染会闪现一批孤立的删除行，下一帧又整段消失，产生视觉抖动。
 * 这里把尾部"悬而未决"的行暂时剪掉（不丢数据，只是等下个 tick 配齐再放出来）：
 *  - 从尾部向前剔除「无 + 行收尾的连续 - 行」与「后面还没有任何行的 @@ 头」；
 *  - 一旦碰到稳定的 + / 上下文行即停，前面的内容保留。
 * 纯函数、单测覆盖；调用方拿到 deferred=true 时可显示占位而不是假装渲染完成。
 *
 * visualizeIndent：把行首缩进的空格渲染为暗色 `·`（对齐 omp diff.ts 的设计：
 * 仅首段空白，行内对齐空格与代码内容不受影响），深缩进文件的可视对齐一眼可辨。
 * 字符层面只改等宽 1 格的空白，不破坏宽度/换行/列对齐计算。
 *
 * 注意：tab 在 diff 管线（normalizeCodeWhitespace）中已被展开为 4 空格，
 * 因此这里只处理空格缩进；输入均为已 sanitize 的文本。
 */

export type StreamGuardResult = {
	lines: string[];
	/** true = 尾部确有被剪掉的未配对内容，等下个 tick 再放出。 */
	deferred: boolean;
};

/** 半截 unified diff 的行级稳定性：removal/hunkHeader 需要等后续行配齐才算稳定。 */
export function getStreamGuardLineKind(raw: string): "removal" | "hunkHeader" | "stable" {
	if (raw.startsWith("@@")) return "hunkHeader";
	if (raw.startsWith("-")) return "removal";
	// `+` 行到达即稳定（它的"后续"只是下一个变更块，不构成抖动）；上下文、
	// 文件头（diff --git / Index: / Diff for …）同样稳定。
	return "stable";
}

/**
 * 剪掉半截 diff 尾部的未稳定行。
 * 输入是原始 diff 文本行（保留 `-`/`+`/`@@` 前缀）。从尾部向前：hunkHeader 与
 * 连续 removal 属于未稳定；碰到第一个稳定行即停。
 */
export function stripTrailingUnbalancedRemoval(lines: readonly string[]): StreamGuardResult {
	let end = lines.length;
	while (end > 0) {
		const kind = getStreamGuardLineKind(lines[end - 1] ?? "");
		if (kind === "stable") break;
		end--;
	}
	if (end === lines.length) {
		return { lines: [...lines], deferred: false };
	}
	return { lines: lines.slice(0, end), deferred: true };
}

/** 便捷封装：半截 diff 文本 → 剪尾后的文本。 */
export function stripTrailingUnbalancedRemovalText(
	text: string,
): StreamGuardResult & { text: string } {
	const lines = text.split("\n");
	const result = stripTrailingUnbalancedRemoval(lines);
	return { ...result, text: result.lines.join("\n") };
}

/** 行首连续空格长度（tab 层已 normalize，这里只看空格）。 */
export function leadingIndentWidth(line: string): number {
	let width = 0;
	while (line[width] === " ") width++;
	return width;
}

export const INDENT_SPACE_GLYPH = "·";

/**
 * 对渲染文本（可含 SGR）的行首 `indent` 个可见字符替换为暗色 `·`。
 * renderedText 与 plainText 的可见字符一一对应（diff 管线保证），以 renderedText
 * 扫描为准、plainText 用于防御性核对同一可见位的字符。缩进段若被 shiki 的 SGR
 * 序列打断，按可见字符分段重新包裹，保证颜色连续正确。indent=0 原样返回。
 */
export function visualizeIndentAnsi(
	plainText: string,
	renderedText: string,
	indent: number,
	paint: (text: string) => string,
): string {
	if (indent <= 0 || !renderedText) return renderedText;
	let visible = 0;
	let out = "";
	let dimRun = "";
	const SGR = /\x1b\[[0-9;]*m/y;

	const flushRun = () => {
		if (dimRun) {
			out += paint(dimRun);
			dimRun = "";
		}
	};

	let index = 0;
	while (index < renderedText.length && visible < indent) {
		SGR.lastIndex = index;
		const sgr = SGR.exec(renderedText);
		if (sgr && sgr.index === index) {
			flushRun();
			out += sgr[0];
			index += sgr[0].length;
			continue;
		}
		const ch = renderedText[index]!;
		// 防御性核对：renderedText 与 plainText 同一可见位都须是空格，否则对齐
		// 已被上游破坏——放弃整个替换，回退原文（不产出错误内容）。
		if (ch !== " " || plainText[visible] !== " ") {
			return renderedText;
		}
		dimRun += INDENT_SPACE_GLYPH;
		visible++;
		index++;
	}
	flushRun();
	if (index < renderedText.length) {
		out += renderedText.slice(index);
	}
	return out;
}