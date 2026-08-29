import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import {
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionParams,
	QuestionParamsSchema,
	QuestionsSchema,
	RESERVED_LABELS,
} from "../../tool/types.ts";
import {
	ERROR_DUPLICATE_OPTION_LABEL,
	ERROR_DUPLICATE_QUESTION,
	ERROR_NO_QUESTIONS,
	ERROR_RESERVED_LABEL,
	ERROR_TOO_FEW_OPTIONS,
	ERROR_TOO_MANY_QUESTIONS,
	validateQuestionnaire,
} from "../../tool/validate-questionnaire.ts";
import { buildAnswerSegment, buildQuestionnaireResponse, DECLINE_MESSAGE, ENVELOPE_PREFIX, ENVELOPE_SUFFIX } from "../../tool/response-envelope.ts";
import { formatAnswerScalar, NO_INPUT_PLACEHOLDER } from "../../tool/format-answer.ts";

function makeQuestion(override: Partial<QuestionData> = {}): QuestionData {
	return {
		question: override.question ?? "What's your name?",
		header: override.header ?? "Hdr",
		options: override.options ?? [
			{ label: "A", description: "Choice A" },
			{ label: "B", description: "Choice B" },
		],
		multiSelect: override.multiSelect,
	};
}

function makeParams(questions: QuestionData[]): QuestionParams {
	return { questions };
}

// ---------------------------------------------------------------------------
// TypeBox schema
// ---------------------------------------------------------------------------

test("QuestionsSchema accepts a single question", () => {
	assert.ok(Value.Check(QuestionsSchema, [makeQuestion()]));
});

test("QuestionsSchema accepts MAX_QUESTIONS (4) questions", () => {
	const four = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
	assert.ok(Value.Check(QuestionsSchema, four));
	assert.equal(MAX_QUESTIONS, 4);
});

test("QuestionsSchema rejects empty array and more than 4 questions", () => {
	assert.equal(Value.Check(QuestionsSchema, []), false);
	const five = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
	assert.equal(Value.Check(QuestionsSchema, five), false);
});

test("QuestionSchema accepts optional fields (preview, multiSelect, default)", () => {
	const q = makeQuestion({
		options: [
			{ label: "A", description: "alpha", preview: "## A\n\nbody" },
			{ label: "B", description: "beta" },
		],
		multiSelect: true,
	});
	assert.ok(Value.Check(QuestionsSchema, [q]));
});

test("QuestionSchema enforces option count within [MIN_OPTIONS, MAX_OPTIONS]", () => {
	assert.equal(MIN_OPTIONS, 2);
	assert.equal(MAX_OPTIONS, 4);
	const one = makeQuestion({ options: [{ label: "A", description: "a" }] });
	assert.equal(Value.Check(QuestionsSchema, [one]), false);
	const five = makeQuestion({
		options: [1, 2, 3, 4, 5].map((i) => ({ label: `L${i}`, description: "d" })),
	});
	assert.equal(Value.Check(QuestionsSchema, [five]), false);
});

test("QuestionSchema enforces header max length", () => {
	assert.equal(MAX_HEADER_LENGTH, 16);
	const long = makeQuestion({ header: "x".repeat(17) });
	assert.equal(Value.Check(QuestionsSchema, [long]), false);
	const ok = makeQuestion({ header: "x".repeat(16) });
	assert.ok(Value.Check(QuestionsSchema, [ok]));
});

test("QuestionSchema enforces label max length", () => {
	assert.equal(MAX_LABEL_LENGTH, 60);
	const long = makeQuestion({ options: [{ label: "x".repeat(61), description: "d" }, { label: "B", description: "d" }] });
	assert.equal(Value.Check(QuestionsSchema, [long]), false);
});

test("QuestionParamsSchema accepts a valid params object", () => {
	assert.ok(Value.Check(QuestionParamsSchema, makeParams([makeQuestion()])));
});

test("RESERVED_LABELS is the pinned literal order", () => {
	assert.deepEqual([...RESERVED_LABELS], ["Other", "Type something.", "Next"]);
});

// ---------------------------------------------------------------------------
// validateQuestionnaire
// ---------------------------------------------------------------------------

test("validateQuestionnaire accepts a valid questionnaire", () => {
	const r = validateQuestionnaire(makeParams([makeQuestion(), makeQuestion({ question: "Second?" })]));
	assert.deepEqual(r, { ok: true });
});

test("validateQuestionnaire rejects zero questions", () => {
	const r = validateQuestionnaire(makeParams([]));
	assert.deepEqual(r, { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS });
});

test("validateQuestionnaire rejects > MAX_QUESTIONS questions", () => {
	const five = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
	const r = validateQuestionnaire(makeParams(five));
	assert.deepEqual(r, { ok: false, error: "too_many_questions", message: ERROR_TOO_MANY_QUESTIONS });
});

test("validateQuestionnaire rejects duplicate question text", () => {
	const r = validateQuestionnaire(makeParams([makeQuestion(), makeQuestion()]));
	assert.deepEqual(r, { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION });
});

test("validateQuestionnaire rejects too-few options", () => {
	const r = validateQuestionnaire(
		makeParams([makeQuestion({ options: [{ label: "A", description: "a" }] })]),
	);
	assert.deepEqual(r, { ok: false, error: "empty_options", message: ERROR_TOO_FEW_OPTIONS });
});

