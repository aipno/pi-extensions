/**
 * P1(§2) 回归：行内缩进可视化（diffIndentGuide）与反显强调（diffEmphasisStyle: inverse）。
 *
 * 覆盖：三布局（unified/split/compact）接线后的 `·` 数量与可见宽度、cap=16、
 * 非首段空格不受影响；inverse 区间定位/区间内 reset 变换/27m 后 rowBg 保持/
 * CJK 不偏移/超宽行截断无残留 7m；PI_TUI_COLOR 降级终端；live config 缓存键切换即时重绘。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

import { renderEditDiffResult } from "../extensions/renderer/tool/diff/diff-renderer.ts";
import { renderRichToolResult, WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../extensions/config/config.ts";
import {
	applyInlineSpanInverse,
	keepBackgroundAcrossResets,
	resolveDiffPalette,
} from "../extensions/renderer/tool/diff/diff-palette.ts";
import { visualizeIndentAnsi } from "../extensions/renderer/tool/diff/diff-stream-guard.ts";
import { closeDanglingInverseAnsi } from "../extensions/renderer/tool/diff/ansi-utils.ts";
import { fitToWidth } from "../extensions/renderer/tool/diff/diff-text.ts";
import {
	resetTerminalCapabilityCache,
} from "../extensions/utils/terminal-capabilities.ts";

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

const stripAnsi = (value: string) =>
	value.replace(/\x1b\[[0-9;.]*m/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function output(component: any, width = 100): string[] {
	return component.render(width);
}

const INDENT_DIFF = [
	"@@ -1,4 +1,4 @@",
	"-    const oldName = 1",
	"+    const newName = 2",
	"      const same = 3",
].join("\n");

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const keys = ["COLORTERM", "TERM", "NO_COLOR", "PI_TUI_COLOR", "PI_TUI_ANIMATIONS", "TERM_PROGRAM", "TMUX", "CI"];
	const previous: Record<string, string | undefined> = {};
	for (const key of [...keys, ...Object.keys(env)]) {
		previous[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	resetTerminalCapabilityCache();
	try {
		fn();
	} finally {
		for (const key of Object.keys(previous)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key]!;
		}
		resetTerminalCapabilityCache();
	}
}

// ── 缩进可视化 ────────────────────────────────────────────────────────────

test("缩进：不触碰非首段空格，行内对齐原样保留", () => {
	const out = visualizeIndentAnsi("  a  b", "  a  b", 2, (t) => `<d>${t}</d>`);
	assert.equal(out, "<d>··</d>a  b");
});

test("缩进接线：unified 深缩进行 `·` = min(indent,16)，可见宽度不变", () => {
	const component = renderEditDiffResult(
		{ diff: INDENT_DIFF },
		{ expanded: true, filePath: "sample.ts" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffIndentGuide: "dots" },
		theme,
		"",
	);
	const lines = output(component, 100);
	const target = lines.find((line) => stripAnsi(line).includes("const newName"));
	assert.ok(target, "新增行已渲染");
	assert.match(stripAnsi(target), /····const newName = 2/, "行首 4 空格变为 4 个 ·，紧跟代码");
	assert.ok(lines.every((line) => visibleWidth(line) <= 100), "所有行可见宽度不超面板");
	assert.ok(!stripAnsi(target).includes("·····const"), "add 行缩进仅 4 格被替换，不多不少");
});

test("缩进接线：split 布局同样可视化", () => {
	const component = renderEditDiffResult(
		{ diff: INDENT_DIFF },
		{ expanded: true, filePath: "sample.ts" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "split", diffIndentGuide: "dots" },
		theme,
		"",
	);
	const lines = output(component, 100);
	assert.ok(
		lines.some((line) => stripAnsi(line).includes("····const newName = 2")),
		"split 右列出现 · 缩进可视化",
	);
});

test("缩进接线：compact 布局同样可视化", () => {
	const component = renderEditDiffResult(
		{ diff: INDENT_DIFF },
		{ expanded: true, filePath: "sample.ts" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffIndentGuide: "dots" },
		theme,
		"",
	);
	const lines = output(component, 12); // < 18 → compact presentation
	assert.ok(
		lines.some((line) => stripAnsi(line).includes("····const")),
		"compact 行出现 · 缩进可视化",
	);
});

test("缩进 cap=16：80 空格行只画 16 个 ·", () => {
	const component = renderEditDiffResult(
		{
			diff: [
				"@@ -1,2 +1,2 @@",
				`-${" ".repeat(80)}x`,
				`+${" ".repeat(80)}y`,
			].join("\n"),
		},
		{ expanded: true, filePath: "sample.ts" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffIndentGuide: "dots" },
		theme,
		"",
	);
	const plain = stripAnsi(output(component, 120).join("\n")).split("\n");
	const dottedLines = plain.filter((line) => line.includes("·"));
	assert.equal(dottedLines.length, 2, "remove/add 两行都可视化");
	for (const line of dottedLines) {
		assert.equal((line.match(/·/g) ?? []).length, 16, "深缩进每行只画 16 个 `·`（cap），不铺满整行");
	}
});

test("缩进默认 off：不开开关时保持空格", () => {
	const component = renderEditDiffResult(
		{ diff: INDENT_DIFF },
		{ expanded: true, filePath: "sample.ts" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified" },
		theme,
		"",
	);
	assert.ok(!output(component, 100).join("\n").includes("·"), "默认无 · 可视化");
});

// ── inverse 反显双路径 ────────────────────────────────────────────────────

test("inverse：普通行区间定位 7m/27m 包裹，与 bg 路径同坐标", () => {
	const out = applyInlineSpanInverse("hello world!", "hello world!", [{ start: 6, end: 11 }], undefined);
	assert.equal(out, "hello \x1b[7mworld\x1b[27m!");
});

test("inverse：区间内 reset 变换 = 重开 inverse + 重发 rowBg", () => {
	const rowBg = "\x1b[48;5;60m";
	const rendered = "\x1b[31mconst \x1b[0mx = 1";
	const out = applyInlineSpanInverse("const x = 1", rendered, [{ start: 0, end: 11 }], rowBg);
	assert.equal(out, "\x1b[31m\x1b[7mconst \x1b[0m" + rowBg + "\x1b[7mx = 1\x1b[27m");
});

test("inverse：27m 后无需重发 rowBg；keepBackgroundAcrossResets 组合后背景连续", () => {
	const rowBg = "\x1b[48;5;60m";
	const out = applyInlineSpanInverse("const x = 1", "const \x1b[0mx = 1", [{ start: 0, end: 11 }], rowBg);
	const wrapped = keepBackgroundAcrossResets(out, rowBg);
	// 区间结束：27m 直接接内容，无 rowBg 重发（27m 不改 fg/bg）。
	assert.match(wrapped, /x = 1\x1b\[27m$/);
	// 区间内 reset 后：rowBg 至少出现一次（行级兜底 + 区间变换），inverse 重新打开。
	assert.ok(wrapped.includes("\x1b[0m" + rowBg) || wrapped.includes("\x1b[0m" + rowBg + rowBg));
	assert.ok(wrapped.includes("\x1b[7m"), "reset 后重新打开 inverse");
	const firstClose = wrapped.indexOf("\x1b[27m");
	assert.equal(wrapped.indexOf("\x1b[7m", firstClose), -1, "27m 之后不再有未配对 7m");
});

test("inverse：CJK 不偏移（按 code point 可见位对齐，与 bg 路径一致）", () => {
	const out = applyInlineSpanInverse(
		"中文abc中文",
		"\x1b[31m中文\x1b[0mabc中文",
		[{ start: 2, end: 5 }],
		undefined,
	);
	// 区间起点前的 SGR 序列先复制、随后在可见位 2 处打开 7m（与 bg 路径同结构）。
	assert.equal(out, "\x1b[31m中文\x1b[0m\x1b[7mabc\x1b[27m中文");
});

/** 断言文本中不存在悬空反显：每个 7m 之后必出现 27m 或全重置。 */
function expectNoDanglingInverse(text: string): void {
	let openAt = -1;
	for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
		const params = (match[1] ?? "").split(";").map((p) => Number(p));
		const resets = params.length === 0 || params.some((p) => p === 0 || p === 27);
		if (resets) {
			openAt = -1;
		} else if (params.includes(7)) {
			assert.equal(openAt, -1, "前一个 7m 尚未闭合");
			openAt = match.index ?? -1;
		}
	}
	assert.equal(openAt, -1, "文本末尾不得残留未闭合 7m");
}

