import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "../../view/components/wrapping-select.ts";
import { TabBar } from "../../view/components/tab-bar.ts";
import { SubmitPicker } from "../../view/components/submit-picker.ts";
import {
	adaptiveLeftWidth,
	bodyWidths,
	columnWidths,
	crossTabLeftWidthWithDonation,
	crossTabMaxLeftWidth,
	crossTabPreviewBudget,
	decideLayout,
	MIN_LEFT,
	previewSourceWidth,
} from "../../view/components/preview/preview-layout-decider.ts";
import {
	computeBoxDimensions,
	renderBorderedBox,
	stripFenceMarkers,
} from "../../view/components/preview/preview-box-renderer.ts";
import { renderInlineInputRow } from "../../view/components/inline-input.ts";
import { HINT_SINGLE } from "../../view/dialog-builder.ts";
import { buildHintText, buildSubmitHintText } from "../../view/tab-content-strategy.ts";
import type { QuestionData } from "../../tool/types.ts";
import type { DialogState } from "../../view/dialog-builder.ts";

const identityTheme: WrappingSelectTheme = {
	selectedText: (s) => s,
	description: (s) => s,
	scrollInfo: (s) => s,
};

function makeItems(): WrappingSelectItem[] {
	return [
		{ kind: "option", label: "A", description: "desc A" },
		{ kind: "option", label: "B" },
		{ kind: "other", label: "Type something." },
	];
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// ---------------------------------------------------------------------------
// WrappingSelect
// ---------------------------------------------------------------------------

test("WrappingSelect renders numbered rows with pointers", () => {
	const select = new WrappingSelect(makeItems(), 10, identityTheme);
	select.setSelectedIndex(0);
	select.setFocused(true);
	const lines = select.render(40).map(stripAnsi);
	assert.ok(lines[0]?.startsWith("❯ 1. A"));
	assert.ok(lines[2]?.startsWith("  2. B"));
	// description of the focused option renders indented
	assert.ok(lines.some((l) => l.includes("desc A")));
});

test("WrappingSelect renders the active row with the pointer and wraps focus at edges", () => {
	const select = new WrappingSelect(makeItems(), 10, identityTheme);
	select.setSelectedIndex(2);
	const lines = select.render(40).map(stripAnsi);
	assert.ok(lines[0]?.startsWith("  1. A"));
	assert.ok(lines[2]?.startsWith("  2. B"));
	// the focused 'other' row renders with the pointer (inline editor cell follows)
	assert.ok(lines[3]?.startsWith("❯ 3."));
});

test("WrappingSelect confirmed row renders label + ✔ without pointer", () => {
	const items = makeItems();
	const select = new WrappingSelect(items, 10, identityTheme);
	select.setFocused(false);
	select.setConfirmedIndex(0);
	const lines = select.render(40).map(stripAnsi);
	assert.ok(lines[0]?.includes("A ✔"));
	assert.ok(!lines[0]?.startsWith("❯"));
});

test("WrappingSelect confirmed 'other' row renders the label override", () => {
	const items = makeItems();
	const select = new WrappingSelect(items, 10, identityTheme);
	select.setFocused(false);
	select.setConfirmedIndex(2, "my previous answer");
	const lines = select.render(40).map(stripAnsi);
	assert.ok(lines[3]?.includes("my previous answer ✔"));
});

test("WrappingSelect inline input row renders the buffer with a cursor cell", () => {
	const items = makeItems();
	const select = new WrappingSelect(items, 10, identityTheme);
	select.setSelectedIndex(2);
	select.setFocused(true);
	select.setInputBuffer("hello");
	select.setInputCursorOffset(5);
	const lines = select.render(40);
	const plain = stripAnsi(lines[3] ?? "");
	assert.ok(plain.includes("hello"));
});

test("WrappingSelect scrolls with a scroll info line when items overflow the window", () => {
	const items: WrappingSelectItem[] = Array.from({ length: 20 }, (_, i) => ({
		kind: "option" as const,
		label: `Item ${i}`,
	}));
	const select = new WrappingSelect(items, 5, identityTheme);
	select.setSelectedIndex(10);
	const lines = select.render(40).map(stripAnsi);
	assert.ok(lines.some((l) => l.includes("(11/20)")));
	assert.equal(lines.length, 6); // 5 window rows + 1 scroll info
});

test("WrappingSelect.focusedItemRowRange covers the focused row", () => {
	const select = new WrappingSelect(makeItems(), 10, identityTheme);
	select.setSelectedIndex(1);
	const [start, end] = select.focusedItemRowRange(40);
	// row 0 = option A (1 line) + its wrapped description (1 line) → option B starts at 2
	assert.equal(start, 2);
	assert.ok(end > start);
});

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

function makeTheme(): Theme {
	// Minimal structural theme: every method is the identity so assertions
	// inspect visible text only.
	return new Proxy(
		{},
		{
			get: (_t, prop: string) => {
				if (prop === "bg") return (_color: string, s: string) => s;
				if (prop === "fg") return (_color: string, s: string) => s;
				if (prop === "bold") return (s: string) => s;
				return undefined;
			},
		},
	) as Theme;
}

test("TabBar renders question chips with answered boxes and a Submit slot", () => {
	const bar = new TabBar(makeTheme());
	bar.setProps({
		tabs: [
			{ label: "Feature", answered: true, active: true },
			{ label: "Testing", answered: false, active: false },
		],
		submit: { active: false, allAnswered: false },
	});
	const lines = bar.render(80).map(stripAnsi);
	assert.ok(lines[0]?.includes("■ Feature"));
	assert.ok(lines[0]?.includes("□ Testing"));
	assert.ok(lines[0]?.includes("Submit"));
	assert.equal(lines.length, 2); // [tabLine, ""]
});

test("TabBar marks the active submit slot", () => {
	const bar = new TabBar(makeTheme());
	bar.setProps({ tabs: [], submit: { active: true, allAnswered: true } });
	const lines = bar.render(80).map(stripAnsi);
	assert.ok(lines[0]?.includes("Submit"));
});

// ---------------------------------------------------------------------------
// SubmitPicker
// ---------------------------------------------------------------------------

test("SubmitPicker renders two rows with the active pointer", () => {
	const picker = new SubmitPicker(makeTheme());
	picker.setProps({ rows: [{ active: true }, { active: false }] });
	const lines = picker.render(40).map(stripAnsi);
	assert.ok(lines[0]?.startsWith("❯ 1. Submit answers"));
	assert.ok(lines[1]?.startsWith("  2. Cancel"));
	assert.equal(picker.naturalHeight(40), 2);
});

// ---------------------------------------------------------------------------
// Preview layout decider (pure functions)
// ---------------------------------------------------------------------------

test("decideLayout engages side-by-side only at >= PREVIEW_MIN_WIDTH", () => {
	assert.equal(decideLayout(120, 120), "side-by-side");
	assert.equal(decideLayout(99, 120), "stacked");
	assert.equal(decideLayout(120, 99), "stacked");
});

test("adaptiveLeftWidth floors at MIN_LEFT and caps at the ratio ceiling", () => {
	const short = [{ kind: "option" as const, label: "A" }];
	assert.equal(adaptiveLeftWidth(short, 1, 200), MIN_LEFT);
	const long = [{ kind: "option" as const, label: "x".repeat(80) }];
	const w = adaptiveLeftWidth(long, 1, 200);
	assert.ok(w <= Math.floor(200 * 0.5));
	assert.ok(w >= 30);
});

test("crossTabMaxLeftWidth aggregates the widest tab", () => {
	const narrow = [{ kind: "option" as const, label: "A" }];
	const wide = [{ kind: "option" as const, label: "Configure the reload behavior" }];
	const max = crossTabMaxLeftWidth([{}, {}], [narrow, wide], 200);
	assert.equal(max, adaptiveLeftWidth(wide, 1, 200));
});

test("previewSourceWidth returns the widest preview source line", () => {
	const q: QuestionData = {
		question: "q",
		header: "h",
		options: [
			{ label: "A", description: "a", preview: "short\nx".repeat(20) },
			{ label: "B", description: "b", preview: "y".repeat(50) },
		],
	};
	assert.equal(previewSourceWidth(q), 50);
	assert.equal(previewSourceWidth({ question: "q", header: "h", options: [{ label: "A", description: "a" }] }), 0);
});

test("crossTabPreviewBudget floors at MIN_PREVIEW_WIDTH", () => {
	assert.equal(crossTabPreviewBudget([{ question: "q", header: "h", options: [{ label: "A", description: "a" }] }], 200), 45);
});

test("crossTabLeftWidthWithDonation stays within the ratio ceiling", () => {
	const tabs = [{ multiSelect: false }];
	const items = [[{ kind: "option" as const, label: "Short" }]];
	const questions = [{ question: "q", header: "h", options: [{ label: "A", description: "a", preview: "short preview" }] }];
	const w = crossTabLeftWidthWithDonation(tabs, items, questions, 140);
	assert.ok(w >= 30 && w <= 70);
});

test("columnWidths/bodyWidths split side-by-side widths", () => {
	const { leftWidth, rightWidth, gap } = columnWidths(100, 48);
	assert.equal(leftWidth, 48);
	assert.equal(rightWidth, 50);
	assert.equal(gap, 2);
	const widths = bodyWidths(100, "side-by-side", 48);
	assert.equal(widths.optionsWidth, 48);
	assert.equal(widths.previewWidth, 49);
	const stacked = bodyWidths(100, "stacked", 48);
	assert.deepEqual(stacked, { optionsWidth: 100, previewWidth: 100 });
});

// ---------------------------------------------------------------------------
// Preview box renderer
// ---------------------------------------------------------------------------

test("stripFenceMarkers removes fenced code markers but keeps content", () => {
	const input = ["```ts", "const x = 1;", "\x1b[36m```\x1b[0m", "plain"];
	assert.deepEqual(stripFenceMarkers(input), ["const x = 1;", "plain"]);
});

test("renderBorderedBox wraps content in a 4-sided border", () => {
	const color = (s: string) => s;
	const lines = renderBorderedBox(["hello"], 12, color);
	assert.equal(lines.length, 3);
	assert.ok(lines[0]?.startsWith("┌"));
	assert.ok(lines[1]?.includes("hello"));
	assert.ok(lines[2]?.startsWith("└"));
});

test("renderBorderedBox indicates hidden lines", () => {
	const color = (s: string) => s;
	const lines = renderBorderedBox(["a", "b"], 20, color, 3);
	assert.ok(lines[3]?.includes("3 lines hidden"));
});

test("computeBoxDimensions floors at BOX_MIN_CONTENT_WIDTH", () => {
	const d = computeBoxDimensions(["hi"], 100);
	assert.equal(d.innerWidth, 40);
	assert.equal(d.boxWidth, 44);
	const wide = computeBoxDimensions(["x".repeat(80)], 100);
	assert.equal(wide.innerWidth, 80);
});

// ---------------------------------------------------------------------------
// Inline input row
// ---------------------------------------------------------------------------

test("renderInlineInputRow places the cursor reverse-video cell", () => {
	const lines = renderInlineInputRow({
		buffer: "ab",
		cursorOffset: 2,
		rowPrefix: "❯ ",
		continuationPrefix: "  ",
		contentWidth: 20,
		selectedText: (s) => s,
	});
	const plain = stripAnsi(lines[0] ?? "");
	assert.ok(plain.includes("ab"));
	// reverse-video SGR pair survives styling
	assert.ok((lines[0] ?? "").includes("\x1b[7m"));
});

test("renderInlineInputRow wraps long buffers with continuation prefixes", () => {
	const lines = renderInlineInputRow({
		buffer: "word ".repeat(20).trim(),
		cursorOffset: undefined,
		rowPrefix: "❯ ",
		continuationPrefix: "  ",
		contentWidth: 10,
		selectedText: (s) => s,
	});
	assert.ok(lines.length > 1);
	assert.ok(lines[1]?.startsWith("  "));
});

// ---------------------------------------------------------------------------
// Hint text
// ---------------------------------------------------------------------------

function makeState(over: Partial<DialogState> = {}): DialogState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		...over,
	};
}

