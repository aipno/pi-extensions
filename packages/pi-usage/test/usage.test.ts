import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { test } from "node:test";
import { applyUsageSettingsPatch, createMockContext, createMockPi } from "./support.ts";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../src/oauth-credential-source.ts";
import type { UsageSettingsRuntime, UsageSettingsPatch, UsageSettingsState } from "../src/settings.ts";
import usageExtension from "../src/usage.ts";
import { showUsageSettings } from "../src/usage-settings-ui.ts";

initTheme("dark", false);

const openRouterModel = {
	id: "openai/gpt-4o",
	name: "GPT-4o",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
};
const codexToken = codexAccessToken("account-123");

const codexModel = {
	id: "gpt-5.3-codex",
	name: "GPT-5.3 Codex",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

const xaiModel = {
	id: "grok-4.5",
	name: "Grok 4.5",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
};

const zaiModel = {
	id: "glm-5.3",
	name: "GLM-5.3",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/coding/paas/v4",
};

const kimiModel = {
	id: "kimi-k2",
	name: "Kimi K2",
	provider: "kimi-coding",
	baseUrl: "https://api.kimi.com/coding",
};

const newApiModel = {
	id: "gpt-4o",
	name: "GPT-4o",
	provider: "new-api",
	baseUrl: "https://gateway.example.com/v1",
};

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function memorySettingsRuntime(
	xaiUsage = true,
	failUpdates = false,
	kind: UsageSettingsState["kind"] = "loaded",
	newApiSystemToken?: string,
	newApiUserId?: number,
	usageStatusline = true,
): { runtime: UsageSettingsRuntime; state: () => UsageSettingsState } {
	let state: UsageSettingsState = {
		kind,
		path: "/tmp/pi-usage.json",
		settings: {
			codexFastMode: false,
			xaiUsage,
			usageStatusline,
			...(newApiSystemToken ? { newApiSystemToken } : {}),
			...(newApiUserId !== undefined ? { newApiUserId } : {}),
		},
		...(kind === "invalid"
			? { issue: "invalid test settings" }
			: {
					document: {
						codexFastMode: false,
						xaiUsage,
						usageStatusline,
						...(newApiSystemToken ? { newApiSystemToken } : {}),
						...(newApiUserId !== undefined ? { newApiUserId } : {}),
					},
				}),
	};
	const runtime: UsageSettingsRuntime = {
		get: () => structuredClone(state),
		reload: async () => structuredClone(state),
		update: async (patch: UsageSettingsPatch, signal) => {
			signal?.throwIfAborted();
			if (failUpdates) throw new Error("disk full");
			const settings = { ...state.settings };
			const document = { ...(state.document ?? {}) };
			applyUsageSettingsPatch(settings as Record<string, unknown>, patch);
			applyUsageSettingsPatch(document, patch);
			state = {
				...state,
				settings: settings as UsageSettingsState["settings"],
				document,
			};
			return structuredClone(state);
		},
		flush: async () => undefined,
	};
	return { runtime, state: () => structuredClone(state) };
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function usageFetch(input: string | URL | Request): Promise<Response> {
	const url = String(input);
	if (url.endsWith("/api/v1/key")) {
		return Promise.resolve(
			new Response(
				JSON.stringify({
					data: {
						label: "test-key",
						limit: 100,
						limit_remaining: 75,
						limit_reset: "monthly",
						usage: 25,
						usage_daily: 1,
						usage_weekly: 5,
						usage_monthly: 25,
					},
				}),
				{ status: 200 },
			),
		);
	}
	if (url.endsWith("/coding/v1/usages")) {
		return Promise.resolve(
			new Response(
				JSON.stringify({
					usage: { used: "40", limit: "1000" },
					limits: [
						{
							window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
							detail: { used: "1", limit: "100" },
						},
					],
				}),
				{ status: 200 },
			),
		);
	}
	return Promise.resolve(
		new Response(
			JSON.stringify({
				plan_type: "pro",
				rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
			}),
			{ status: 200 },
		),
	);
}

test("pi-usage registers its usage and Fast commands with lifecycle hooks", () => {
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });

	assert.ok(mock.commands.has("usage"));
	assert.ok(mock.commands.has("fast"));
	assert.equal(mock.commands.has("codex-status"), false);
	assert.equal(mock.commands.get("usage")?.getArgumentCompletions, undefined);
	assert.equal(mock.commands.get("fast")?.getArgumentCompletions, undefined);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"before_provider_request",
		"message_end",
		"model_select",
		"session_shutdown",
		"session_start",
		"session_tree",
		"turn_start",
	]);
});

