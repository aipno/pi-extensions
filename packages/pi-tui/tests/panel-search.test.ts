/**
 * 面板 type-to-filter 回归：SettingsList.enableSearch 在项目多的页签启用（>5 项），
 * 词级 fuzzy 宿主实现（token 局部匹配打分）。驱动真实 showCcstylePanel：
 * Tab 切到项目最多的 Diff 页签 → 直接打字 → items 被过滤 → Backspace 清空恢复。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { showCcstylePanel } from "../extensions/config/panel.ts";

initTheme("dark");

const hooks = { applyStyleMode: () => {}, refreshCurrentTranscript: () => {} };

/**
 * 从面板 render 输出推断搜索状态：
 * - 启用搜索时 SettingsList 渲染搜索输入行（">" 光标行），面板 footer 出现 "type to filter"；
 * - 过滤生效时列表项 label 消失。锚点用我们自己的 footer 提示（en 由 setup-env 钉死）。
 */
function renderLines(panel: any, width = 120): string[] {
	return panel.render(width).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}
function hasSearchHint(lines: string[]): boolean {
	return lines.some((line) => line.includes("type to filter"));
}
function totalLabelCount(lines: string[], labels: readonly string[]): number {
	const joined = lines.join("\n");
	return labels.filter((label) => joined.includes(label)).length;
}

test("Diff 页签启用 type-to-filter：打字过滤 item 集合，Esc 无关字符回退", async () => {
	const box = { component: undefined as any };
	const captureCtx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				box.component = factory(
					{ terminal: { columns: 120, rows: 40 }, requestRender() {} },
					{ fg: (c: string, s: string) => s, bold: (s: string) => s, dim: (s: string) => s },
					null,
					() => {},
				);
			},
			notify: () => {},
			requestRender: () => {},
		},
	};
	await showCcstylePanel(captureCtx, hooks as any, undefined, undefined);
	const panel = box.component;
	assert.ok(panel, "panel 工厂已捕获");

	// 切到 Diff 页签（Style → Diff）
	panel.handleInput("\t");
	const DIFF_LABELS = ["Diff layout", "Diff indicator", "Split min width", "Edit collapsed lines", "Write collapsed lines", "Diff word wrap", "Expanded max lines", "Input clip"];
	assert.ok(hasSearchHint(renderLines(panel)), "Diff 页签 8 项 > 5 应启用搜索");

	// 打字 "split" → 过滤（只剩 Split min width 命中）
	panel.handleInput("s");
	panel.handleInput("p");
	panel.handleInput("l");
	const visibleAfterType = totalLabelCount(renderLines(panel), DIFF_LABELS);
	assert.ok(visibleAfterType < DIFF_LABELS.length, `过滤后可见 label 变少：${visibleAfterType}`);
	assert.ok(
		renderLines(panel).join("\n").includes("Split min width"),
		"split 至少命中 Split min width",
	);

	// 逐个退格 → 过滤恢复
	panel.handleInput("\x7f");
	panel.handleInput("\x7f");
	panel.handleInput("\x7f");
	assert.equal(
		totalLabelCount(renderLines(panel), DIFF_LABELS),
		DIFF_LABELS.length,
		"清空后恢复全量",
	);
});

test("Style 页签（2 项）不启用搜索，Space 循环预设不受影响", async () => {
	const box = { component: undefined as any };
	const captureCtx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				box.component = factory(
					{ terminal: { columns: 120, rows: 40 }, requestRender() {} },
					{ fg: (c: string, s: string) => s, bold: (s: string) => s, dim: (s: string) => s },
					null,
					() => {},
				);
			},
			notify: () => {},
			requestRender: () => {},
		},
	};
	const appliedModes: string[] = [];
	await showCcstylePanel(
		captureCtx,
		{ applyStyleMode: (mode: any) => appliedModes.push(mode), refreshCurrentTranscript: () => {} } as any,
		undefined,
		undefined,
	);
	const panel = box.component;
	assert.ok(!hasSearchHint(renderLines(panel)), "2 项页签不启用搜索");

	// Space 循环预设：Mode 项 on → compact（信号用 hooks.applyStyleMode，config.mode 由它驱动）
	panel.handleInput(" ");
	assert.equal(appliedModes.at(-1), "compact", "Space 应循环 Mode 到 compact");
	// 再两次循环：compact → off → on
	panel.handleInput(" ");
	panel.handleInput(" ");
	assert.equal(appliedModes.at(-1), "on", "循环一周回到 on");
});