const SAMPLE_QUESTION: QuestionData = {
	question: "q",
	header: "h",
	options: [
		{ label: "A", description: "a" },
		{ label: "B", description: "b" },
	],
};

test("buildHintText composes the resting single-select hint", () => {
	const hint = buildHintText(SAMPLE_QUESTION, false, makeState(), "ctrl+]");
	assert.ok(hint.startsWith(HINT_SINGLE));
	assert.ok(hint.includes("Esc to cancel"));
	assert.ok(hint.includes("Ctrl+] to collapse"));
	assert.ok(hint.includes("n to add notes"));
});

test("buildHintText drops notes while input mode is active and appends clear/newline", () => {
	const state = makeState({ inputMode: true });
	const hint = buildHintText(SAMPLE_QUESTION, false, state, "ctrl+]");
	assert.ok(!hint.includes("n to add notes"));
	assert.ok(hint.includes("Shift+Enter for newline"));
	assert.ok(hint.includes("Ctrl+U to clear"));
});

test('buildHintText omits the collapse affordance when the key is "off"', () => {
	const hint = buildHintText(SAMPLE_QUESTION, false, makeState(), "off");
	assert.ok(!hint.includes("to collapse"));
});

test("buildHintText adds the toggle part for multi-select questions", () => {
	const hint = buildHintText({ ...SAMPLE_QUESTION, multiSelect: true }, false, makeState(), "off");
	assert.ok(hint.includes("Space to toggle"));
});

test("buildSubmitHintText composes the submit-tab hint", () => {
	const hint = buildSubmitHintText(makeState());
	assert.ok(hint.includes("n to add a note"));
	assert.ok(hint.includes("Esc to cancel"));
	const withNotes = buildSubmitHintText(makeState({ notesVisible: true }));
	assert.ok(!withNotes.includes("n to add a note"));
	assert.ok(withNotes.includes("Shift+Enter for newline"));
});