test("/usage automatically queries the current runtime account and shows state plus next actions", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;

	const selections: Array<{ title: string; options: string[] }> = [];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string, options: string[]) => {
			selections.push({ title, options });
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: (provider: string) => ({ configured: provider === "openrouter" }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.equal(selections.length, 1);
	assert.match(selections[0]?.title ?? "", /OpenRouter Usage · Current/);
	assert.match(selections[0]?.title ?? "", /test-key/);
	assert.deepEqual(selections[0]?.options, [
		"Refresh current usage",
		"Settings",
		"View another configured provider…",
		"View all configured providers…",
		"Close",
	]);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("current Codex usage can redeem a selected reset and refresh account state", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let usageRequests = 0;
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		if (url.endsWith("/wham/rate-limit-reset-credits/consume")) {
			return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
		}
		if (url.endsWith("/wham/rate-limit-reset-credits")) {
			return new Response(
				JSON.stringify({
					credits: [
						{
							id: "credit-123",
							reset_type: "codex_rate_limits",
							status: "available",
							granted_at: "2026-06-17T00:00:00Z",
							expires_at: "2026-09-17T00:00:00Z",
							title: "Weekly + 5h reset",
							description: "Reset both current windows.",
						},
					],
					available_count: 1,
				}),
				{ status: 200 },
			);
		}
		usageRequests += 1;
		return new Response(
			JSON.stringify({
				plan_type: "pro",
				rate_limit: {
					primary_window: {
						used_percent: usageRequests === 1 ? 80 : 0,
						limit_window_seconds: 18_000,
					},
				},
				rate_limit_reset_credits: { available_count: usageRequests === 1 ? 1 : 0 },
			}),
			{ status: 200 },
		);
	};

	const choices = ["Redeem usage limit reset…", "Weekly + 5h reset", "Yes, use reset", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
		const request = data as {
			provider: string;
			offer(candidate: unknown): void;
		};
		if (request.provider !== "openai-codex") return;
		request.offer({
			type: "oauth",
			access: codexToken,
			refresh: "named-refresh-token",
			expires: Date.now() + 60_000,
			accountId: "account-123",
		});
	});
	usageExtension(mock.pi, {
		settingsRuntime: memorySettingsRuntime().runtime,
		credentialReader: () => ({
			type: "oauth",
			access: "default-codex-token",
			refresh: "default-refresh-token",
			expires: Date.now() + 60_000,
			accountId: "default-account",
		}),
		createRedemptionId: () => "redeem-123",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string, options: string[]) => {
			titles.push(title);
			const choice = choices.shift();
			assert.ok(choice === undefined || options.includes(choice), `${choice} not in ${options}`);
			return choice;
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: codexToken }),
			getProviderAuth: async () => ({ auth: { apiKey: codexToken } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	const consume = requests.find((request) => request.url.endsWith("/consume"));
	assert.ok(consume);
	assert.deepEqual(JSON.parse(String(consume.init?.body)), {
		redeem_request_id: "redeem-123",
		credit_id: "credit-123",
	});
	assert.equal(new Headers(consume.init?.headers).get("chatgpt-account-id"), "account-123");
	assert.ok(usageRequests >= 2);
	assert.equal(statuses.get("usage"), "codex 100% 5h");
	assert.match(titles.at(-1) ?? "", /Usage reset.*0 usage limit resets left/isu);
});

test("Codex reset confirmation defaults to cancellation and sends no mutation", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let postRequests = 0;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (init?.method === "POST") postRequests += 1;
		if (url.endsWith("/wham/rate-limit-reset-credits")) {
			return new Response(JSON.stringify({ available_count: 1 }), { status: 200 });
		}
		return new Response(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 80, limit_window_seconds: 18_000 } },
				rate_limit_reset_credits: { available_count: 1 },
			}),
			{ status: 200 },
		);
	};
	const choices: Array<string | undefined> = [
		"Redeem usage limit reset…",
		"Full reset",
		"No, go back",
		undefined,
		"Close",
	];
	const confirmationOptions: string[][] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: memorySettingsRuntime().runtime,
		credentialReader: () => ({
			type: "oauth",
			access: codexToken,
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			accountId: "account-123",
		}),
		createRedemptionId: () => "must-not-be-used",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string, options: string[]) => {
			if (title.includes("Use this reset?")) confirmationOptions.push(options);
			return choices.shift();
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: codexToken }),
			getProviderAuth: async () => ({ auth: { apiKey: codexToken } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.deepEqual(confirmationOptions[0], ["No, go back", "Yes, use reset"]);
	assert.equal(postRequests, 0);
});

test("command arguments are rejected instead of becoming a hidden interface", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	let selected = false;
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => {
			selected = true;
			return "Close";
		},
	});

	await command.handler("--all", ctx);

	assert.equal(selected, false);
	assert.match(notifications[0]?.message ?? "", /does not accept arguments/);
});

test("explicit all-provider query labels current/configured and retains Kimi plus failures", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/api/v1/key") || String(input).endsWith("/coding/v1/usages")) {
			return usageFetch(input);
		}
		return new Response("backend unavailable", { status: 503, statusText: "Unavailable" });
	};

	const titles: string[] = [];
	const choices = ["View all configured providers…", "Close"];
	const configured = new Set(["openrouter", "openai-codex", "kimi-coding"]);
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({
				auth: {
					apiKey: `${provider}-key`,
					...(provider === "kimi-coding" ? { baseUrl: kimiModel.baseUrl } : {}),
				},
			}),
			getAvailable: () => [openRouterModel, codexModel, kimiModel],
			getAll: () => [openRouterModel, codexModel, kimiModel],
			getProviderAuthStatus: (provider: string) => ({
				configured: configured.has(provider),
				source: "stored",
			}),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.equal(titles.length, 2);
	assert.match(titles[1] ?? "", /OpenRouter Usage · Current/);
	assert.match(titles[1] ?? "", /OpenAI Codex · Configured/);
	assert.match(titles[1] ?? "", /Kimi For Coding Usage · Configured/);
	assert.match(titles[1] ?? "", /1 of 100 used · 99% left/);
	assert.match(titles[1] ?? "", /query failed/i);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("another-provider queries show only the selected provider and preserve current status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const choices = ["View another configured provider…", "OpenAI Codex", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.match(titles.at(-1) ?? "", /OpenAI Codex Usage · Configured/);
	assert.doesNotMatch(titles.at(-1) ?? "", /OpenRouter Usage · Current/);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("unsupported providers remain visible without publishing an error status", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const unsupportedModel = {
		id: "claude",
		name: "Claude",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
	};
	let title = "";
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: unsupportedModel,
		select: async (value: string) => {
			title = value;
			return "Close";
		},
		modelRegistry: {
			getProviderDisplayName: () => "Anthropic",
			getAvailable: () => [],
			getAll: () => [],
		},
	});

	await command.handler("", ctx);

	assert.match(title, /Unsupported/);
	assert.equal(statuses.get("usage"), undefined);
});

