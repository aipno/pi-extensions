import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuestionData } from "../../tool/types.ts";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.ts";
import type { QuestionnaireAction } from "../../state/key-router.ts";
import { reduce, type ApplyContext, type Effect } from "../../state/state-reducer.ts";
import type { QuestionnaireState } from "../../state/state.ts";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "H",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map<number, unknown>(),
		multiSelectChecked: new Set<number>(),
		customDraftsByTab: new Map<number, string>(),
		notesByTab: new Map<number, string>(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		...over,
	} as QuestionnaireState;
}

function makeCtx(questions: QuestionData[] = [makeQuestion(), makeQuestion()]): ApplyContext {
	const itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]> = questions.map((q) => [
		...q.options.map((o) => ({ kind: "option" as const, label: o.label })),
		...(q.multiSelect
			? [
					{ kind: "other" as const, label: "Type something." },
					{ kind: "next" as const, label: "Next" },
				]
			: [{ kind: "other" as const, label: "Type something." }]),
	]);
	return { questions, itemsByTab };
}

function apply(state: QuestionnaireState, action: QuestionnaireAction, ctx: ApplyContext) {
	return reduce(state, action, ctx);
}

function effectsOf(effects: readonly Effect[]): string[] {
	return effects.map((e) => e.kind);
}

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------

test("nav to a regular option keeps inputMode off", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "nav", nextIndex: 1, inputValue: "" }, ctx);
	assert.equal(r.state.optionIndex, 1);
	assert.equal(r.state.inputMode, false);
	assert.deepEqual(r.effects, []);
});

test("nav onto the 'Type something.' row activates inputMode and seeds the buffer", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "nav", nextIndex: 2, inputValue: "" }, ctx);
	assert.equal(r.state.optionIndex, 2);
	assert.equal(r.state.inputMode, true);
	assert.deepEqual(effectsOf(r.effects), ["set_input_buffer"]);
	assert.equal((r.effects[0] as { value: string }).value, "");
});

test("nav away from inputMode persists the draft", () => {
	const ctx = makeCtx();
	let r = apply(makeState({ optionIndex: 2, inputMode: true }), { kind: "nav", nextIndex: 0, inputValue: "draft" }, ctx);
	assert.equal(r.state.inputMode, false);
	assert.equal(r.state.customDraftsByTab.get(0), "draft");
	assert.deepEqual(r.effects, []);
});

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

