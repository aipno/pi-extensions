import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuestionAnswer, QuestionData } from "../../tool/types.ts";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.ts";
import { allAnswered, routeKey, wrapTab } from "../../state/key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../../state/state.ts";

const KEY = {
	UP: "tui.select.up",
	DOWN: "tui.select.down",
	CONFIRM: "tui.select.confirm",
	SUBMIT: "tui.input.submit",
	CANCEL: "tui.select.cancel",
	NEW_LINE: "tui.input.newLine",
	EDITOR_UP: "tui.editor.cursorUp",
	EDITOR_DOWN: "tui.editor.cursorDown",
	CLEAR: "tui.editor.deleteToLineStart",
	EXTERNAL_EDITOR: "app.editor.external",
};
const sentinel = (name: string) => `<KEY:${name}>`;
const keybindings = { matches: (data: string, name: string) => data === sentinel(name) };

const BYTE_TAB = "\t";
const BYTE_SHIFT_TAB = "\x1b[Z";
const BYTE_RIGHT = "\x1b[C";
const BYTE_LEFT = "\x1b[D";
const BYTE_SPACE = " ";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "H",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
			{ label: "C", description: "c" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeAnswer(over: Partial<QuestionAnswer> = {}): QuestionAnswer {
	return {
		questionIndex: over.questionIndex ?? 0,
		question: over.question ?? "q",
		kind: over.kind ?? "option",
		answer: over.answer ?? "A",
	};
}

function makeState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map<number, QuestionAnswer>(),
		multiSelectChecked: new Set<number>(),
		customDraftsByTab: new Map<number, string>(),
		notesByTab: new Map<number, string>(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		...over,
	};
}

function makeRuntime(over: Partial<QuestionnaireRuntime> = {}): QuestionnaireRuntime {
	const questions = over.questions ?? [makeQuestion(), makeQuestion()];
	const items: WrappingSelectItem[] = over.items
		? [...over.items]
		: questions[0]!.options.map((o) => ({ kind: "option" as const, label: o.label }));
	return {
		keybindings,
		inputBuffer: "",
		canMoveInputUp: false,
		canMoveInputDown: false,
		questions,
		isMulti: questions.length > 1,
		currentItem: items[0],
		items,
		collapseKey: "ctrl+]",
		...over,
	};
}

// ---------------------------------------------------------------------------
// wrapTab + allAnswered
// ---------------------------------------------------------------------------

test("wrapTab wraps negative + over-max into [0, total)", () => {
	assert.equal(wrapTab(-1, 3), 2);
	assert.equal(wrapTab(3, 3), 0);
	assert.equal(wrapTab(0, 0), 0);
});

test("allAnswered is false when any question lacks an answer", () => {
	assert.equal(allAnswered(makeState({ answers: new Map([[0, makeAnswer({ questionIndex: 0 })]]) }), makeRuntime()), false);
});

test("allAnswered is true when every question has an answer", () => {
	assert.equal(
		allAnswered(
			makeState({
				answers: new Map([
					[0, makeAnswer({ questionIndex: 0 })],
					[1, makeAnswer({ questionIndex: 1 })],
				]),
			}),
			makeRuntime(),
		),
		true,
	);
});

// ---------------------------------------------------------------------------
// routeKey — nav
// ---------------------------------------------------------------------------

test("UP from a non-zero index decrements by 1", () => {
	assert.deepEqual(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 2 }), makeRuntime()), {
		kind: "nav",
		nextIndex: 1,
		inputValue: "",
	});
});

test("UP at the first item wraps to the last", () => {
	assert.deepEqual(routeKey(sentinel(KEY.UP), makeState(), makeRuntime()), {
		kind: "nav",
		nextIndex: 2,
		inputValue: "",
	});
});

test("DOWN increments; wraps to 0 at the last item", () => {
	assert.deepEqual(routeKey(sentinel(KEY.DOWN), makeState(), makeRuntime()), {
		kind: "nav",
		nextIndex: 1,
		inputValue: "",
	});
	assert.deepEqual(routeKey(sentinel(KEY.DOWN), makeState({ optionIndex: 2 }), makeRuntime()), {
		kind: "nav",
		nextIndex: 0,
		inputValue: "",
	});
});

// ---------------------------------------------------------------------------
// routeKey — tab_switch
// ---------------------------------------------------------------------------

test("Tab moves to the next tab; wraps to 0 from the last question tab", () => {
	assert.deepEqual(routeKey(BYTE_TAB, makeState(), makeRuntime()), { kind: "tab_switch", nextTab: 1 });
	assert.deepEqual(routeKey(BYTE_TAB, makeState({ currentTab: 1 }), makeRuntime()), { kind: "tab_switch", nextTab: 2 });
});

