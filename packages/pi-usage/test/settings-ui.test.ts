import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createMockContext } from "./support.ts";
import type {
	UsageSettingsPatch,
	UsageSettingsRuntime,
	UsageSettingsState,
} from "../src/settings.ts";
import { showUsageSettings } from "../src/usage-settings-ui.ts";

type SettingsComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose?: () => void;
	invalidate?: () => void;
};

initTheme("dark", false);

function runtimeState(
	overrides: Partial<UsageSettingsState["settings"]> = {},
	options: { kind?: UsageSettingsState["kind"]; failUpdates?: boolean } = {},
): {
	runtime: UsageSettingsRuntime;
	state: () => UsageSettingsState;
} {
	const initial: UsageSettingsState["settings"] = {
		codexFastMode: false,
		xaiUsage: true,
		usageStatusline: false,
		...overrides,
	};
	let state: UsageSettingsState = {
		kind: options.kind ?? "loaded",
		path: "/tmp/pi-usage.json",
		settings: { ...initial },
		...(options.kind === "invalid" ? { issue: "bad" } : { document: { ...initial } }),
	};
	return {
		runtime: {
			get: () => structuredClone(state),
			reload: async () => structuredClone(state),
			update: async (patch: UsageSettingsPatch, signal) => {
				signal?.throwIfAborted();
				if (options.failUpdates) throw new Error("disk full");
				const settings: Record<string, unknown> = { ...state.settings };
				const document: Record<string, unknown> = { ...(state.document ?? {}) };
				for (const [key, value] of Object.entries(patch)) {
					if (
						(key === "newApiSystemToken" || key === "newApiUserId") &&
						typeof value === "string" &&
						value.trim().length === 0
					) {
						if (value.length > 0) continue;
						delete settings[key];
						delete document[key];
						continue;
					}
					if (value === undefined) {
						delete settings[key];
						delete document[key];
						continue;
					}
					settings[key] = value;
					document[key] = value;
				}
				state = {
					...state,
					kind: "loaded",
					settings: settings as unknown as UsageSettingsState["settings"],
					document,
				};
				return structuredClone(state);
			},
			flush: async () => undefined,
		},
		state: () => structuredClone(state),
	};
}

function openSettings(
	runtime: UsageSettingsRuntime,
	onApplied: (id: string, previous: boolean, next: boolean) => void = () => undefined,
): { component: SettingsComponent; closed: Promise<boolean>; notifications: Array<{ message: string; level?: string }> } {
	let component: SettingsComponent | undefined;
	let resolveDone!: (value: boolean) => void;
	const closed = new Promise<boolean>((resolve) => {
		resolveDone = resolve;
	});
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				const done = (value: boolean) => {
					component?.dispose?.();
					resolveDone(value);
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: { bold(text: string): string; fg(color: string, text: string): string },
						keybindings: object,
						done: (value: boolean) => void,
					) => SettingsComponent
				)({ requestRender() {} }, { bold: (text) => text, fg: (_c, text) => text }, {}, done);
			}),
	});
	void showUsageSettings(ctx, runtime, new AbortController().signal, () => true, onApplied);
	assert.ok(component);
	return { component: component!, closed, notifications };
}

function press(component: SettingsComponent, text: string): void {
	for (const character of text) component.handleInput(character);
}

function plain(component: SettingsComponent): string {
	return stripTerminalSequences(component.render(100).join("\n"));
}

function step(component: SettingsComponent, count: number): void {
	for (let index = 0; index < count; index += 1) component.handleInput("\u001b[B");
}

/** Open the New API system token submenu from a fresh Settings screen. */
function openTokenEditor(runtime: UsageSettingsRuntime) {
	const { component, closed, notifications } = openSettings(runtime);
	step(component, 3);
	const mainList = component.render(100).join("\n");
	component.handleInput("\r");
	return { component, mainList, closed, notifications };
}

/** Open the New API user id submenu from a fresh Settings screen. */
function openUserIdEditor(runtime: UsageSettingsRuntime) {
	const { component, closed } = openSettings(runtime);
	step(component, 4);
	const mainList = component.render(100).join("\n");
	component.handleInput("\r");
	return { component, mainList, closed };
}

/** Let queued saves settle. */
async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("the settings list shows both New API rows and never the stored secret", async () => {
	const { runtime } = runtimeState({ newApiSystemToken: "secret", newApiUserId: 7 });
	const { component } = openSettings(runtime);
	const rendered = plain(component);
	assert.match(rendered, /New API system token\s+configured/);
	assert.match(rendered, /New API user ID\s+7\b/);
	assert.doesNotMatch(rendered, /secret/);
});

