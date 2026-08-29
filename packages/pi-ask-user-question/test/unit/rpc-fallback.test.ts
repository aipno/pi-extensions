import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDialogUI, parseIndex, runRpcQuestionnaire, type DialogUI } from "../../rpc-fallback.ts";
import { buildQuestionnaireResponse } from "../../tool/response-envelope.ts";
import type { QuestionData, QuestionParams } from "../../tool/types.ts";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Which?",
		header: over.header ?? "Pick",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeParams(questions: QuestionData[]): QuestionParams {
	return { questions };
}

function fakeUI(over: Partial<DialogUI> = {}): DialogUI & { selectCalls: unknown[][]; inputCalls: unknown[][] } {
	const selectCalls: unknown[][] = [];
	const inputCalls: unknown[][] = [];
	return {
		select: async (title, options) => {
			selectCalls.push([title, options]);
			return over.select ? over.select(title, options) : options[0];
		},
		input: async (title, placeholder) => {
			inputCalls.push([title, placeholder]);
			return over.input ? over.input(title, placeholder) : "";
		},
		selectCalls,
		inputCalls,
	};
}

// ---------------------------------------------------------------------------
// hasDialogUI / parseIndex
// ---------------------------------------------------------------------------

test("hasDialogUI requires select AND input functions", () => {
	assert.equal(hasDialogUI(undefined), false);
	assert.equal(hasDialogUI({}), false);
	assert.equal(hasDialogUI({ select: () => {} }), false);
	assert.equal(hasDialogUI({ select: () => {}, input: () => {} }), true);
});

test("parseIndex parses leading digits and bounds-checks", () => {
	assert.equal(parseIndex("1", 3), 0);
	assert.equal(parseIndex("2. B — b", 3), 1);
	assert.equal(parseIndex("3", 3), 2);
	assert.equal(parseIndex("4", 3), null);
	assert.equal(parseIndex("0", 3), null);
	assert.equal(parseIndex("abc", 3), null);
});

// ---------------------------------------------------------------------------
// runRpcQuestionnaire — single select
// ---------------------------------------------------------------------------

test("single-select returns the chosen option label", async () => {
	const ui = fakeUI({ select: async (_t, options) => options[1] });
	const result = await runRpcQuestionnaire(ui, makeParams([makeQuestion()]));
	assert.equal(result.cancelled, false);
	const a = result.answers[0];
	assert.equal(a?.questionIndex, 0);
	assert.equal(a?.question, "Which?");
	assert.equal(a?.kind, "option");
	assert.equal(a?.answer, "B");
});

test("single-select appends the 'Type something.' sentinel row", async () => {
	let offered: string[] = [];
	const ui = fakeUI({
		select: async (_t, options) => {
			offered = options;
			return options[0];
		},
	});
	await runRpcQuestionnaire(ui, makeParams([makeQuestion()]));
	assert.deepEqual(offered, ["1. A — a", "2. B — b", "3. Type something."]);
});

test("'Type something.' follow-up uses the input dialog and returns custom text", async () => {
	const ui = fakeUI({
		select: async (_t, options) => options[options.length - 1],
		input: async () => "typed it",
	});
	const result = await runRpcQuestionnaire(ui, makeParams([makeQuestion()]));
	assert.equal(result.answers[0]?.kind, "custom");
	assert.equal(result.answers[0]?.answer, "typed it");
});

test("dismissing any dialog cancels the whole questionnaire", async () => {
	const ui = fakeUI({ select: async () => undefined });
	const result = await runRpcQuestionnaire(ui, makeParams([makeQuestion()]));
	assert.deepEqual(result, { answers: [], cancelled: true });
});

test("an out-of-range select return is treated as a dismissal", async () => {
	const ui = fakeUI({ select: async () => "99. way out" });
	const result = await runRpcQuestionnaire(ui, makeParams([makeQuestion()]));
	assert.equal(result.cancelled, true);
});

test("previews fold into the select title and ride the answer", async () => {
	const q = makeQuestion({
		options: [
			{ label: "A", description: "a", preview: "PREVIEW-A" },
			{ label: "B", description: "b" },
		],
	});
	let title = "";
	const ui = fakeUI({
		select: async (t, options) => {
			title = t;
			return options[0];
		},
	});
	const result = await runRpcQuestionnaire(ui, makeParams([q]));
	assert.ok(title.includes("PREVIEW-A"));
	assert.equal(result.answers[0]?.preview, "PREVIEW-A");
});

test("walks multiple questions sequentially and builds the shared envelope", async () => {
	const multi = makeQuestion({ question: "Pick colors?", multiSelect: true });
	const ui = fakeUI({
		select: async (_t, options) => options[0],
		input: async () => "2",
	});
	const result = await runRpcQuestionnaire(ui, makeParams([makeQuestion(), multi]));
	const envelope = buildQuestionnaireResponse(result, makeParams([makeQuestion(), multi]));
	const text = envelope.content[0].text;
	assert.ok(text.includes('"Which?"="A"'));
	assert.ok(text.includes('"Pick colors?"="B"'));
});

// ---------------------------------------------------------------------------
// runRpcQuestionnaire — multi select
// ---------------------------------------------------------------------------

test("multi-select parses comma-separated indices into labels, deduped", async () => {
	const multi = makeQuestion({ question: "Pick colors?", multiSelect: true });
	const ui = fakeUI({ input: async () => "1,2,1" });
	const result = await runRpcQuestionnaire(ui, makeParams([multi]));
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Pick colors?",
		kind: "multi",
		answer: null,
		selected: ["A", "B"],
	});
});

test("multi-select treats non-index input as a typed custom answer", async () => {
	const multi = makeQuestion({ question: "Pick colors?", multiSelect: true });
	const ui = fakeUI({ input: async () => "red, something else entirely" });
	const result = await runRpcQuestionnaire(ui, makeParams([multi]));
	assert.equal(result.answers[0]?.kind, "custom");
	assert.equal(result.answers[0]?.answer, "red, something else entirely");
});

test("multi-select treats an out-of-range number as a custom answer", async () => {
	const multi = makeQuestion({ question: "Pick colors?", multiSelect: true });
	const ui = fakeUI({ input: async () => "13" });
	const result = await runRpcQuestionnaire(ui, makeParams([multi]));
	assert.equal(result.answers[0]?.kind, "custom");
	assert.equal(result.answers[0]?.answer, "13");
});

test("multi-select empty input commits an empty selection", async () => {
	const multi = makeQuestion({ question: "Pick colors?", multiSelect: true });
	const ui = fakeUI({ input: async () => "   " });
	const result = await runRpcQuestionnaire(ui, makeParams([multi]));
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Pick colors?",
		kind: "multi",
		answer: null,
		selected: [],
	});
});

test("multi-select dismissal cancels (input resolves undefined)", async () => {
	const multi = makeQuestion({ question: "Pick colors?", multiSelect: true });
	const ui = fakeUI({ input: async () => undefined });
	const result = await runRpcQuestionnaire(ui, makeParams([multi]));
	assert.equal(result.cancelled, true);
});