test("Shift+Tab moves backward; wraps to the last tab from 0", () => {
	assert.deepEqual(routeKey(BYTE_SHIFT_TAB, makeState({ currentTab: 1 }), makeRuntime()), { kind: "tab_switch", nextTab: 0 });
	assert.deepEqual(routeKey(BYTE_SHIFT_TAB, makeState(), makeRuntime()), { kind: "tab_switch", nextTab: 2 });
});

test("right/left keys also switch tabs in multi-question mode", () => {
	assert.deepEqual(routeKey(BYTE_RIGHT, makeState(), makeRuntime()), { kind: "tab_switch", nextTab: 1 });
	assert.deepEqual(routeKey(BYTE_LEFT, makeState({ currentTab: 1 }), makeRuntime()), { kind: "tab_switch", nextTab: 0 });
});

test("single-question mode has no tab switching", () => {
	const single = makeRuntime({ questions: [makeQuestion()], isMulti: false });
	assert.equal(routeKey(BYTE_TAB, makeState(), single).kind, "ignore");
});

// ---------------------------------------------------------------------------
// routeKey — confirm (single-select)
// ---------------------------------------------------------------------------

test("Enter on a regular option row confirms that option (no auto-advance on last)", () => {
	const items: WrappingSelectItem[] = [
		{ kind: "option", label: "A" },
		{ kind: "option", label: "B" },
		{ kind: "option", label: "C" },
		{ kind: "other", label: "Type something." },
	];
	const rt = makeRuntime({ questions: [makeQuestion()], isMulti: false, items, currentItem: items[1] });
	const r = routeKey(sentinel(KEY.CONFIRM), makeState({ optionIndex: 1 }), rt);
	assert.equal(r.kind, "confirm");
	assert.deepEqual((r as { answer: QuestionAnswer }).answer, {
		questionIndex: 0,
		question: "Pick one",
		kind: "option",
		answer: "B",
	});
});

test("Enter confirms and auto-advances to the next tab in multi-question mode", () => {
	const r = routeKey(sentinel(KEY.CONFIRM), makeState(), makeRuntime());
	assert.deepEqual(r.kind, "confirm");
	assert.equal((r as { autoAdvanceTab?: number }).autoAdvanceTab, 1);
});

test("Enter on the 'Type something.' row (not yet in input mode) is ignored", () => {
	const items: WrappingSelectItem[] = [
		{ kind: "option", label: "A" },
		{ kind: "option", label: "B" },
		{ kind: "other", label: "Type something." },
	];
	const rt = makeRuntime({
		questions: [makeQuestion()],
		isMulti: false,
		items,
		currentItem: items[2],
	});
	assert.equal(routeKey(sentinel(KEY.CONFIRM), makeState({ optionIndex: 2 }), rt).kind, "ignore");
});

test("Esc cancels from a question tab", () => {
	assert.equal(routeKey(sentinel(KEY.CANCEL), makeState(), makeRuntime()).kind, "cancel");
});

// ---------------------------------------------------------------------------
// routeKey — multiSelect
// ---------------------------------------------------------------------------

function multiRuntime(over: Partial<QuestionnaireRuntime> = {}) {
	const q = makeQuestion({ multiSelect: true });
	const items: WrappingSelectItem[] = [
		{ kind: "option", label: "A" },
		{ kind: "option", label: "B" },
		{ kind: "option", label: "C" },
		{ kind: "other", label: "Type something." },
		{ kind: "next", label: "Next" },
	];
	return makeRuntime({ questions: [q], isMulti: false, items, currentItem: items[0], ...over });
}

test("Space toggles the focused row", () => {
	assert.deepEqual(routeKey(BYTE_SPACE, makeState(), multiRuntime()), { kind: "toggle", index: 0 });
});

test("Space on the Next sentinel is suppressed (blocksMultiToggle)", () => {
	const rt = multiRuntime({ currentItem: { kind: "next", label: "Next" } });
	assert.equal(routeKey(BYTE_SPACE, makeState({ optionIndex: 4 }), rt).kind, "ignore");
});

test("Enter toggles a regular multi option (checkbox flip), matching Space", () => {
	assert.deepEqual(routeKey(sentinel(KEY.CONFIRM), makeState(), multiRuntime()), { kind: "toggle", index: 0 });
});