test("current auth appearance during a command is revalidated before display", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	let authCalls = 0;
	let title = "";
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (value: string) => {
			title = value;
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => {
				authCalls += 1;
				return authCalls === 1 ? undefined : { auth: { apiKey: "openrouter-key" } };
			},
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.match(title, /OpenRouter Usage · Current/);
	assert.match(title, /test-key/);
	assert.ok(authCalls >= 3);
});

test("automatic lifecycle refresh starts asynchronously", () => {
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const never = new Promise<never>(() => undefined);
	const { ctx } = createMockContext({
		model: openRouterModel,
		modelRegistry: {
			getProviderAuth: () => never,
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
		},
	});

	const result = mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.equal(result, undefined);
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("TUI usage queries complete through the loader before opening the menu", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	let customCalls = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		model: openRouterModel,
		custom: async (factory: unknown) =>
			new Promise<unknown>((resolve) => {
				if (typeof factory !== "function") return resolve(undefined);
				customCalls += 1;
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: unknown) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: { fg(_color: string, text: string): string },
						keybindings: object,
						done: (value: unknown) => void,
					) => typeof component
				)({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
				if (customCalls === 2) setImmediate(() => component.handleInput("\u0003"));
			}),
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.equal(customCalls, 2);
});

test("a loader UI failure propagates once without an extra task notification", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		model: openRouterModel,
		custom: async () => {
			throw new Error("loader UI failed");
		},
	});

	await assert.rejects(Promise.resolve(command.handler("", ctx)), /loader UI failed/u);
	assert.deepEqual(notifications, []);
});

test("TUI usage queries can be cancelled with Escape", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	let customCalls = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		model: openRouterModel,
		custom: async (factory: unknown) =>
			new Promise<unknown>((resolve) => {
				if (typeof factory !== "function") return resolve(undefined);
				customCalls += 1;
				let component: { dispose?(): void; handleInput(data: string): void };
				const done = (value: unknown) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: { fg(_color: string, text: string): string },
						keybindings: object,
						done: (value: unknown) => void,
					) => { dispose?(): void; handleInput(data: string): void }
				)({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
				setImmediate(() => component.handleInput("\u001b"));
			}),
		modelRegistry: {
			getProviderAuth: () => new Promise<never>(() => undefined),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
		},
	});

	await command.handler("", ctx);
	assert.equal(customCalls, 1);
});

test("session shutdown aborts usage action and provider selectors", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;

	const dialogSignals: AbortSignal[] = [];
	let providerSelectorStarted: () => void = () => undefined;
	const providerSelectorReady = new Promise<void>((resolve) => {
		providerSelectorStarted = resolve;
	});
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (
			title: string,
			_options: string[],
			opts?: { signal?: AbortSignal },
		): Promise<string | undefined> => {
			assert.ok(opts?.signal);
			dialogSignals.push(opts.signal);
			if (!title.includes("Select a configured provider")) {
				return "View another configured provider…";
			}
			providerSelectorStarted();
			return new Promise((resolve) => {
				if (opts.signal?.aborted) resolve(undefined);
				else opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	const pending = command.handler("", ctx);
	await providerSelectorReady;
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	await pending;

	assert.equal(dialogSignals.length, 2);
	assert.equal(dialogSignals[0], dialogSignals[1]);
	assert.equal(dialogSignals[0]?.aborted, true);
});

test("current Kimi usage follows account changes and clears status on model replacement", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "kimi-account-a";
	const fetchedKeys: string[] = [];
	globalThis.fetch = async (_input, init) => {
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		fetchedKeys.push(authorization);
		const used = activeKey === "kimi-account-a" ? "1" : "25";
		return new Response(
			JSON.stringify({
				usage: { used: "40", limit: "1000" },
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { used, limit: "100" },
					},
				],
			}),
			{ status: 200 },
		);
	};
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const titles: string[] = [];
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: kimiModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: activeKey, baseUrl: kimiModel.baseUrl },
			}),
			getAvailable: () => [kimiModel],
			getAll: () => [kimiModel],
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "kimi 99% 5h 96% wk");
	await command.handler("", ctx);
	assert.match(titles[0] ?? "", /Kimi For Coding Usage · Current/);
	assert.match(titles[0] ?? "", /1 of 100 used · 99% left/);

	activeKey = "kimi-account-b";
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "kimi 75% 5h 96% wk");
	assert.ok(fetchedKeys.includes("Bearer kimi-account-a"));
	assert.ok(fetchedKeys.includes("Bearer kimi-account-b"));

	mock.events.get("model_select")?.[0]?.(
		{
			model: {
				id: "other",
				name: "Other",
				provider: "unsupported",
				baseUrl: "https://example.test",
			},
		},
		ctx,
	);
	assert.equal(statuses.get("usage"), undefined);
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("Z.AI providers publish statusline usage and refresh through /usage", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response(
			JSON.stringify({
				data: {
					limits: [
						{ type: "CREDIT_LIMIT", unit: 3, percentage: 10 },
						{ type: "CREDIT_LIMIT", unit: 6, usage: 100, currentValue: 20 },
					],
					level: "lite",
				},
			}),
			{ status: 200 },
		);
	};
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: zaiModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "zai-key" } }),
			getAvailable: () => [zaiModel],
			getAll: () => [zaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "Z.AI",
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 1);
	assert.equal(statuses.get("usage"), "zai 90% 5h 80% wk");

	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 1);
	assert.equal(statuses.get("usage"), "zai 90% 5h 80% wk");

	await command.handler("", ctx);
	assert.equal(fetches, 1);
	assert.match(titles[0] ?? "", /5h window:\s+10% used · 90% left/);
	assert.equal(statuses.get("usage"), "zai 90% 5h 80% wk");
});