test("confirm stores the answer and resolves done when there are no more questions", () => {
	const single = [makeQuestion()];
	const ctx = makeCtx(single);
	const r = apply(makeState(), { kind: "confirm", answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" } }, ctx);
	assert.equal(r.state.answers.get(0)?.answer, "A");
	assert.deepEqual(effectsOf(r.effects), ["done"]);
	const done = r.effects[0] as Extract<Effect, { kind: "done" }>;
	assert.deepEqual(done.result, { answers: [{ questionIndex: 0, question: "Pick one", kind: "option", answer: "A" }], cancelled: false });
});

test("confirm on an option carrying a preview echoes the preview into the answer", () => {
	const q = makeQuestion({
		options: [
			{ label: "A", description: "a", preview: "## A" },
			{ label: "B", description: "b" },
		],
	});
	const ctx = makeCtx([q]);
	const r = apply(makeState(), { kind: "confirm", answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" } }, ctx);
	assert.equal(r.state.answers.get(0)?.preview, "## A");
});

test("confirm with autoAdvanceTab switches tabs and clears question-local UI state", () => {
	const ctx = makeCtx();
	const r = apply(
		makeState({ notesByTab: new Map([[0, "note"]]), multiSelectChecked: new Set([1]) }),
		{ kind: "confirm", answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" }, autoAdvanceTab: 1 },
		ctx,
	);
	assert.equal(r.state.currentTab, 1);
	assert.equal(r.state.optionIndex, 0);
	assert.equal(r.state.inputMode, false);
	assert.equal(r.state.notesVisible, false);
	assert.deepEqual(effectsOf(r.effects), ["set_notes_focused", "set_notes_value", "set_input_buffer"]);
});

test("confirm merges pending notes into the answer", () => {
	const ctx = makeCtx();
	const r = apply(
		makeState({ notesByTab: new Map([[0, "my note"]]) }),
		{ kind: "confirm", answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" } },
		ctx,
	);
	assert.equal(r.state.answers.get(0)?.notes, "my note");
});

test("custom confirm clears the draft and, on multi questions, the checked set", () => {
	const q = makeQuestion({ multiSelect: true });
	const q2 = makeQuestion({ question: "Second" });
	const ctx = makeCtx([q, q2]);
	const r = apply(
		makeState({ customDraftsByTab: new Map([[0, "draft"]]), multiSelectChecked: new Set([0, 1]) }),
		{ kind: "confirm", answer: { questionIndex: 0, question: "Pick one", kind: "custom", answer: "typed" } },
		ctx,
	);
	assert.equal(r.state.customDraftsByTab.has(0), false);
	assert.deepEqual([...r.state.multiSelectChecked], []);
});

// ---------------------------------------------------------------------------
// toggle / multi_confirm
// ---------------------------------------------------------------------------

test("toggle adds and removes checked indices", () => {
	const q = makeQuestion({ multiSelect: true });
	const ctx = makeCtx([q, makeQuestion({ question: "Second" })]);
	let r = apply(makeState(), { kind: "toggle", index: 0 }, ctx);
	assert.ok(r.state.multiSelectChecked.has(0));
	r = apply(r.state, { kind: "toggle", index: 0 }, ctx);
	assert.equal(r.state.multiSelectChecked.has(0), false);
});

test("toggle persists a multi answer and removes it when the last selection clears", () => {
	const q = makeQuestion({ multiSelect: true });
	const ctx = makeCtx([q, makeQuestion({ question: "Second" })]);
	let r = apply(makeState(), { kind: "toggle", index: 0 }, ctx);
	assert.equal(r.state.answers.get(0)?.kind, "multi");
	assert.deepEqual((r.state.answers.get(0) as { selected: string[] }).selected, ["A"]);
	r = apply(r.state, { kind: "toggle", index: 0 }, ctx);
	assert.equal(r.state.answers.has(0), false);
});

test("multi_confirm commits the selection and syncs checkboxes on the next visit", () => {
	const q = makeQuestion({ multiSelect: true });
	const ctx = makeCtx([q, makeQuestion({ question: "Second" })]);
	const r = apply(makeState(), { kind: "multi_confirm", selected: ["B"] }, ctx);
	assert.equal(r.state.answers.get(0)?.kind, "multi");
	assert.deepEqual((r.state.answers.get(0) as { selected: string[] }).selected, ["B"]);
	assert.deepEqual([...r.state.multiSelectChecked], [1]);
	assert.deepEqual(effectsOf(r.effects), ["done"]);
});

test("tab_switch back re-syncs multiSelectChecked from the saved answer", () => {
	const q = makeQuestion({ multiSelect: true });
	const ctx = makeCtx([q, makeQuestion({ question: "Second" })]);
	const answered = apply(makeState(), { kind: "multi_confirm", selected: ["A"] }, ctx).state;
	const back = apply(answered, { kind: "tab_switch", nextTab: 0 }, ctx);
	assert.deepEqual([...back.state.multiSelectChecked], [0]);
	assert.equal(back.state.optionIndex, 0);
	assert.equal(back.state.inputMode, false);
});

// ---------------------------------------------------------------------------
// notes lifecycle
// ---------------------------------------------------------------------------

test("notes_enter seeds the editor and focuses it", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "notes_enter" }, ctx);
	assert.equal(r.state.notesVisible, true);
	assert.deepEqual(effectsOf(r.effects), ["set_notes_value", "set_notes_focused"]);
	assert.equal((r.effects[0] as { value: string }).value, "");
});

test("notes_exit with non-empty draft persists the note into notesByTab and the answer", () => {
	const ctx = makeCtx();
	const withAnswer = makeState({
		answers: new Map([[0, { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" }]]),
	});
	const entered = apply(withAnswer, { kind: "notes_enter" }, ctx).state;
	const exited = apply({ ...entered, notesDraft: "  my note  " }, { kind: "notes_exit" }, ctx);
	assert.equal(exited.state.notesVisible, false);
	assert.equal(exited.state.notesByTab.get(0), "my note");
	assert.equal(exited.state.answers.get(0)?.notes, "my note");
	assert.deepEqual(effectsOf(exited.effects), ["set_notes_focused"]);
});

test("notes_exit with an empty draft removes the note (and strips it from the answer)", () => {
	const ctx = makeCtx();
	const answered = apply(
		makeState({ answers: new Map([[0, { questionIndex: 0, question: "q", kind: "option", answer: "A", notes: "old" }]]) }),
		{ kind: "notes_enter" },
		ctx,
	).state;
	const exited = apply({ ...answered, notesDraft: "   " }, { kind: "notes_exit" }, ctx);
	assert.equal(exited.state.notesByTab.has(0), false);
	assert.equal(exited.state.answers.get(0)?.notes, undefined);
});

test("global note lives at the questions.length pseudo-index and lifts on submit/cancel", () => {
	const ctx = makeCtx();
	const r = apply(
		makeState({ notesByTab: new Map([[2, "global"]]), answers: new Map([[0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }]]) }),
		{ kind: "submit" },
		ctx,
	);
	const done = r.effects[0] as Extract<Effect, { kind: "done" }>;
	assert.equal(done.result.globalNote, "global");
	assert.equal(done.result.cancelled, false);
});

test("note-free results never carry a globalNote key", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "cancel" }, ctx);
	const done = r.effects[0] as Extract<Effect, { kind: "done" }>;
	assert.equal("globalNote" in done.result, false);
	assert.equal(done.result.cancelled, true);
});

// ---------------------------------------------------------------------------
// custom-input controls
// ---------------------------------------------------------------------------

test("input_clear clears the draft and the buffer", () => {
	const ctx = makeCtx();
	const r = apply(makeState({ customDraftsByTab: new Map([[0, "x"]]), inputMode: true }), { kind: "input_clear" }, ctx);
	assert.equal(r.state.customDraftsByTab.get(0), "");
	assert.deepEqual(effectsOf(r.effects), ["clear_input_buffer"]);
});

test("input_edit opens the external editor with the current value", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "input_edit", value: "x" }, ctx);
	assert.deepEqual(r.effects, [{ kind: "open_input_editor", value: "x" }]);
});

