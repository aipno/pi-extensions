import { test } from "node:test";
import assert from "node:assert/strict";
import { withStatus } from "../../src/render.ts";
import { sanitizeChromeDevtoolsDisplay } from "../../src/tool-selector.ts";
import { commandCompletions, parseCommand } from "../../src/chrome-devtools.ts";
import { supportsNativeDeferredToolLoading } from "../../src/lazy-tools.ts";
import { CHROME_DEVTOOLS_TOOL_NAMES } from "../../src/tool-names.ts";

test("concurrent tool statuses restore the latest remaining activity", async () => {
	const statuses: Array<string | undefined> = [];
	const sessionManager = {};
	const ui = {
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
	};
	const firstContext = { sessionManager, ui };
	const secondContext = { sessionManager, ui };
	let finishFirst: (() => void) | undefined;
	const firstBlocked = new Promise<void>((resolve) => {
		finishFirst = resolve;
	});
	let finishSecond: (() => void) | undefined;
	const secondBlocked = new Promise<void>((resolve) => {
		finishSecond = resolve;
	});
	const first = withStatus(firstContext, "first", () => firstBlocked);
	const second = withStatus(secondContext, "second", () => secondBlocked);
	finishFirst?.();
	await first;
	assert.equal(statuses.at(-1), "second");
	finishSecond?.();
	await second;
	assert.equal(statuses.at(-1), undefined);
});

test("parseCommand resolves aliases and empty arguments", () => {
	assert.equal(parseCommand(""), "menu");
	assert.equal(parseCommand("  "), "menu");
	assert.equal(parseCommand("help"), "help");
	assert.equal(parseCommand("quickstart"), "quickstart");
	assert.equal(parseCommand("status"), "status");
	assert.equal(parseCommand("settings"), "settings");
	assert.equal(parseCommand("tools"), "tools");
	assert.equal(parseCommand("select"), "tools");
	assert.equal(parseCommand("toggle"), "tools");
	assert.equal(parseCommand("enable"), "enable");
	assert.equal(parseCommand("on"), "enable");
	assert.equal(parseCommand("disable"), "disable");
	assert.equal(parseCommand("off"), "disable");
	assert.equal(parseCommand("mystery"), "unknown");
	assert.equal(parseCommand("Tools"), "tools");
});

test("commandCompletions filters by prefix and rejects whitespace", () => {
	assert.equal(commandCompletions("h")?.map((entry) => entry.value).join(","), "help");
	assert.equal(commandCompletions("hel")?.[0]?.value, "help");
	assert.equal(commandCompletions("to")?.map((entry) => entry.value).includes("toggle"), true);
	assert.equal(commandCompletions("help extra"), null);
	assert.equal(commandCompletions("zzz"), null);
});

test("sanitizeChromeDevtoolsDisplay strips controls and caps length", () => {
	const withControls = `first\u0000\u001b[31msecond\u202ehidden\u202cthird`;
	const sanitized = sanitizeChromeDevtoolsDisplay(withControls);
	assert.ok(!sanitized.includes("\u0000"));
	assert.ok(!sanitized.includes("\u001b"));
	assert.ok(!sanitized.includes("\u202e"));
	assert.ok(sanitized.includes("first"));
	assert.ok(sanitized.includes("second"));
	assert.ok(sanitized.includes("third"));

	const truncated = sanitizeChromeDevtoolsDisplay("x".repeat(1_000), 20);
	assert.equal(truncated.length, 20);
	assert.equal(truncated.at(-1), "…");
});

test("the tool catalog contains exactly the five capability tools", () => {
	assert.deepEqual(CHROME_DEVTOOLS_TOOL_NAMES, [
		"chrome_devtools_list_pages",
		"chrome_devtools_select_page",
		"chrome_devtools_navigate",
		"chrome_devtools_evaluate",
		"chrome_devtools_screenshot",
	]);
});

test("native deferred tool support is detected per model capability", () => {
	const anthropicModel = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-sonnet-4-5-20250514",
		compat: {},
	} as never;
	assert.equal(supportsNativeDeferredToolLoading(anthropicModel), true);

	const oldAnthropic = {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-sonnet-4-0-20241104",
		compat: {},
	} as never;
	assert.equal(supportsNativeDeferredToolLoading(oldAnthropic), false);

	const configured = {
		api: "anthropic-messages",
		provider: "other",
		id: "anything",
		compat: { supportsToolReferences: true },
	} as never;
	assert.equal(supportsNativeDeferredToolLoading(configured), true);

	const kimi = {
		api: "openai-completions",
		compat: { deferredToolsMode: "kimi" },
	} as never;
	assert.equal(supportsNativeDeferredToolLoading(kimi), true);

	const responses = {
		api: "openai-responses",
		compat: { supportsToolSearch: true },
	} as never;
	assert.equal(supportsNativeDeferredToolLoading(responses), true);

	const unsupported = { api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5-20250929", compat: {} } as never;
	assert.equal(supportsNativeDeferredToolLoading(unsupported), false);
	assert.equal(supportsNativeDeferredToolLoading(undefined), false);
});