test("New API stays out of the footer statusline while /usage still queries it", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	const seenAuthorizations: string[] = [];
	const seenUserHeaders: string[] = [];
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		fetches += 1;
		const url = String(input);
		const headers = init?.headers as Record<string, string> | undefined;
		const authorization = headers?.["Authorization"];
		if (authorization) seenAuthorizations.push(authorization);
		const userHeader = headers?.["New-Api-User"];
		if (userHeader) seenUserHeaders.push(userHeader);
		const payload = url.includes("/api/user/self")
			? {
					success: true,
					message: "",
					data: {
						username: "alice",
						display_name: "Alice",
						quota: 1_612_600,
						used_quota: 3_387_400,
						request_count: 1_234,
					},
				}
			: {
					success: true,
					message: "",
					data: [{ model_name: "gpt-4o", count: 120, quota: 500_000, token_used: 90_000 }],
				};
		return new Response(JSON.stringify(payload), { status: 200 });
	};
	const titles: string[] = [];
	const settingsRuntime = memorySettingsRuntime(
		true,
		false,
		"loaded",
		"sys-access-token-0123456789abcdef",
		42,
	).runtime;
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: newApiModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: "sk-inference-key", baseUrl: "https://gateway.example.com/v1" },
			}),
			getAvailable: () => [newApiModel],
			getAll: () => [newApiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "New API",
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 0);
	assert.equal(statuses.get("usage"), undefined);

	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 0);
	assert.equal(statuses.get("usage"), undefined);

	await command.handler("", ctx);
	assert.equal(fetches, 2);
	assert.deepEqual(seenAuthorizations, [
		"Bearer sys-access-token-0123456789abcdef",
		"Bearer sys-access-token-0123456789abcdef",
	]);
	assert.deepEqual(seenUserHeaders, ["42", "42"]);
	assert.equal(statuses.get("usage"), undefined);
	assert.match(titles[0] ?? "", /New API Usage · Current/);
	assert.match(titles[0] ?? "", /Account quota:\s+\$3\.23 left of \$10\.00 \(32%\)/);
});

test("footer statusline stays empty when usageStatusline is off and /usage still works", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	globalThis.fetch = async (input: string | URL | Request) => {
		fetches += 1;
		const url = String(input);
		const payload = url.includes("/api/user/self")
			? {
					success: true,
					message: "",
					data: {
						username: "alice",
						quota: 1_612_600,
						used_quota: 3_387_400,
						request_count: 1_234,
					},
				}
			: { success: true, message: "", data: [] };
		return new Response(JSON.stringify(payload), { status: 200 });
	};
	const titles: string[] = [];
	const settingsRuntime = memorySettingsRuntime(
		true,
		false,
		"loaded",
		"sys-access-token-0123456789abcdef",
		42,
		false,
	).runtime;
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: newApiModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: "sk-inference-key", baseUrl: "https://gateway.example.com/v1" },
			}),
			getAvailable: () => [newApiModel],
			getAll: () => [newApiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "New API",
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 0);
	assert.equal(statuses.get("usage"), undefined);

	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 0);
	assert.equal(statuses.get("usage"), undefined);

	await command.handler("", ctx);
	assert.equal(fetches, 2);
	assert.equal(statuses.get("usage"), undefined);
	assert.match(titles[0] ?? "", /New API Usage · Current/);
	assert.match(titles[0] ?? "", /Account quota:/);
});

test("automatic provider failures back off instead of retrying every turn", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response("unavailable", { status: 503, statusText: "Unavailable" });
	};
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const { ctx } = createMockContext({
		model: openRouterModel,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 1);
});