test("the token editor masks input, validates, and saves the token", async () => {
	const { runtime, state } = runtimeState();
	const { component, mainList, closed } = openTokenEditor(runtime);
	assert.match(mainList.replace(/\x1b\[[0-9;]*m/gu, ""), /New API system token\s+not set/);
	const editorFrame = plain(component);
	assert.match(editorFrame, /System access token/);
	press(component, "abc123");
	const masked = plain(component);
	assert.doesNotMatch(masked, /abc123/);
	assert.match(masked, /••••••/);
	// A too-long value is rejected inline (control characters cannot be typed,
	// so the length limit is the reachable client-side guard).
	for (let index = 0; index < 130; index += 1) component.handleInput("x");
	component.handleInput("\r");
	assert.match(plain(component), /128 characters or fewer/);
	// Trim back to the largest accepted value, confirm, then close the root screen.
	for (let index = 0; index < 8; index += 1) component.handleInput("\u007f");
	component.handleInput("\r");
	await settle();
	component.handleInput("\u001b");
	const changed = await closed;
	assert.equal(changed, true);
	assert.equal(state().settings.newApiSystemToken, `abc123${"x".repeat(122)}`);
});

test("an empty submit on a configured token double-confirms before erasing", async () => {
	const { runtime, state } = runtimeState({ newApiSystemToken: "secret" });
	const { component, closed } = openTokenEditor(runtime);
	component.handleInput("\r");
	const confirmFrame = plain(component);
	assert.match(confirmFrame, /erases the stored System access token/);
	assert.match(confirmFrame, /Enter erase · Esc keep editing/);
	assert.equal(state().settings.newApiSystemToken, "secret");
	// Escape keeps the stored value and returns to editing.
	component.handleInput("\u001b");
	assert.match(plain(component), /System access token/);
	assert.equal(state().settings.newApiSystemToken, "secret");
	// Enter, Enter erases and closes the submenu.
	component.handleInput("\r");
	component.handleInput("\r");
	await settle();
	component.handleInput("\u001b");
	const changed = await closed;
	assert.equal(changed, true);
	assert.equal(state().settings.newApiSystemToken, undefined);
});

test("Escape from the token editor cancels without saving", async () => {
	const { runtime, state } = runtimeState();
	const { component, closed } = openTokenEditor(runtime);
	press(component, "token");
	component.handleInput("\u001b"); // leave the submenu
	component.handleInput("\u001b"); // close the settings screen
	const changed = await closed;
	await settle();
	assert.equal(changed, false);
	assert.equal(state().settings.newApiSystemToken, undefined);
});

test("the user id editor pre-fills, saves, and normalizes the displayed value", async () => {
	const { runtime, state } = runtimeState({ newApiUserId: 42 });
	const { component, mainList, closed } = openUserIdEditor(runtime);
	assert.match(mainList.replace(/\x1b\[[0-9;]*m/gu, ""), /New API user ID\s+42/);
	const editorFrame = plain(component);
	assert.match(editorFrame, /42/);
	press(component, "9");
	component.handleInput("\r");
	await settle();
	component.handleInput("\u001b");
	component.handleInput("\u001b");
	await closed;
	assert.equal(state().settings.newApiUserId, 942);
});

test("invalid user ids are rejected in the editor and never persisted", async () => {
	const { runtime, state } = runtimeState();
	const { component, closed } = openUserIdEditor(runtime);
	press(component, "1.5");
	component.handleInput("\r");
	assert.match(plain(component), /positive whole number/);
	component.handleInput("\u001b");
	component.handleInput("\u001b");
	const changed = await closed;
	await settle();
	assert.equal(changed, false);
	assert.equal(state().settings.newApiUserId, undefined);
});

test("saving new-api values reports applied(hadBefore, hasNow) transitions once", async () => {
	const { runtime, state } = runtimeState({ newApiSystemToken: "secret" });
	const applied: Array<[string, boolean, boolean]> = [];
	const { component, closed } = openSettings(runtime, (id, previous, next) => {
		applied.push([id, previous, next]);
	});
	// Erase the stored token through the submenu.
	step(component, 3);
	component.handleInput("\r");
	component.handleInput("\r");
	component.handleInput("\r");
	await settle();
	component.handleInput("\u001b");
	await closed;
	assert.deepEqual(applied, [["newApiSystemToken", true, false]]);
	assert.equal(state().settings.newApiSystemToken, undefined);
});

test("failed token saves roll the row back to its previous display value", async () => {
	const { runtime, state } = runtimeState({ newApiSystemToken: "secret" }, { failUpdates: true });
	const { component, closed, notifications } = openTokenEditor(runtime);
	press(component, "replacement");
	component.handleInput("\r");
	await settle();
	component.handleInput("\u001b");
	component.handleInput("\u001b");
	const changed = await closed;
	assert.equal(changed, false);
	assert.equal(state().settings.newApiSystemToken, "secret");
	const rendered = plain(component);
	assert.match(rendered, /New API system token\s+configured/);
	assert.match(notifications[0]?.message ?? "", /disk full/);
});