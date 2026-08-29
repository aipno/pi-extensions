import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUsageSettingsPatch, createMockContext, createMockPi } from "./support.ts";
import type { UsageSettings, UsageSettingsPatch, UsageSettingsRuntime, UsageSettingsState } from "../src/settings.ts";
import usageExtension from "../src/usage.ts";

const codexModel = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

function runtime(kind: UsageSettingsState["kind"] = "loaded") {
	let state: UsageSettingsState = {
		kind,
		path: "/tmp/pi-usage.json",
		settings: { codexFastMode: false, xaiUsage: false, usageStatusline: true },
		...(kind === "invalid" ? { issue: "bad file" } : { document: {} }),
	};
	const patches: unknown[] = [];
	const settingsRuntime: UsageSettingsRuntime = {
		get: () => structuredClone(state),
		async reload() {
			return structuredClone(state);
		},
		async update(patch: UsageSettingsPatch) {
			patches.push(patch);
			const settings = { ...state.settings };
			const document = { ...(state.document ?? {}) };
			applyUsageSettingsPatch(settings as Record<string, unknown>, patch);
			applyUsageSettingsPatch(document, patch);
			state = {
				...state,
				kind: "loaded",
				settings: settings as UsageSettingsState["settings"],
				document,
			};
			return structuredClone(state);
		},
		async flush() {},
	};
	return {
		settingsRuntime,
		patches,
		get state() {
			return state;
		},
	};
}

function registry() {
	return {
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "codex-token" }),
		getProviderAuth: async () => ({ auth: { apiKey: "codex-token" } }),
		getAvailable: () => [codexModel],
		getAll: () => [codexModel],
		getProviderAuthStatus: () => ({ configured: true }),
		getProviderDisplayName: () => "OpenAI Codex",
	};
}

function response(): Promise<Response> {
	return Promise.resolve(
		new Response(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
			}),
			{ status: 200 },
		),
	);
}

test("/usage shows Fast state and toggles the same persistent preference", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const memory = runtime();
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memory.settingsRuntime });
	const choices = ["Turn Fast mode on", "Close"];
	const titles: string[] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.deepEqual(memory.patches, [{ codexFastMode: true }]);
	assert.match(titles[0] ?? "", /Fast mode: Off/);
	assert.match(titles[0] ?? "", /1\.5× faster.*uses more/);
	assert.match(notifications[0]?.message ?? "", /Fast mode enabled/);
});

test("/usage cancellation does not change Fast and unsupported models show no toggle", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const cancelled = runtime();
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: cancelled.settingsRuntime });
	let options: string[] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (_title: string, values: string[]) => {
			options = values;
			return undefined;
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.ok(options.includes("Turn Fast mode on"));
	assert.deepEqual(cancelled.patches, []);

	const unsupported = runtime();
	const unsupportedMock = createMockPi();
	usageExtension(unsupportedMock.pi, { settingsRuntime: unsupported.settingsRuntime });
	let unsupportedTitle = "";
	let unsupportedOptions: string[] = [];
	const unsupportedModel = { ...codexModel, id: "gpt-5.4-mini" };
	const unsupportedContext = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: unsupportedModel,
		select: async (title: string, values: string[]) => {
			unsupportedTitle = title;
			unsupportedOptions = values;
			return "Close";
		},
		modelRegistry: {
			...registry(),
			getAvailable: () => [unsupportedModel],
			getAll: () => [unsupportedModel],
		},
	});
	await unsupportedMock.commands.get("usage")?.handler("", unsupportedContext.ctx);
	assert.match(unsupportedTitle, /Fast mode: Unavailable/);
	assert.ok(!unsupportedOptions.some((value) => value.includes("Fast mode on")));
});

test("invalid settings make the /usage Fast action visibly read-only", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = response;
	const invalid = runtime("invalid");
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: invalid.settingsRuntime });
	let rendered = "";
	let options: string[] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string, values: string[]) => {
			rendered = title;
			options = values;
			return "Close";
		},
		modelRegistry: registry(),
	});
	await mock.commands.get("usage")?.handler("", ctx);
	assert.match(rendered, /Fast mode: Off/);
	assert.ok(options.includes("Turn Fast mode on"));
	assert.deepEqual(invalid.patches, []);
});