test("input_replace stores the draft and writes it to the buffer", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "input_replace", value: "edited" }, ctx);
	assert.equal(r.state.customDraftsByTab.get(0), "edited");
	assert.deepEqual(r.effects, [{ kind: "set_input_buffer", value: "edited" }]);
});

// ---------------------------------------------------------------------------
// submit_nav / ignore
// ---------------------------------------------------------------------------

test("submit_nav updates the picker index; ignore leaves state untouched", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "submit_nav", nextIndex: 1 }, ctx);
	assert.equal(r.state.submitChoiceIndex, 1);
	assert.deepEqual(r.effects, []);
	const ignored = apply(makeState(), { kind: "ignore" }, ctx);
	assert.deepEqual(ignored.state, makeState());
	assert.deepEqual(ignored.effects, []);
});

// ---------------------------------------------------------------------------
// toggle_collapsed
// ---------------------------------------------------------------------------

test("toggle_collapsed flips collapsed and emits set_overlay_hidden", () => {
	const ctx = makeCtx();
	const r = apply(makeState(), { kind: "toggle_collapsed" }, ctx);
	assert.equal(r.state.collapsed, true);
	assert.deepEqual(r.effects, [{ kind: "set_overlay_hidden", hidden: true }]);
	const back = apply(r.state, { kind: "toggle_collapsed" }, ctx);
	assert.equal(back.state.collapsed, false);
	assert.deepEqual(back.effects, [{ kind: "set_overlay_hidden", hidden: false }]);
});