test("a current command supersedes an older automatic query for the same provider", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "account-a";
	let fetches = 0;
	let resolveOldFetch: (response: Response) => void = () => undefined;
	const oldFetch = new Promise<Response>((resolve) => {
		resolveOldFetch = resolve;
	});
	const response = (label: string, remaining: number) =>
		new Response(
			JSON.stringify({
				data: {
					label,
					limit: 100,
					limit_remaining: remaining,
					usage: 100 - remaining,
				},
			}),
			{ status: 200 },
		);
	globalThis.fetch = async () => {
		fetches += 1;
		return fetches === 1 ? oldFetch : response("account-b", 40);
	};
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => "Close",
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	while (fetches < 1) await settle();
	activeKey = "account-b";
	await command.handler("", ctx);
	assert.equal(statuses.get("usage"), "openrouter $40.00 left");

	resolveOldFetch(response("account-a", 75));
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $40.00 left");
});

test("cross-provider results revalidate which account is Current before display", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let codexFetches = 0;
	let resolveCodex: (response: Response) => void = () => undefined;
	const codexResponse = new Promise<Response>((resolve) => {
		resolveCodex = resolve;
	});
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/api/v1/key")) return usageFetch(input);
		codexFetches += 1;
		return codexFetches === 1 ? codexResponse : usageFetch(input);
	};
	const choices = ["View another configured provider…", "OpenAI Codex", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	const pending = command.handler("", ctx);
	while (codexFetches < 1) await settle();
	Object.assign(ctx, { model: codexModel });
	resolveCodex(await usageFetch("https://chatgpt.com/backend-api/wham/usage"));
	await pending;

	assert.match(titles.at(-1) ?? "", /OpenAI Codex Usage · Current/);
	assert.doesNotMatch(titles.at(-1) ?? "", /OpenRouter Usage · Current/);
});

test("session shutdown clears status through the shutdown context", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const statuses = new Map<string, string | undefined>();
	const ui = {
		notify() {},
		setStatus(key: string, value: string | undefined) {
			statuses.set(key, value);
		},
	};
	const registry = {
		getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
		getAvailable: () => [openRouterModel],
		getAll: () => [openRouterModel],
	};
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const { ctx: startContext } = createMockContext({
		model: openRouterModel,
		ui,
		modelRegistry: registry,
	});
	const { ctx: shutdownContext } = createMockContext({
		model: openRouterModel,
		ui,
		modelRegistry: registry,
	});

	mock.events.get("session_start")?.[0]?.({}, startContext);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
	mock.events.get("session_shutdown")?.[0]?.({}, shutdownContext);
	assert.equal(statuses.get("usage"), undefined);
});

test("a slow command cannot overwrite status after the selected model changes", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let openRouterFetches = 0;
	let resolveSlowFetch: (response: Response) => void = () => undefined;
	const slowFetch = new Promise<Response>((resolve) => {
		resolveSlowFetch = resolve;
	});
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/api/v1/key")) {
			openRouterFetches += 1;
			if (openRouterFetches === 1) return usageFetch(input);
			return slowFetch;
		}
		return usageFetch(input);
	};

	const choices = ["Refresh current usage", "Close"];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => choices.shift(),
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	const commandPromise = command.handler("", ctx);
	while (openRouterFetches < 2) await settle();
	Object.assign(ctx, { model: codexModel });
	mock.events.get("model_select")?.[0]?.({ model: codexModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "codex 80% 5h");

	resolveSlowFetch(await usageFetch("https://openrouter.ai/api/v1/key"));
	await commandPromise;
	assert.equal(statuses.get("usage"), "codex 80% 5h");
});

test("statusline follows runtime auth changes and clears for unsupported selected providers", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "account-a";
	let accountAQueries = 0;
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		if (activeKey === "account-a") accountAQueries += 1;
		const remaining =
			activeKey === "account-a"
				? accountAQueries === 1
					? 75
					: accountAQueries === 2
						? 20
						: accountAQueries === 3
							? 10
							: 5
				: 40;
		return new Response(
			JSON.stringify({
				data: {
					label: activeKey,
					limit: 100,
					limit_remaining: remaining,
					limit_reset: "monthly",
					usage: 100 - remaining,
					usage_daily: 1,
					usage_weekly: 5,
					usage_monthly: 25,
				},
			}),
			{ status: 200 },
		);
	};

	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const { ctx, statuses } = createMockContext({
		model: openRouterModel,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");

	activeKey = "account-b";
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $40.00 left");

	activeKey = "account-a";
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $20.00 left");
	assert.equal(fetches, 3);

	mock.events.get("model_select")?.[0]?.(
		{
			model: {
				id: "x",
				name: "X",
				provider: "unsupported",
				baseUrl: "https://example.test",
			},
		},
		ctx,
	);
	assert.equal(statuses.get("usage"), undefined);

	mock.events.get("model_select")?.[0]?.({ model: openRouterModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $10.00 left");
	assert.equal(fetches, 4);

	const proxyModel = { ...openRouterModel, baseUrl: "https://proxy.example.test/v1" };
	Object.assign(ctx, { model: proxyModel });
	mock.events.get("model_select")?.[0]?.({ model: proxyModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "auth unavailable");

	Object.assign(ctx, { model: openRouterModel });
	mock.events.get("model_select")?.[0]?.({ model: openRouterModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $5.00 left");
	assert.equal(fetches, 5);
});

test("disabled xAI reports its state with zero auth and network requests", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	let authCalls = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		throw new Error("must not fetch");
	};
	const settings = memorySettingsRuntime(false);
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	let title = "";
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async (value: string) => {
			title = value;
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => {
				authCalls += 1;
				return { ok: true, apiKey: "xai-access" };
			},
			getProviderAuth: async () => {
				authCalls += 1;
				return { auth: { apiKey: "xai-access" } };
			},
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderDisplayName: () => "xAI",
		},
	});

	await command.handler("", ctx);

	assert.match(title, /xAI usage is disabled/);
	assert.equal(authCalls, 0);
	assert.equal(fetches, 0);
	assert.equal(statuses.get("usage"), undefined);
});

test("invalid settings keep xAI disabled without resolving auth or fetching", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	let authCalls = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		throw new Error("must not fetch");
	};
	const settings = memorySettingsRuntime(true, false, "invalid");
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async () => "Close",
		modelRegistry: {
			getProviderAuth: async () => {
				authCalls += 1;
				return { auth: { apiKey: "xai-access" } };
			},
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderDisplayName: () => "xAI",
		},
	});

	await command.handler("", ctx);

	assert.equal(authCalls, 0);
	assert.equal(fetches, 0);
});

