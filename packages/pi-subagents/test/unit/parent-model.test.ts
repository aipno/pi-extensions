import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveParentModel } from "../../src/runs/executor.ts";

function ctxWith(entries: unknown[]) {
	return { sessionManager: { getEntries: () => entries } };
}

test("resolveParentModel prefers the latest model_change entry", () => {
	const model = resolveParentModel(ctxWith([
		{ type: "message", message: { role: "assistant", model: "old-model" } },
		{ type: "model_change", provider: "aipno", modelId: "deepseek-v4-flash" },
	]));
	assert.equal(model, "aipno/deepseek-v4-flash");
});

test("resolveParentModel falls back to the last assistant message model", () => {
	const model = resolveParentModel(ctxWith([
		{ type: "message", message: { role: "user", model: undefined } },
		{ type: "message", message: { role: "assistant", model: "aipno/deepseek-v4-flash" } },
		{ type: "message", message: { role: "assistant", model: "kimi-k2.6" } },
	]));
	assert.equal(model, "kimi-k2.6");
});

test("resolveParentModel ignores non-message entries and returns undefined when empty", () => {
	assert.equal(resolveParentModel(ctxWith([{ type: "model_change", provider: "", modelId: "" }])), undefined);
	assert.equal(resolveParentModel(ctxWith([])), undefined);
	assert.equal(resolveParentModel({ sessionManager: {} }), undefined);
});