test("validateQuestionnaire rejects reserved labels before duplicates", () => {
	const r = validateQuestionnaire(
		makeParams([makeQuestion({ options: [{ label: "Other", description: "a" }, { label: "Other", description: "b" }] })]),
	);
	assert.deepEqual(r, { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL });
});

test("validateQuestionnaire rejects duplicate option labels within a question", () => {
	const r = validateQuestionnaire(
		makeParams([makeQuestion({ options: [{ label: "A", description: "a" }, { label: "A", description: "b" }] })]),
	);
	assert.deepEqual(r, { ok: false, error: "duplicate_option_label", message: ERROR_DUPLICATE_OPTION_LABEL });
});

// ---------------------------------------------------------------------------
// formatAnswerScalar
// ---------------------------------------------------------------------------

test("formatAnswerScalar formats option answers", () => {
	assert.equal(formatAnswerScalar({ questionIndex: 0, question: "q", kind: "option", answer: "A" }, "envelope"), "A");
	assert.equal(
		formatAnswerScalar({ questionIndex: 0, question: "q", kind: "option", answer: null }, "envelope"),
		NO_INPUT_PLACEHOLDER,
	);
});

test("formatAnswerScalar formats custom answers", () => {
	assert.equal(
		formatAnswerScalar({ questionIndex: 0, question: "q", kind: "custom", answer: "typed" }, "summary"),
		"typed",
	);
	assert.equal(
		formatAnswerScalar({ questionIndex: 0, question: "q", kind: "custom", answer: "" }, "summary"),
		NO_INPUT_PLACEHOLDER,
	);
	assert.equal(
		formatAnswerScalar({ questionIndex: 0, question: "q", kind: "custom", answer: null }, "summary"),
		NO_INPUT_PLACEHOLDER,
	);
});

test("formatAnswerScalar formats multi-select answers", () => {
	assert.equal(
		formatAnswerScalar({ questionIndex: 0, question: "q", kind: "multi", answer: null, selected: ["red", "blue"] }, "envelope"),
		"red, blue",
	);
	assert.equal(
		formatAnswerScalar({ questionIndex: 0, question: "q", kind: "multi", answer: null, selected: [] }, "envelope"),
		NO_INPUT_PLACEHOLDER,
	);
});

// ---------------------------------------------------------------------------
// buildQuestionnaireResponse / buildAnswerSegment
// ---------------------------------------------------------------------------

const PARAMS = makeParams([
	makeQuestion({ question: "Pick one?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }),
]);

test("answered envelope prefixes with the canonical phrase and per-question segments", () => {
	const result = {
		answers: [{ questionIndex: 0, question: "Pick one?", kind: "option" as const, answer: "A" }],
		cancelled: false,
	};
	const r = buildQuestionnaireResponse(result, PARAMS);
	const text = r.content[0].text;
	assert.ok(text.startsWith(ENVELOPE_PREFIX));
	assert.ok(text.endsWith(ENVELOPE_SUFFIX));
	assert.ok(text.includes('"Pick one?"="A"'));
});

test("decline envelope is emitted for cancelled results", () => {
	const r = buildQuestionnaireResponse({ answers: [], cancelled: true }, PARAMS);
	assert.equal(r.content[0].text, DECLINE_MESSAGE);
	assert.deepEqual(r.details, { answers: [], cancelled: true });
});

test("decline envelope is emitted for null/undefined results", () => {
	for (const result of [null, undefined]) {
		const r = buildQuestionnaireResponse(result, PARAMS);
		assert.equal(r.content[0].text, DECLINE_MESSAGE);
		assert.deepEqual(r.details, { answers: [], cancelled: true });
	}
});

test("answer segment echoes preview and notes", () => {
	const segment = buildAnswerSegment({
		questionIndex: 0,
		question: "Which?",
		kind: "option",
		answer: "A",
		preview: "## A",
		notes: "user note",
	});
	assert.equal(segment, '"Which?"="A". selected preview: ## A. user notes: user note.');
});

test("cancelled result still carries answers and global note in details", () => {
	const r = buildQuestionnaireResponse(
		{ answers: [{ questionIndex: 0, question: "Pick one?", kind: "option", answer: "A" }], cancelled: true, globalNote: "g" },
		PARAMS,
	);
	assert.equal(r.content[0].text, DECLINE_MESSAGE);
	assert.deepEqual(r.details, {
		answers: [{ questionIndex: 0, question: "Pick one?", kind: "option", answer: "A" }],
		cancelled: true,
		globalNote: "g",
	});
});

test("global note rides the answered envelope even with zero answers", () => {
	const r = buildQuestionnaireResponse({ answers: [], cancelled: false, globalNote: "g" }, PARAMS);
	assert.ok(r.content[0].text.startsWith(ENVELOPE_PREFIX));
	assert.ok(r.content[0].text.includes("global note: g."));
});

test("zero segments without a note falls to the decline envelope", () => {
	const r = buildQuestionnaireResponse({ answers: [], cancelled: false }, PARAMS);
	assert.equal(r.content[0].text, DECLINE_MESSAGE);
	assert.deepEqual(r.details, { answers: [], cancelled: true });
});