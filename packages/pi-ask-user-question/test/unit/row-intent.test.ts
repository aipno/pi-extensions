import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuestionData } from "../../tool/types.ts";
import {
	LABELS_BY_KIND,
	RESERVED_LABEL_SET,
	ROW_INTENT_META,
	SENTINEL_KINDS,
	sentinelsToAppend,
} from "../../state/row-intent.ts";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.ts";

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

test("ROW_INTENT_META covers every WrappingSelectItem kind (compile-time exhaustiveness)", () => {
	const kinds: WrappingSelectItem["kind"][] = ["option", "other", "next"];
	for (const kind of kinds) {
		assert.ok(ROW_INTENT_META[kind], `missing meta for ${kind}`);
	}
	assert.deepEqual(SENTINEL_KINDS, ["other", "next"]);
});

test("single-select appends only the 'other' sentinel", () => {
	const q = makeQuestion();
	assert.deepEqual(sentinelsToAppend(q), ["other"]);
});

test("multi-select appends both 'other' and 'next' sentinels", () => {
	const q = makeQuestion({ multiSelect: true });
	assert.deepEqual(sentinelsToAppend(q), ["other", "next"]);
});

test("LABELS_BY_KIND sources from ROW_INTENT_META", () => {
	assert.equal(LABELS_BY_KIND.other, ROW_INTENT_META.other.label);
	assert.equal(LABELS_BY_KIND.next, ROW_INTENT_META.next.label);
	assert.equal(ROW_INTENT_META.other.label, "Type something.");
	assert.equal(ROW_INTENT_META.next.label, "Next");
});

test("RESERVED_LABEL_SET contains Other plus reserved sentinel labels", () => {
	assert.deepEqual(
		[...RESERVED_LABEL_SET].sort(),
		["Next", "Other", "Type something."].sort(),
	);
	for (const label of ["Other", "Type something.", "Next"]) {
		assert.ok(RESERVED_LABEL_SET.has(label), `expected ${label} reserved`);
	}
	assert.equal(RESERVED_LABEL_SET.has("A"), false);
});

test("sentinel row meta flags match the documented behavior", () => {
	const other = ROW_INTENT_META.other;
	assert.equal(other.activatesInputMode, true);
	assert.equal(other.autoAppendOnSingleSelect, true);
	assert.equal(other.autoAppendOnMultiSelect, true);
	assert.equal(other.blocksMultiToggle, false);
	const next = ROW_INTENT_META.next;
	assert.equal(next.blocksMultiToggle, true);
	assert.equal(next.autoSubmitsInMulti, true);
	assert.equal(next.autoAppendOnSingleSelect, false);
	assert.equal(next.autoAppendOnMultiSelect, true);
	assert.equal(next.activatesInputMode, false);
	assert.equal(next.numbered, false);
});