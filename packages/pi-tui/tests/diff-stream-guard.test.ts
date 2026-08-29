/**
 * diff-stream-guard 单测：omp stripTrailingUnbalancedRemoval + visualizeIndent 移植。
 * 覆盖：剪尾规则（- 尾 / @@ 尾 / 稳定尾）、deferred 标记、缩进 glyph 替换
 * （纯文本 / ANSI / 核对失败回退）、以及 edit/write partial 渐进预览的接线。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	getStreamGuardLineKind,
	leadingIndentWidth,
	stripTrailingUnbalancedRemoval,
	stripTrailingUnbalancedRemovalText,
	visualizeIndentAnsi,
} from "../extensions/renderer/tool/diff/diff-stream-guard.ts";
import {
	renderPartialEditDiff,
	renderPartialWriteDiff,
} from "../extensions/renderer/tool/diff/diff-partial.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../extensions/config/config.ts";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

test("stream guard：全未稳定（@@ + 连续 -）→ 剪空并标记 deferred", () => {
	const result = stripTrailingUnbalancedRemoval([
		"@@ -1,2 +1,2 @@",
		"-old line",
		"-old line 2",
	]);
	// @@ 头同样未稳定 → 剪到空；调用方拿 deferred=true 回退 Pending。
	assert.deepEqual(result.lines, []);
	assert.equal(result.deferred, true);
});

test("stream guard：+ 为最近稳定行，其后的 - 尾剪掉", () => {
	const result = stripTrailingUnbalancedRemoval([
		"@@ -10,3 +10,4 @@",
		"-foo",
		"+bar",
		"-tail1",
		"-tail2",
	]);
	assert.deepEqual(result.lines, ["@@ -10,3 +10,4 @@", "-foo", "+bar"]);
	assert.equal(result.deferred, true);
});

test("stream guard：@@ 尾（新 hunk 行未到）剪掉，配对块保留", () => {
	const result = stripTrailingUnbalancedRemoval([
		"@@ -10,3 +10,4 @@",
		"-foo",
		"+bar",
		"@@ -20,1 +21,2 @@",
	]);
	assert.deepEqual(result.lines, ["@@ -10,3 +10,4 @@", "-foo", "+bar"]);
	assert.equal(result.deferred, true);
});

test("stream guard：稳定结尾原样返回", () => {
	const lines = ["@@ -1,1 +1,1 @@", "-old", "+new"];
	const result = stripTrailingUnbalancedRemoval(lines);
	assert.deepEqual(result.lines, lines);
	assert.equal(result.deferred, false);
});

test("stream guard：上下文与文件头行视为稳定", () => {
	assert.equal(getStreamGuardLineKind(" unchanged"), "stable");
	assert.equal(getStreamGuardLineKind("diff --git a/x b/x"), "stable");
	assert.equal(getStreamGuardLineKind("Diff for /a.txt"), "stable");
	assert.equal(getStreamGuardLineKind("-x"), "removal");
	assert.equal(getStreamGuardLineKind("+x"), "stable");
	assert.equal(getStreamGuardLineKind("@@ -1 +1 @@"), "hunkHeader");
});

test("stream guard：空输入", () => {
	const result = stripTrailingUnbalancedRemoval([]);
	assert.deepEqual(result.lines, []);
	assert.equal(result.deferred, false);
});

test("stream guard：文本封装 stripTrailingUnbalancedRemovalText", () => {
	const result = stripTrailingUnbalancedRemovalText("@@ -1 +1 @@\n-old\n+new\n-tail");
	assert.equal(result.text, "@@ -1 +1 @@\n-old\n+new");
	assert.equal(result.deferred, true);
});

test("visualizeIndent：行首空格替换为 ·，纯文本", () => {
	const plain = "    code";
	const out = visualizeIndentAnsi(plain, plain, 4, (t) => `<d>${t}</d>`);
	assert.equal(out, "<d>····</d>code");
});

test("visualizeIndent：indent=0 或空文本原样返回", () => {
	assert.equal(visualizeIndentAnsi("abc", "abc", 0, (t) => `<${t}>`), "abc");
	assert.equal(visualizeIndentAnsi("", "", 2, (t) => `<${t}>`), "");
});

test("visualizeIndent：SGR 打断缩进段时按可见字符分段重包", () => {
	// shiki 可能给行首空白包 SGR：\x1b[2m「 」\x1b[22m 后接代码。
	const rendered = "\x1b[2m  \x1b[22mcode";
	const out = visualizeIndentAnsi("  code", rendered, 2, (t) => `[d:${t}]`);
	assert.equal(out, "\x1b[2m[d:··]\x1b[22mcode");
});

test("visualizeIndent：可见位非空格 → 整体回退原文", () => {
	const rendered = "\x1b[31mab\x1b[39m";
	const out = visualizeIndentAnsi("xy", rendered, 1, (t) => `<${t}>`);
	assert.equal(out, rendered);
});

test("leadingIndentWidth：只数行首空格", () => {
	assert.equal(leadingIndentWidth("    x"), 4);
	assert.equal(leadingIndentWidth("x"), 0);
	assert.equal(leadingIndentWidth(""), 0);
	assert.equal(leadingIndentWidth("\tx"), 0); // tab 在管线中已 normalize 为 4 空格
});

// ── partial 接线：edit 半截 diff 剪尾后渲染 + waiting 提示 ──

test("renderPartialEditDiff：- 尾剪掉后剩余可渲染，waiting 行显示", () => {
	// +new 之后跟未配对 - 尾：剪掉尾巴，剩余部分渲染 + waiting 提示。
	const details = { diff: "@@ -1,2 +1,2 @@\n-old one\n+new one\n-tail" };
	const component = renderPartialEditDiff(details, {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	assert.ok(component, "剪尾后仍有可渲染行时应返回组件");
	const lines = component.render(120);
	assert.ok(lines.some((line: string) => line.includes("waiting…")), lines.join("\n"));
});

test("renderPartialEditDiff：剪空后回退 undefined（调用方显示 Pending）", () => {
	const details = { diff: "@@ -1,2 +1,2 @@\n-old one\n-old two" };
	const component = renderPartialEditDiff(details, {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	assert.equal(component, undefined);
});

test("renderPartialEditDiff：无 diff / 空 diff → undefined", () => {
	assert.equal(renderPartialEditDiff(undefined, {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme), undefined);
	assert.equal(renderPartialEditDiff({}, {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme), undefined);
});

test("renderPartialEditDiff：稳定结尾无 waiting 行", () => {
	const details = { diff: "@@ -1,1 +1,1 @@\n-old\n+new" };
	const component = renderPartialEditDiff(details, {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	assert.ok(component);
	const lines = component.render(120);
	assert.ok(!lines.some((line: string) => line.includes("waiting…")), lines.join("\n"));
});

test("renderPartialWriteDiff：新内容渲染 + writing 提示", () => {
	const component = renderPartialWriteDiff("hello\nworld", {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	assert.ok(component);
	const lines = component.render(120);
	assert.ok(lines.some((line: string) => line.includes("writing…")), lines.join("\n"));
});

test("renderPartialWriteDiff：空内容回退 undefined", () => {
	assert.equal(
		renderPartialWriteDiff(undefined, {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme),
		undefined,
	);
	assert.equal(renderPartialWriteDiff("", {}, DEFAULT_TOOL_DISPLAY_CONFIG, theme), undefined);
});