test("enabled xAI queries only through explicit usage and never publishes status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		requests.push(String(input));
		return requests.length === 1
			? new Response(JSON.stringify({ userId: "fixture-user", subscriptionTier: "SuperGrok" }), {
					status: 200,
				})
			: new Response(
					JSON.stringify({
						config: {
							creditUsagePercent: 25,
							currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
						},
					}),
					{ status: 200 },
				);
	};
	const settings = memorySettingsRuntime(true);
	const credential = {
		type: "oauth",
		access: "xai-access",
		refresh: "xai-refresh",
		expires: Date.now() + 60_000,
	};
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: () => credential,
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	let title = "";
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async (value: string) => {
			title = value;
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-access" }),
			getProviderAuth: async () => ({ auth: { apiKey: "xai-access" } }),
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "xAI",
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(requests.length, 0);
	await command.handler("", ctx);

	assert.deepEqual(requests, [
		"https://cli-chat-proxy.grok.com/v1/user?include=subscription",
		"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	]);
	assert.match(title, /Included allowance:\s+25% used · 75% left · Weekly/);
	assert.match(title, /Plan tier:\s+SuperGrok/);
	assert.equal(statuses.get("usage"), undefined);
});

test("xAI opt-out after identity prevents billing and stale publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const settings = memorySettingsRuntime(true);
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		await settings.runtime.update({ xaiUsage: false });
		return new Response(JSON.stringify({ userId: "fixture-user" }), { status: 200 });
	};
	const credential = {
		type: "oauth",
		access: "xai-access",
		refresh: "xai-refresh",
		expires: Date.now() + 60_000,
	};
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: () => credential,
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	let menus = 0;
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async () => {
			menus += 1;
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-access" }),
			getProviderAuth: async () => ({ auth: { apiKey: "xai-access" } }),
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "xAI",
		},
	});

	await command.handler("", ctx);

	assert.equal(fetches, 1);
	assert.equal(menus, 0);
	assert.equal(statuses.get("usage"), undefined);
});

test("xAI account changes after identity prevent billing and stale publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let activeAccess = "xai-access-a";
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		activeAccess = "xai-access-b";
		return new Response(JSON.stringify({ userId: "fixture-user" }), { status: 200 });
	};
	const settings = memorySettingsRuntime(true);
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: () => ({
			type: "oauth",
			access: activeAccess,
			refresh: `refresh-${activeAccess}`,
			expires: Date.now() + 60_000,
		}),
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	let menus = 0;
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async () => {
			menus += 1;
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: activeAccess }),
			getProviderAuth: async () => ({ auth: { apiKey: activeAccess } }),
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "xAI",
		},
	});

	await command.handler("", ctx);

	assert.equal(fetches, 1);
	assert.equal(menus, 0);
	assert.equal(statuses.get("usage"), undefined);
});

