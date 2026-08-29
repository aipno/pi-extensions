import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelCompleteSimple, resolveBtwModel } from "../model.ts";

function fakeModel(provider: string, id: string): Model<Api> {
	return { provider, id } as unknown as Model<Api>;
}

type AuthResult = {
	ok: true;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
} | {
	ok: false;
	error: string;
};

function fakeRegistry(options: {
	models: Model<Api>[];
	auth?: (model: Model<Api>) => AuthResult;
	provider?: unknown;
}) {
	return {
		find: (provider: string, modelId: string) =>
			options.models.find((m) => m.provider === provider && m.id === modelId),
		getApiKeyAndHeaders: async (model: Model<Api>) => options.auth?.(model) ?? { ok: true, apiKey: "key" },
		getProvider: () => options.provider,
	};
}

test("uses the current session model when no model is configured", async () => {
	const current = fakeModel("anthropic", "claude");
	const selected = await resolveBtwModel({
		settings: {},
		currentModel: current,
		modelRegistry: fakeRegistry({ models: [current] }),
	});
	assert.equal(selected?.model, current);
	assert.equal(selected?.auth.apiKey, "key");
});

test("prefers the configured model when it exists and has credentials", async () => {
	const current = fakeModel("anthropic", "claude");
	const configured = fakeModel("openrouter", "anthropic/claude-sonnet");
	const selected = await resolveBtwModel({
		settings: { model: "openrouter/anthropic/claude-sonnet" },
		currentModel: current,
		modelRegistry: fakeRegistry({
			models: [current, configured],
			auth: (model) => (model === configured ? { ok: true, apiKey: "configured-key" } : { ok: true, apiKey: "current-key" }),
		}),
	});
	assert.equal(selected?.model, configured);
	assert.equal(selected?.auth.apiKey, "configured-key");
});

test("falls back to the current model when the configured model is unknown", async () => {
	const current = fakeModel("anthropic", "claude");
	const warnings: string[] = [];
	const selected = await resolveBtwModel({
		settings: { model: "nope/missing" },
		currentModel: current,
		modelRegistry: fakeRegistry({ models: [current] }),
		warn: (message) => warnings.push(message),
	});
	assert.equal(selected?.model, current);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /was not found/);
});

test("falls back with a warning when the configured model has no credentials", async () => {
	const current = fakeModel("anthropic", "claude");
	const configured = fakeModel("openrouter", "claude");
	const warnings: string[] = [];
	const selected = await resolveBtwModel({
		settings: { model: "openrouter/claude" },
		currentModel: current,
		modelRegistry: fakeRegistry({
			models: [current, configured],
			auth: (model) =>
				model === configured
					? { ok: false, error: "no key configured" }
					: { ok: true, apiKey: "current-key" },
		}),
		warn: (message) => warnings.push(message),
	});
	assert.equal(selected?.model, current);
	assert.match(warnings[0] ?? "", /unavailable \(no key configured\)/);
});

test("returns undefined when the configured model is the current one and unavailable", async () => {
	const current = fakeModel("anthropic", "claude");
	const warnings: string[] = [];
	const selected = await resolveBtwModel({
		settings: { model: "anthropic/claude" },
		currentModel: current,
		modelRegistry: fakeRegistry({
			models: [current],
			auth: () => ({ ok: false, error: "no key" }),
		}),
		warn: (message) => warnings.push(message),
	});
	assert.equal(selected, undefined);
	assert.ok(warnings.some((w) => w.includes("no distinct current model")));
});

test("invalid configured reference warns and falls back", async () => {
	const current = fakeModel("anthropic", "claude");
	const warnings: string[] = [];
	const selected = await resolveBtwModel({
		settings: { model: "not a reference" },
		currentModel: current,
		modelRegistry: fakeRegistry({ models: [current] }),
		warn: (message) => warnings.push(message),
	});
	assert.equal(selected?.model, current);
	assert.match(warnings[0] ?? "", /is invalid/);
});

test("returns undefined when no model is available at all", async () => {
	const selected = await resolveBtwModel({
		settings: {},
		currentModel: undefined,
		modelRegistry: fakeRegistry({ models: [] }),
	});
	assert.equal(selected, undefined);
});

test("createModelCompleteSimple streams through the provider's streamSimple", async () => {
	const streamed: Array<Record<string, unknown>> = [];
	const provider = {
		streamSimple: (model: unknown, context: unknown, options: unknown) => ({
			result: () => {
				streamed.push({ model, context, options });
				return Promise.resolve({ role: "assistant", content: [], stopReason: "stop" });
			},
		}),
	};
	const completeSimple = createModelCompleteSimple(
		fakeRegistry({ models: [], provider }) as never,
	);
	const model = fakeModel("p", "m");
	const context = { systemPrompt: "sys", messages: [] };
	const options = { reasoning: "low" as const };
	await completeSimple(model, context, options);
	assert.equal(streamed.length, 1);
	assert.equal(streamed[0]?.["model"], model);
	assert.equal(streamed[0]?.["context"], context);
	assert.equal(streamed[0]?.["options"], options);
});

test("createModelCompleteSimple fails when the provider is missing", async () => {
	const completeSimple = createModelCompleteSimple(
		fakeRegistry({ models: [], provider: undefined }) as never,
	);
	await assert.rejects(
		completeSimple(fakeModel("p", "m"), { systemPrompt: "", messages: [] }),
		/No provider registered/,
	);
});