test("inverse：超宽行截断无残留 7m（截断点落在反显区间内）", () => {
	const longText = "a".repeat(200);
	const inv = applyInlineSpanInverse(longText, longText, [{ start: 50, end: 180 }], undefined);
	const fitted = fitToWidth(inv, 60);
	assert.equal(visibleWidth(fitted), 60, "可见宽度不变");
	// 截断在区间中间：50..60 可见字符处于 7m 内，尾部被 reset/27m 闭合。
	assert.match(fitted, /^a{50}\x1b\[7ma{10}\x1b\[(?:0|27)m$/);
	expectNoDanglingInverse(fitted);
});

test("inverse：closeDanglingInverseAnsi 幂等，已配对区间不受影响", () => {
	assert.equal(closeDanglingInverseAnsi("ab\x1b[7mcd"), "ab\x1b[7mcd\x1b[27m");
	assert.equal(closeDanglingInverseAnsi("\x1b[7mab\x1b[27mcd"), "\x1b[7mab\x1b[27mcd");
	assert.equal(closeDanglingInverseAnsi("a\x1b[0mb\x1b[7mc"), "a\x1b[0mb\x1b[7mc\x1b[27m");
	assert.equal(closeDanglingInverseAnsi("plain"), "plain");
});

test("inverse 全管线：unified 渲染出现 7m/27m 且行宽不超", () => {
	const component = renderEditDiffResult(
		{ diff: INDENT_DIFF },
		{ expanded: true, filePath: "sample.ts" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffEmphasisStyle: "inverse" },
		theme,
		"",
	);
	const lines = output(component, 100);
	const changed = lines.find((line) => stripAnsi(line).includes("oldName"));
	assert.ok(changed && changed.includes("\x1b[7m"), "改动片段出现反显");
	assert.ok(changed!.includes("\x1b[27m"), "反显区间已收尾");
	assert.ok(
		lines.every((line) => !line.match(/\x1b\[7m(?![\s\S]*\x1b\[27m)/)),
		"所有行 7m 均配对，无悬空反显",
	);
});

// ── 降级终端（terminal-capabilities 显式覆盖口） ─────────────────────────

test("PI_TUI_COLOR=16：调色板背景量化到 16 色，inverse 仍可用", () => {
	withEnv({ PI_TUI_COLOR: "16" }, () => {
		const colorTheme = {
			fg(_color: string, text: string) {
				return text;
			},
			getBgAnsi(_color: string) {
				return "\x1b[48;2;10;20;30m";
			},
		} as any;
		const palette = resolveDiffPalette(colorTheme);
		for (const ansi of [palette.addRowBgAnsi, palette.removeRowBgAnsi, palette.addEmphasisBgAnsi, palette.removeEmphasisBgAnsi]) {
			assert.match(ansi, /^\x1b\[48;5;\d+m$/, `背景已量化到 256 序列: ${JSON.stringify(ansi)}`);
			const code = Number(/^\x1b\[48;5;(\d+)m$/.exec(ansi)?.[1]);
			assert.ok(code < 16, `色码 ${code} 落在 16 色板内`);
		}

		// inverse 与降级终端可组合：行背景量化、反显区间照常。
		const component = renderEditDiffResult(
			{ diff: INDENT_DIFF },
			{ expanded: true, filePath: "sample.ts" },
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffEmphasisStyle: "inverse" },
			theme,
			"",
		);
		const lines = output(component, 100);
		assert.ok(lines.some((line) => line.includes("\x1b[7m")), "16 色下反显照常工作");
	});
});

test("PI_TUI_COLOR=none：不发背景色，inverse 无 rowBg 也安全", () => {
	withEnv({ PI_TUI_COLOR: "none" }, () => {
		const component = renderEditDiffResult(
			{ diff: INDENT_DIFF },
			{ expanded: true, filePath: "sample.ts" },
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffEmphasisStyle: "inverse" },
			theme,
			"",
		);
		const lines = output(component, 100);
		const changed = lines.find((line) => stripAnsi(line).includes("newName"));
		assert.ok(changed && changed.includes("\x1b[7m"), "none 终端反显区间仍可见");
		assert.ok(changed!.includes("\x1b[27m") && !changed!.match(/\x1b\[7m(?![\s\S]*\x1b\[27m)/), "无悬空 7m");
	});
});

// ── live config：面板切换即时重绘 ─────────────────────────────────────────

test("live config 缓存键：面板切两开关后同一组件即时重绘", () => {
	let display: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		diffViewMode: "unified",
		editDiffCollapsedLines: 80,
		expandedPreviewMaxLines: 200,
	};
	const component = renderRichToolResult(
		"edit",
		{ details: { diff: INDENT_DIFF }, content: [] },
		{ expanded: true },
		theme,
		{ args: { path: "sample.ts" } },
		new WriteExecutionMetadataStore(),
		() => display,
	);

	const base = output(component).join("\n");
	assert.ok(!base.includes("\x1b[7m"), "默认 bg 强调无反显");
	assert.ok(!stripAnsi(base).includes("····"), "默认无缩进可视化");

	// 面板把 diffIndentGuide → dots、diffEmphasisStyle → inverse。
	display = { ...display, diffIndentGuide: "dots", diffEmphasisStyle: "inverse" };
	const switched = output(component).join("\n");
	assert.ok(stripAnsi(switched).includes("····const"), "缩进可视化即时出现");
	assert.ok(switched.includes("\x1b[7m"), "反显即时出现");

	// 再切回：恢复原样（缓存键变化驱动重绘，不走旧缓存）。
	display = { ...display, diffIndentGuide: "off", diffEmphasisStyle: "bg" };
	const back = output(component).join("\n");
	assert.ok(!back.includes("\x1b[7m"), "切回 bg 后无反显残留");
	assert.ok(!stripAnsi(back).includes("····"), "切回 off 后无 · 残留");
});