test("xAI account changes after the final adapter guard prevent configured publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let activeAccess = "xai-access-a";
	let credentialReads = 0;
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.endsWith("/api/v1/key")) return usageFetch(input);
		if (url.includes("/user?")) {
			return new Response(JSON.stringify({ userId: "fixture-user" }), { status: 200 });
		}
		return new Response(JSON.stringify({ config: { creditUsagePercent: 10 } }), {
			status: 200,
		});
	};
	const settings = memorySettingsRuntime(true);
	const choices = ["View another configured provider…", "xAI"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: (provider) => {
			if (provider !== "xai") return undefined;
			credentialReads += 1;
			const access = activeAccess;
			if (credentialReads === 5) {
				queueMicrotask(() => {
					activeAccess = "xai-access-b";
				});
			}
			return {
				type: "oauth",
				access,
				refresh: `refresh-${access}`,
				expires: Date.now() + 60_000,
			};
		},
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({
				auth: { apiKey: provider === "xai" ? activeAccess : "openrouter-key" },
			}),
			getAvailable: () => [openRouterModel, xaiModel],
			getAll: () => [openRouterModel, xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.equal(credentialReads, 6);
	assert.equal(requests.filter((url) => url.includes("cli-chat-proxy")).length, 2);
	assert.equal(
		titles.some((title) => /xAI Usage · Configured/u.test(title)),
		false,
	);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("enabled xAI appears as a configured provider without changing current status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.endsWith("/api/v1/key")) return usageFetch(input);
		if (url.includes("/user?")) {
			return new Response(JSON.stringify({ userId: "fixture-user" }), { status: 200 });
		}
		return new Response(JSON.stringify({ config: { creditUsagePercent: 10 } }), {
			status: 200,
		});
	};
	const settings = memorySettingsRuntime(true);
	const choices = ["View another configured provider…", "xAI", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: (provider) =>
			provider === "xai"
				? {
						type: "oauth",
						access: "xai-access",
						refresh: "xai-refresh",
						expires: Date.now() + 60_000,
					}
				: undefined,
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({
				auth: { apiKey: provider === "xai" ? "xai-access" : "openrouter-key" },
			}),
			getAvailable: () => [openRouterModel, xaiModel],
			getAll: () => [openRouterModel, xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.match(titles.at(-1) ?? "", /xAI Usage · Configured/);
	assert.match(titles.at(-1) ?? "", /Included allowance:\s+10% used · 90% left/);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
	assert.equal(requests.filter((url) => url.includes("cli-chat-proxy")).length, 2);
});

test("the Settings menu action gives RPC mode the active manual settings path", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const settings = memorySettingsRuntime();
	const choices = ["Settings", "Close"];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => choices.shift(),
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.match(notifications[0]?.message ?? "", /Edit settings manually: \/tmp\/pi-usage\.json/);
});

test("the TUI SettingsList describes and applies xAI changes immediately", async (t) => {
	const settings = memorySettingsRuntime(false);
	const rendered: string[][] = [];
	let applied = 0;
	const controller = new AbortController();
	const previousKeybindings = getKeybindings();
	const remappedKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.down": "j",
		"tui.select.confirm": "x",
		"tui.select.cancel": "q",
	});
	setKeybindings(remappedKeybindings);
	t.after(() => setKeybindings(previousKeybindings));
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender: () => rendered.push(component.render(100)) },
					{ bold: (text) => text, fg: (_color, text) => text },
					remappedKeybindings,
					done,
				);
				rendered.push(component.render(100));
				component.handleInput("j");
				component.handleInput("x");
				setImmediate(() => component.handleInput("q"));
			}),
	});

	const changed = await showUsageSettings(
		ctx,
		settings.runtime,
		controller.signal,
		() => true,
		(id) => {
			if (id === "xaiUsage") applied += 1;
		},
	);

	assert.equal(changed, true);
	assert.equal(settings.state().settings.xaiUsage, true);
	assert.equal(applied, 1);
	const renderedSettings = rendered.map((lines) => lines.join("\n"));
	assert.ok(
		renderedSettings.some((frame) => /OAuth subscription allowance and credits/.test(frame)),
	);
	assert.doesNotMatch(renderedSettings.join("\n"), /warning|undocumented|experimental/iu);
});

test("Ctrl+C hard-cancels Settings before conflicting configurable actions", async (t) => {
	const settings = memorySettingsRuntime(false);
	let applied = 0;
	const previousKeybindings = getKeybindings();
	const conflictingKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.confirm": "ctrl+c",
		"tui.select.cancel": "q",
	});
	setKeybindings(conflictingKeybindings);
	t.after(() => setKeybindings(previousKeybindings));
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender() {} },
					{ bold: (text) => text, fg: (_color, text) => text },
					conflictingKeybindings,
					done,
				);
				component.handleInput("\u0003");
				component.handleInput("q");
			}),
	});

	const changed = await showUsageSettings(
		ctx,
		settings.runtime,
		new AbortController().signal,
		() => true,
		() => {
			applied += 1;
		},
	);

	assert.equal(changed, false);
	assert.deepEqual(settings.state().settings, {
		codexFastMode: false,
		xaiUsage: false,
		usageStatusline: true,
	});
	assert.equal(applied, 0);
});

test("settings cancellation aborts a stalled save and closes without awaiting it", async (t) => {
	const previousKeybindings = getKeybindings();
	const remappedKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.cancel": "q",
	});
	setKeybindings(remappedKeybindings);
	t.after(() => setKeybindings(previousKeybindings));

	for (const cancellation of ["ctrl+c", "configured cancel", "parent abort"] as const) {
		const settings = memorySettingsRuntime(false);
		let markStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let markAborted: () => void = () => undefined;
		const aborted = new Promise<void>((resolve) => {
			markAborted = resolve;
		});
		settings.runtime.update = async (_patch, signal) => {
			markStarted();
			if (signal?.aborted) markAborted();
			else signal?.addEventListener("abort", markAborted, { once: true });
			return new Promise<UsageSettingsState>(() => undefined);
		};
		const parentController = new AbortController();
		let markReady: (component: {
			handleInput(data: string): void;
			render(width: number): string[];
		}) => void = () => undefined;
		const ready = new Promise<{
			handleInput(data: string): void;
			render(width: number): string[];
		}>((resolve) => {
			markReady = resolve;
		});
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) =>
				new Promise<boolean>((resolve) => {
					let component: {
						dispose?(): void;
						handleInput(data: string): void;
						render(width: number): string[];
					};
					const done = (value: boolean) => {
						component.dispose?.();
						resolve(value);
					};
					component = (
						factory as (
							tui: { requestRender(): void },
							theme: {
								bold(text: string): string;
								fg(_color: string, text: string): string;
							},
							keybindings: object,
							done: (value: boolean) => void,
						) => typeof component
					)(
						{ requestRender() {} },
						{ bold: (text) => text, fg: (_color, text) => text },
						remappedKeybindings,
						done,
					);
					markReady(component);
				}),
		});

		const pending = showUsageSettings(
			ctx,
			settings.runtime,
			parentController.signal,
			() => true,
			() => assert.fail("an aborted save must not apply"),
		);
		const component = await ready;
		component.handleInput("\u001b[B");
		component.handleInput("\r");
		await started;
		if (cancellation === "ctrl+c") component.handleInput("\u0003");
		else if (cancellation === "configured cancel") component.handleInput("q");
		else parentController.abort();

		assert.equal(await pending, false, cancellation);
		await aborted;
		assert.equal(settings.state().settings.xaiUsage, false, cancellation);
	}
});

