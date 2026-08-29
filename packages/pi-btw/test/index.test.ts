import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import btw, { type ResolveModelFn } from "../index.ts";
import type { BtwSettings } from "../settings.ts";
import type { BtwThreadState } from "../session.ts";
import type { CompleteSideThreadTurnResult } from "../side-thread.ts";
import { fakeAssistantMessage } from "./helpers.ts";

const SIDE_MODEL = { provider: "anthropic", id: "claude", reasoning: {} } as never;
const SELECTED = { kind: "selected", selected: { model: SIDE_MODEL, auth: {} } } as const;

type CapturedSession = {
	initialQuestion?: string;
	settings: BtwSettings;
	settingsPath: string;
	currentMainThinkingLevel: string;
	initialThinkingLevel: string;
	modelThinkingLevels: readonly string[];
	createThreadState(): BtwThreadState;
	completeTurn(
		thread: BtwThreadState["thread"],
		question: string,
		level: string,
		signal: AbortSignal,
	): Promise<CompleteSideThreadTurnResult>;
	getResumeThread(id: string): BtwThreadState | undefined;
	resumeThreads: ReadonlyArray<{ id: string; title: string; questionCount: number }>;
};

function createHarness(options: {
	settings?: BtwSettings;
	modelResolution?: Awaited<ReturnType<ResolveModelFn>>;
	sessionResult?: { result: { kind: "closed" }; threadState?: BtwThreadState };
	sessionResultFactory?: (
		callIndex: number,
		sessionOptions: CapturedSession,
	) => { result: { kind: "closed" }; threadState?: BtwThreadState };
	mode?: string;
	resolveModel?: ResolveModelFn;
	loadSettings?: (ctx: ExtensionCommandContext) => Promise<BtwSettings>;
}) {
	const notifications: Array<{ message: string; level: string }> = [];
	let captured: CapturedSession | undefined;
	let sessionCallIndex = 0;
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	const pi = {
		registerCommand: (
			name: string,
			definition: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) => {
			commands.set(name, definition);
		},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
	const provider = {
		streamSimple: () => ({
			result: async () => fakeAssistantMessage("side answer"),
		}),
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		model: { provider: "anthropic", id: "claude-current" },
		modelRegistry: {
			getProvider: () => provider,
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		},
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
			],
		},
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionCommandContext;

	btw(pi, {
		resolveModel:
			options.resolveModel ??
			(async () => options.modelResolution ?? { kind: "unavailable" }),
		runSession: async (sessionOptions) => {
			captured = {
				initialQuestion: sessionOptions.initialQuestion,
				settings: sessionOptions.settings,
				settingsPath: sessionOptions.settingsPath,
				currentMainThinkingLevel: sessionOptions.currentMainThinkingLevel,
				initialThinkingLevel: sessionOptions.initialThinkingLevel,
				modelThinkingLevels: sessionOptions.modelThinkingLevels,
				createThreadState: sessionOptions.createThreadState,
				completeTurn: sessionOptions.completeTurn,
				getResumeThread: sessionOptions.getResumeThread,
				resumeThreads: sessionOptions.resumeThreads,
			};
			if (options.sessionResultFactory) {
				return options.sessionResultFactory(sessionCallIndex++, captured);
			}
			return options.sessionResult ?? { result: { kind: "closed" } };
		},
		loadSettings: options.loadSettings ?? (async () => options.settings ?? {}),
	});

	return {
		pi,
		commands,
		ctx,
		notifications,
		getCaptured: () => captured,
	};
}

test("registers the btw command", () => {
	const harness = createHarness({ modelResolution: { kind: "unavailable" } });
	assert.ok(harness.commands.has("btw"));
	assert.match(harness.commands.get("btw")?.description ?? "", /side question/);
});

test("/btw with a question starts a session with the initial question", async () => {
	const harness = createHarness({
		modelResolution: SELECTED,
		settings: {},
	});
	await harness.commands.get("btw")?.handler("  what does this mean?  ", harness.ctx);
	assert.equal(harness.getCaptured()?.initialQuestion, "what does this mean?");
});

test("/btw without arguments leaves the initial question undefined", async () => {
	const harness = createHarness({
		modelResolution: SELECTED,
	});
	await harness.commands.get("btw")?.handler("", harness.ctx);
	assert.equal(harness.getCaptured()?.initialQuestion, undefined);
});

test("rejects non-TUI modes with a notification", async () => {
	const harness = createHarness({ mode: "print" });
	await harness.commands.get("btw")?.handler("", harness.ctx);
	assert.equal(harness.getCaptured(), undefined);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "/btw requires interactive TUI mode",
		level: "error",
	});
});