test("Enter on Next commits with current selection and autoAdvanceTab", () => {
	const rt = multiRuntime({ currentItem: { kind: "next", label: "Next" } });
	const r = routeKey(sentinel(KEY.CONFIRM), makeState({ optionIndex: 4, multiSelectChecked: new Set([0, 2]) }), rt);
	assert.deepEqual(r, { kind: "multi_confirm", selected: ["A", "C"], autoAdvanceTab: undefined });
});

test("Enter on 'Type something.' row in a multi question defers to inputMode behavior", () => {
	// Not in input mode yet: Enter on the row is defensively ignored (the row must
	// first receive focus, which activates inputMode via the nav reducer).
	const rt = multiRuntime({ currentItem: { kind: "other", label: "Type something." } });
	assert.equal(routeKey(sentinel(KEY.CONFIRM), makeState({ optionIndex: 3 }), rt).kind, "ignore");
});

// ---------------------------------------------------------------------------
// routeKey — multiSelect free-text (inputMode)
// ---------------------------------------------------------------------------

test("focus nav onto 'Type something.' carries the draft into the nav action", () => {
	const rt = multiRuntime({ inputBuffer: "draft" });
	const r = routeKey(sentinel(KEY.DOWN), makeState({ optionIndex: 2 }), rt);
	assert.deepEqual(r, { kind: "nav", nextIndex: 3, inputValue: "draft" });
});

test("in inputMode, Enter confirms a custom answer with autoAdvanceTab", () => {
	const rt = multiRuntime({ inputBuffer: "my typed answer" });
	const r = routeKey(sentinel(KEY.CONFIRM), makeState({ optionIndex: 3, inputMode: true }), rt);
	assert.equal(r.kind, "confirm");
	assert.deepEqual((r as { answer: QuestionAnswer }).answer, {
		questionIndex: 0,
		question: "Pick one",
		kind: "custom",
		answer: "my typed answer",
	});
});

test("in inputMode, newline is ignored (editor handles it)", () => {
	const rt = multiRuntime({ inputBuffer: "x" });
	assert.equal(routeKey(sentinel(KEY.NEW_LINE), makeState({ optionIndex: 3, inputMode: true }), rt).kind, "ignore");
});

test("in inputMode, Ctrl+U emits input_clear", () => {
	const rt = multiRuntime({ inputBuffer: "x" });
	assert.equal(routeKey(sentinel(KEY.CLEAR), makeState({ optionIndex: 3, inputMode: true }), rt).kind, "input_clear");
});

test("in inputMode, the external-editor binding emits input_edit with the current buffer", () => {
	const rt = multiRuntime({ inputBuffer: "x" });
	assert.deepEqual(
		routeKey(sentinel(KEY.EXTERNAL_EDITOR), makeState({ optionIndex: 3, inputMode: true }), rt),
		{ kind: "input_edit", value: "x" },
	);
});

test("in inputMode, Esc cancels", () => {
	const rt = multiRuntime();
	assert.equal(routeKey(sentinel(KEY.CANCEL), makeState({ optionIndex: 3, inputMode: true }), rt).kind, "cancel");
});

test("in inputMode, UP/DOWN navigate unless the editor cursor can move that way", () => {
	const rt = multiRuntime({ inputBuffer: "two\nlines", canMoveInputUp: true, canMoveInputDown: false });
	const onFirstLine = makeState({ optionIndex: 3, inputMode: true });
	assert.equal(routeKey(sentinel(KEY.EDITOR_UP), onFirstLine, rt).kind, "ignore");
	// Cursor on the first line: UP routes to list nav (keeps draft via inputValue).
	const nav = routeKey(sentinel(KEY.UP), onFirstLine, rt);
	assert.deepEqual(nav, { kind: "nav", nextIndex: 2, inputValue: "two\nlines" });
	// Cursor on the last line: DOWN routes to list nav.
	const rt2 = multiRuntime({ inputBuffer: "two\nlines", canMoveInputUp: true, canMoveInputDown: true });
	assert.equal(routeKey(sentinel(KEY.EDITOR_DOWN), onFirstLine, rt2).kind, "ignore");
	assert.deepEqual(routeKey(sentinel(KEY.DOWN), onFirstLine, rt2), { kind: "nav", nextIndex: 4, inputValue: "two\nlines" });
});

test("plain typed characters in inputMode route to ignore (editor fast path)", () => {
	const rt = multiRuntime({ inputBuffer: "x" });
	assert.equal(routeKey("y", makeState({ optionIndex: 3, inputMode: true }), rt).kind, "ignore");
});

// ---------------------------------------------------------------------------
// routeKey — cancel + submit (Submit tab)
// ---------------------------------------------------------------------------