test("a durable settings save still applies lifecycle cleanup when disposal wins the await", async () => {
	const settings = memorySettingsRuntime(false);
	const controller = new AbortController();
	const update = settings.runtime.update;
	settings.runtime.update = async (patch, signal) => {
		const state = await update(patch, signal);
		controller.abort();
		return state;
	};
	let applied = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender() {} },
					{ bold: (text) => text, fg: (_color, text) => text },
					{ matches: () => false },
					done,
				);
				component.handleInput("\u001b[B");
				component.handleInput("\r");
			}),
	});

	await showUsageSettings(
		ctx,
		settings.runtime,
		controller.signal,
		() => true,
		(id) => {
			if (id === "xaiUsage") applied += 1;
		},
	);

	assert.equal(settings.state().settings.xaiUsage, true);
	assert.equal(applied, 1);
});

test("the TUI SettingsList rolls back its displayed and effective value after save failure", async () => {
	const settings = memorySettingsRuntime(false, true);
	let latest: string[] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					latest = component.render(100);
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender: () => (latest = component.render(100)) },
					{ bold: (text) => text, fg: (_color, text) => text },
					{ matches: () => false },
					done,
				);
				component.handleInput("\u001b[B");
				component.handleInput("\r");
				setImmediate(() => component.handleInput("\u0003"));
			}),
	});

	const changed = await showUsageSettings(
		ctx,
		settings.runtime,
		new AbortController().signal,
		() => true,
		() => assert.fail("failed writes must not apply"),
	);

	assert.equal(changed, false);
	assert.equal(settings.state().settings.xaiUsage, false);
	assert.match(notifications[0]?.message ?? "", /disk full/);
	assert.match(latest.join("\n"), /xAI usage.*Off/su);
});

test("shutdown cancels an explicit xAI identity body before billing or status publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	let identityStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		identityStarted = resolve;
	});
	globalThis.fetch = async () => {
		fetches += 1;
		identityStarted();
		return new Response(new ReadableStream({ start() {} }), { status: 200 });
	};
	const settings = memorySettingsRuntime(true);
	const credential = {
		type: "oauth",
		access: "xai-access",
		refresh: "xai-refresh",
		expires: Date.now() + 60_000,
	};
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: () => credential,
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async () => "Close",
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-access" }),
			getProviderAuth: async () => ({ auth: { apiKey: "xai-access" } }),
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "xAI",
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	const pending = command.handler("", ctx);
	await started;
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	await pending;

	assert.equal(fetches, 1);
	assert.equal(statuses.get("usage"), undefined);
});





test("a settings-driven token change forces new-api usage re-authentication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const seenAuthorizations: string[] = [];
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = init?.headers as Record<string, string> | undefined;
		const authorization = headers?.["Authorization"];
		if (url.includes("/api/") && authorization) seenAuthorizations.push(authorization);
		const payload = url.includes("/api/user/self")
			? {
					success: true,
					message: "",
					data: {
						username: "alice",
						quota: 1_612_600,
						used_quota: 3_387_400,
						request_count: 1_234,
					},
				}
			: { success: true, message: "", data: [] };
		return new Response(JSON.stringify(payload), { status: 200 });
	};
	const titles: string[] = [];
	const { runtime: settingsRuntime } = memorySettingsRuntime(
		true,
		false,
		"loaded",
		"first-system-token",
		42,
	);
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const registry = {
		getProviderAuth: async () => ({
			auth: { apiKey: "sk-inference-key", baseUrl: "https://gateway.example.com/v1" },
		}),
		getAvailable: () => [newApiModel],
		getAll: () => [newApiModel],
		getProviderAuthStatus: () => ({ configured: true }),
		getProviderDisplayName: () => "New API",
	};
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: newApiModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: registry,
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();

	// The first query caches the report under the first token.
	await command.handler("", ctx);
	assert.deepEqual(seenAuthorizations, [
		"Bearer first-system-token",
		"Bearer first-system-token",
	]);

	// Saving a replacement token through the Settings screen must invalidate
	// the cached report. Simulate exactly what the wired onApplied callback
	// does by driving the real cache path: open /usage again with a cleared
	// cache after the same runtime update the UI performs.
	settingsRuntime.update({ newApiSystemToken: "second-system-token" }).catch(() => undefined);
	await settle();

	// Without invalidation the cached report would suppress these requests.
	await command.handler("", ctx);
	assert.ok(seenAuthorizations.length > 2, JSON.stringify(seenAuthorizations));
	assert.ok(
		seenAuthorizations.slice(2).every((auth) => auth === "Bearer second-system-token"),
		JSON.stringify(seenAuthorizations),
	);
});