test("unavailable model stops with an error notification", async () => {
	const harness = createHarness({ modelResolution: { kind: "unavailable" } });
	await harness.commands.get("btw")?.handler("q", harness.ctx);
	assert.equal(harness.getCaptured(), undefined);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "No available model for /btw",
		level: "error",
	});
});

test("cancelled model resolution notifies and stops", async () => {
	const harness = createHarness({ modelResolution: { kind: "cancelled" } });
	await harness.commands.get("btw")?.handler("q", harness.ctx);
	assert.equal(harness.getCaptured(), undefined);
	assert.deepEqual(harness.notifications.at(-1), { message: "Cancelled", level: "info" });
});

test("session options carry settings, thinking level, and the conversation context factory", async () => {
	const harness = createHarness({
		modelResolution: SELECTED,
		settings: { thinkingLevel: "high", rememberThinkingLevelChanges: false },
	});
	await harness.commands.get("btw")?.handler("q", harness.ctx);
	const captured = harness.getCaptured();
	assert.equal(captured?.settings.thinkingLevel, "high");
	assert.equal(captured?.currentMainThinkingLevel, "medium");
	assert.equal(captured?.initialThinkingLevel, "high");
	assert.ok(captured?.settingsPath.endsWith("pi-btw.json"));
});

test("a fresh thread uses the session branch as conversation context", async () => {
	const harness = createHarness({
		modelResolution: SELECTED,
	});
	await harness.commands.get("btw")?.handler("q", harness.ctx);
	const captured = harness.getCaptured();
	const state = captured?.createThreadState();
	assert.ok(state);
	assert.equal(state?.thread.conversationContext.includes("User: hello"), true);
});

test("completeTurn streams through the provider and pushes an answered turn", async () => {
	const harness = createHarness({
		modelResolution: SELECTED,
	});
	await harness.commands.get("btw")?.handler("q", harness.ctx);
	const captured = harness.getCaptured();
	const state = captured?.createThreadState();
	assert.ok(state && captured);
	const result = await captured.completeTurn(
		state.thread,
		"side question",
		"low",
		new AbortController().signal,
	);
	assert.equal(result.kind, "answered");
	assert.equal(state.thread.turns.length, 1);
	assert.equal(state.thread.turns[0]?.kind, "answered");
});

test("failed turns keep the thread in-memory and resumable on the next /btw", async () => {
	let stored: BtwThreadState | undefined;
	const harness = createHarness({
		modelResolution: SELECTED,
		sessionResultFactory: (_callIndex, sessionOptions) => {
			if (!stored) {
				stored = sessionOptions.createThreadState();
				return { result: { kind: "closed" }, threadState: stored };
			}
			// second session adds a turn and becomes resumable
			stored.thread.turns.push({
				kind: "answered",
				question: "q",
				answer: "a",
				response: fakeAssistantMessage("a"),
			});
			stored.title = "q";
			stored.updatedAt = Date.now();
			return { result: { kind: "closed" }, threadState: stored };
		},
	});
	await harness.commands.get("btw")?.handler("q", harness.ctx);
	// first session ended without content -> nothing stored yet
	await harness.commands.get("btw")?.handler("", harness.ctx);
	// third invocation sees the thread as resumable
	await harness.commands.get("btw")?.handler("", harness.ctx);
	const third = harness.getCaptured();
	assert.equal(third?.resumeThreads.length, 1);
	assert.deepEqual(
		{ id: third?.resumeThreads[0]?.id, title: third?.resumeThreads[0]?.title },
		{ id: stored?.id, title: "q" },
	);
	assert.equal(third?.getResumeThread(stored?.id ?? ""), stored);
});

test("invalid settings surface as a warning before the session starts", async () => {
	const notifications: string[] = [];
	const harness = createHarness({
		resolveModel: async () => {
			notifications.push("resolved");
			return { kind: "unavailable" };
		},
		loadSettings: async () => {
			notifications.push("loaded");
			return {};
		},
	});
	await harness.commands.get("btw")?.handler("", harness.ctx);
	assert.deepEqual(notifications, ["loaded", "resolved"], "settings load before model resolution");
	assert.equal(harness.getCaptured(), undefined);
});

test("thinking level for new threads clamps to the model's supported set", async () => {
	const harness = createHarness({
		modelResolution: SELECTED,
		settings: { thinkingLevel: "max" },
	});
	await harness.commands.get("btw")?.handler("q", harness.ctx);
	// SIDE_MODEL has no thinkingLevelMap, so xhigh/max are unsupported and
	// "max" clamps down to the highest usable level.
	assert.equal(harness.getCaptured()?.initialThinkingLevel, "high");
});