test("Esc on the Submit tab cancels", () => {
	const rt = makeRuntime({ questions: [makeQuestion()] });
	const atSubmit = makeState({ currentTab: 1 });
	// isMulti == false here (1 question) so the submit tab doesn't exist; use 2 questions
	const multi = makeRuntime();
	assert.equal(routeKey(sentinel(KEY.CANCEL), makeState({ currentTab: 2 }), multi).kind, "cancel");
	assert.equal(routeKey(sentinel(KEY.CANCEL), atSubmit, rt).kind, "ignore");
});

test("Enter on Submit commits; navigating down selects Cancel and Enter cancels", () => {
	const multi = makeRuntime();
	const r = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 2 }), multi);
	assert.equal(r.kind, "submit");
	const nav = routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2 }), multi);
	assert.deepEqual(nav, { kind: "submit_nav", nextIndex: 1 });
	const cancel = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 2, submitChoiceIndex: 1 }), multi);
	assert.equal(cancel.kind, "cancel");
});

test("submitChoiceIndex cycles through [0, 1)", () => {
	const multi = makeRuntime();
	const r = routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2, submitChoiceIndex: 1 }), multi);
	assert.deepEqual(r, { kind: "submit_nav", nextIndex: 0 });
});

test("n on the Submit tab opens the global note editor", () => {
	const multi = makeRuntime();
	assert.deepEqual(routeKey("n", makeState({ currentTab: 2 }), multi), { kind: "notes_enter" });
});

// ---------------------------------------------------------------------------
// routeKey — notes
// ---------------------------------------------------------------------------

test("n on a question tab enters notes mode", () => {
	assert.equal(routeKey("n", makeState(), makeRuntime()).kind, "notes_enter");
});

test("while notes are visible, typed data forwards to the notes editor", () => {
	const r = routeKey("x", makeState({ notesVisible: true }), makeRuntime());
	assert.deepEqual(r, { kind: "notes_forward", data: "x" });
});

test("Esc exits notes mode without cancelling", () => {
	assert.equal(routeKey(sentinel(KEY.CANCEL), makeState({ notesVisible: true }), makeRuntime()).kind, "notes_exit");
});

test("Enter/Send exits notes mode", () => {
	assert.equal(routeKey(sentinel(KEY.SUBMIT), makeState({ notesVisible: true }), makeRuntime()).kind, "notes_exit");
});

test("Shift+Enter (newline) forwards to the notes editor", () => {
	assert.deepEqual(routeKey(sentinel(KEY.NEW_LINE), makeState({ notesVisible: true }), makeRuntime()), {
		kind: "notes_forward",
		data: sentinel(KEY.NEW_LINE),
	});
});

// ---------------------------------------------------------------------------
// routeKey — collapse/expand
// ---------------------------------------------------------------------------

test("the configured collapse key toggles collapse from any inner state", () => {
	const rt = makeRuntime({ collapseKey: "ctrl+]" });
	assert.deepEqual(routeKey("\x1d", makeState(), rt), { kind: "toggle_collapsed" });
	// While collapsed, only cancel and the toggle key route; everything else is swallowed.
	const collapsed = makeState({ collapsed: true });
	assert.deepEqual(routeKey("\x1d", collapsed, rt), { kind: "toggle_collapsed" });
	assert.equal(routeKey(sentinel(KEY.CONFIRM), collapsed, rt).kind, "ignore");
	assert.equal(routeKey("n", collapsed, rt).kind, "ignore");
	assert.equal(routeKey(sentinel(KEY.CANCEL), collapsed, rt).kind, "cancel");
});

test('collapseKey "off" disables the toggle', () => {
	const rt = makeRuntime({ collapseKey: "off" });
	assert.equal(routeKey("\x1d", makeState(), rt).kind, "ignore");
});

test("unsupported collapse key falls back to ignore (defensive runtime boundary)", () => {
	const rt = makeRuntime({ collapseKey: undefined as unknown as string });
	assert.equal(routeKey("\x1d", makeState(), rt).kind, "ignore");
});

// ---------------------------------------------------------------------------
// routeKey — remapped submit key as confirm source
// ---------------------------------------------------------------------------

test("a config where submit != confirm still confirms via either binding", () => {
	const kb = {
		matches: (data: string, name: string) =>
			(name === "tui.input.submit" && data === "<KEY:submit>") ||
			(name === "tui.select.confirm" && data === "<KEY:enter>"),
	};
	const rt = makeRuntime({ keybindings: kb });
	assert.equal(routeKey("<KEY:enter>", makeState(), rt).kind, "confirm");
	assert.equal(routeKey("<KEY:submit>", makeState(), rt).kind, "confirm");
});