/**
 * P3(§3) composer 形态注册表测试：registry 契约（冲突抛错 / 同源覆盖 / Symbol.for
 * 跨模块共享）、v0 形态变换（pi/box/rule/borderless 行数不变、仅变换纯边框行）、
 * StyledComposerEditor 集成（真实 Editor 基类）、面板 Input style 项切换/
 * 还原/预览（同一 style 对象自绘）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

import { showCcstylePanel } from "../extensions/config/panel.ts";
import {
	applyComposerStyle,
	borderlessStyle,
	boxStyle,
	COMPOSER_STYLES_REGISTRY_KEY,
	DEFAULT_STYLE_ID,
	findBottomBorderIndex,
	getComposerStyle,
	isPureBorderRow,
	listComposerStyleIds,
	piStyle,
	registerComposerStyle,
	ruleStyle,
	StyledComposerEditor,
	type ComposerStyle,
} from "../extensions/feature/composer-styles.ts";

const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const paint = (text: string) => `\x1b[36m${text}\x1b[0m`;

// ── registry 契约 ─────────────────────────────────────────────────────────

test("registry：内置 4 形态注册于模块加载，可查询与列举", () => {
	assert.deepEqual(
		listComposerStyleIds().filter((id) => ["pi", "box", "rule", "borderless"].includes(id)),
		["pi", "box", "rule", "borderless"],
		"内置形态（pi/box/rule/borderless）就绪",
	);
	assert.equal(getComposerStyle("box"), boxStyle);
	assert.equal(getComposerStyle("pi"), piStyle);
	assert.equal(getComposerStyle("nope"), undefined);
});

test("registry：跨扩展共享（Symbol.for 槽），自定义样式可注册", () => {
	const custom: ComposerStyle = {
		id: "test-rail",
		apply: (rows) => [...rows],
	};
	const before = (globalThis as any)[COMPOSER_STYLES_REGISTRY_KEY];
	registerComposerStyle("test-rail", custom, "test-owner");
	const after = (globalThis as any)[COMPOSER_STYLES_REGISTRY_KEY];
	assert.equal(after, before, "注册写入 Symbol.for 全局槽（跨模块实例共享）");
	assert.equal(getComposerStyle("test-rail"), custom);
	assert.ok(isPureBorderRow("─".repeat(10), 10));
});

test("registry：同名冲突抛错（含冲突方）；同 owner 覆盖（/reload）", () => {
	registerComposerStyle("test-dup", piStyle, "owner-a");
	assert.throws(
		() => registerComposerStyle("test-dup", piStyle, "owner-b"),
		/"test-dup" already registered by "owner-a"; cannot register by "owner-b"/,
		"不同 owner 冲突抛错并提示双方",
	);
	// 同 owner 重注册（/reload 后新模块实例）→ 覆盖不抛错。
	const replacement: ComposerStyle = { id: "test-dup", apply: (rows) => [...rows] };
	registerComposerStyle("test-dup", replacement, "owner-a");
	assert.equal(getComposerStyle("test-dup"), replacement);
	// 非法 id / 缺 apply → 抛错。
	assert.throws(() => registerComposerStyle("", piStyle));
	assert.throws(() => registerComposerStyle("test-bad", { id: "test-bad" } as any));
});

// ── 形态变换单元 ───────────────────────────────────────────────────────────

function sampleRows(width = 8): string[] {
	return [paint("─".repeat(width)), "  hi  ", paint("─".repeat(width))];
}

test("形态 pi：透传父类，行不变", () => {
	const rows = sampleRows();
	const out = piStyle.apply(rows, 8, paint);
	assert.deepEqual(out, rows);
});

test("形态 box：角字符替换首尾纯边框行，行数不变，中间行不动", () => {
	const rows = sampleRows();
	const out = boxStyle.apply(rows, 8, paint);
	assert.equal(out.length, rows.length, "行数不变");
	assert.equal(strip(out[0]!), "╭──────╮");
	assert.equal(strip(out[2]!), "╰──────╯");
	assert.equal(out[1], rows[1], "内容行原样");
});

test("形态 box：scroll indicator 顶行（非纯边框）不变换；底边框仍定位", () => {
	const rows = [paint("─── ↑ 2 more ──"), "line", paint("─".repeat(9))];
	const out = boxStyle.apply(rows, 9, paint);
	assert.equal(strip(out[0]!), "─── ↑ 2 more ──", "滚动指示行原样");
	assert.equal(strip(out[2]!), "╰───────╯", "底边框 box 化");
});

test("形态 box：autocomplete 追加行在底边框之后，仍能定位底边框", () => {
	const rows = [
		paint("─".repeat(8)),
		"  hi  ",
		paint("─".repeat(8)),
		paint("  /style "),
		paint("  /mode  "),
	];
	const bottomIndex = findBottomBorderIndex(rows, 8);
	assert.equal(bottomIndex, 2, "底边框在 autocomplete 行之前");
	const out = boxStyle.apply(rows, 8, paint);
	assert.equal(strip(out[2]!), "╰──────╯");
	assert.equal(out[3], rows[3], "autocomplete 行不动");
	assert.equal(out.length, rows.length);
});

test("形态 rule：顶行标题化居中，窄屏退化为省略号行", () => {
	const rows = sampleRows(9);
	const out = ruleStyle.apply(rows, 9, paint);
	assert.equal(strip(out[0]!), "── pi ───", "居中的 `─ pi ─` 标题行");
	assert.equal(strip(out[2]!), "─".repeat(9), "底边框不变");
	// 窄屏：标题放不下 → 省略号。
	const narrow = ruleStyle.apply(sampleRows(5), 5, paint);
	assert.equal(strip(narrow[0]!), "…".repeat(5));
});

test("形态 borderless：首尾行清为空白占位，宽度与行数不变", () => {
	const rows = sampleRows();
	const out = borderlessStyle.apply(rows, 8, paint);
	assert.equal(out.length, rows.length);
	assert.equal(out[0], " ".repeat(8), "顶行空白占位");
	assert.equal(out[2], " ".repeat(8), "底行空白占位");
	assert.equal(out[1], rows[1]);
});

// ── StyledComposerEditor 集成（真实 Editor 基类） ─────────────────────────

const tui = {
	terminal: { rows: 24, columns: 100 },
	setFocus() {},
	requestRender() {},
} as any;

const theme = {
	borderColor: (text: string) => `\x1b[36m${text}\x1b[0m`,
	fg: (_color: string, text: string) => text,
} as any;

test("StyledComposerEditor：box 形态首尾行变换、行数不变、内容保留", () => {
	const editor = new StyledComposerEditor(tui, theme, {} as any, boxStyle);
	editor.setText("hello world");
	const rows = editor.render(40);
	const plain = rows.map(strip);
	assert.equal(rows.length, 3, "单行输入仍为 3 行（父类布局不变）");
	assert.equal(plain[0], "╭" + "─".repeat(38) + "╮", "顶行 box 化");
	assert.ok(plain[1]!.includes("hello world"), "内容行保留父类渲染");
	assert.equal(plain[2], "╰" + "─".repeat(38) + "╯", "底行 box 化");
	// 每个可见行宽不变（布局安全）。
	for (const row of rows) {
		assert.equal(row.replace(/\x1b\[[0-9;]*m/g, "").length, 40);
	}
});

test("StyledComposerEditor：pi 形态透传父类渲染", () => {
	const editor = new StyledComposerEditor(tui, theme, {} as any, piStyle);
	editor.setText("x");
	const rows = editor.render(40);
	assert.equal(strip(rows[0]!), "─".repeat(40));
	assert.equal(strip(rows[2]!), "─".repeat(40));
});

test("StyledComposerEditor：borderless 首尾行为空白占位", () => {
	const editor = new StyledComposerEditor(tui, theme, {} as any, borderlessStyle);
	editor.setText("x");
	const rows = editor.render(40);
	assert.equal(strip(rows[0]!), " ".repeat(40));
	assert.equal(strip(rows[2]!), " ".repeat(40));
});

// ── applyComposerStyle 接线 ────────────────────────────────────────────────

test("applyComposerStyle：替换为 StyledComposerEditor 工厂；default 还原；未知报 false", () => {
	const applied: unknown[] = [];
	const ctx = { ui: { setEditorComponent: (factory: unknown) => applied.push(factory) } };

	assert.equal(applyComposerStyle("box", ctx), true);
	assert.equal(applied.length, 1);
	const factory = applied[0] as (ui: any, theme: any, kb: any) => unknown;
	const editor = factory(tui, theme, {} as any);
	assert.ok(editor instanceof StyledComposerEditor, "工厂产出形态编辑器");
	assert.equal((editor as StyledComposerEditor).style, boxStyle);

	assert.equal(applyComposerStyle("default", ctx), true);
	assert.equal(applied.at(-1), undefined, "default → setEditorComponent(undefined) 还原宿主编辑器");

	assert.equal(applyComposerStyle("not-a-style", ctx), false, "未注册 id 不动作");
	assert.equal(applied.length, 2, "未知 id 不追加调用");
});

// ── 面板 ──────────────────────────────────────────────────────────────────

function openPanel() {
	const box = { component: undefined as any };
	const applied: unknown[] = [];
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
			setEditorComponent: (factory: unknown) => applied.push(factory),
		},
	};
	const hooks = { applyStyleMode: () => {}, refreshCurrentTranscript: () => {} };
	return { captureCtx, hooks, box, applied };
}

test("面板：UI 页签含 Input style 项，选择循环切换并替换/还原编辑器", async () => {
	const { captureCtx, hooks, box, applied } = openPanel();
	await showCcstylePanel(captureCtx as any, hooks as any, undefined, undefined);
	const panel = box.component;
	assert.ok(panel, "panel 工厂已捕获");

	// 切到 UI 页签（style → diff → thinking → ui）。
	for (let i = 0; i < 3; i++) panel.handleInput("\t");
	const lines = panel.render(120).map(strip);
	assert.ok(lines.join("\n").includes("Input style"), "UI 页签包含 Input style 项");

	// 选中 Input style（第 6 项：language/startupHeader/footer/scrollStep/streamingReveal/inputStyle）。
	for (let i = 0; i < 5; i++) panel.handleInput("\x1b[B");
	// Enter 循环 values：default → box。
	panel.handleInput("\r");
	assert.equal(applied.length, 1, "选择后调用 setEditorComponent 替换编辑器");
	assert.equal(applied[0] !== undefined, true, "替换为工厂而非还原");
	// 选中项 + 自定义形态 → 面板渲染显示预览块（同一 style 对象自绘：box 角字符）。
	const previewLines = panel.render(120).map((line: string) => strip(line));
	assert.ok(
		previewLines.some((line: string) => line.includes("╭") && line.includes("╮")),
		"面板内预览用 box 形态自绘（两表面同源）",
	);

	// 再循环两次：box → rule → borderless。
	panel.handleInput("\r");
	panel.handleInput("\r");
	assert.equal(applied.length, 3);
	const lastEditor = (applied[2] as any)(tui, theme, {});
	assert.equal((lastEditor as StyledComposerEditor).style, borderlessStyle, "第三次循环到 borderless");

	// 继续循环直到回到 default（registry 为全局共享，可能含扩展注册的样式，
	// 循环位置随注册顺序变化——只断言语义：最终还原为 undefined）。
	let guard = 0;
	while (applied.at(-1) !== undefined && guard < 12) {
		panel.handleInput("\r");
		guard++;
	}
	assert.ok(guard < 12, "循环应在有限步内回到 default");
	assert.equal(applied.at(-1), undefined, "default → setEditorComponent(undefined)");
	// 切回默认后预览块消失。
	const defaultLines = panel.render(120).map((line: string) => strip(line));
	assert.ok(!defaultLines.some((line: string) => line.includes("╭")), "默认形态无预览块");
});

test("面板：Input style 切换幂等（重复选择不叠加调用）", async () => {
	const { captureCtx, hooks, box, applied } = openPanel();
	await showCcstylePanel(captureCtx as any, hooks as any, undefined, undefined);
	const panel = box.component;
	for (let i = 0; i < 3; i++) panel.handleInput("\t");
	for (let i = 0; i < 5; i++) panel.handleInput("\x1b[B");
	// 循环到 default（还原）后再次循环回到自定义样式：每次 Enter 恰好一次调用。
	let guard = 0;
	while (applied.at(-1) !== undefined && guard < 12) {
		panel.handleInput("\r");
		guard++;
	}
	assert.equal(applied.at(-1), undefined, "循环回到 default");
	const afterDefault = applied.length;
	panel.handleInput("\r"); // 再应用一个自定义样式
	assert.equal(applied.length, afterDefault + 1, "每次循环恰好一次替换调用，无叠加泄漏");
	assert.ok(applied.at(-1) !== undefined, "default 之后再次进入自定义样式");
});