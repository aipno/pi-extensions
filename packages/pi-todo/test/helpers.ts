/**
 * Minimal Pi-runtime test doubles, standing in for `@juicesharp/rpiv-test-utils`
 * from the reference implementation. Everything here is structural — cast to
 * the real Pi types at the call site.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TaskDetails } from "../tool/types.ts";

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** Identity theme: every styling call returns the text unchanged. */
export function makeIdentityTheme(): Theme {
	return {
		fg: (_c: string, s: string) => s,
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
		strikethrough: (s: string) => s,
	} as unknown as Theme;
}

/** Recording theme: fg/strikethrough wrap text in `<token>` markers so tests
 *  can assert the semantic color hierarchy. */
export function makeRecordingTheme(): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<bold>${text}</bold>`,
		strikethrough: (text: string) => `<strike>${text}</strike>`,
	} as unknown as Theme;
}

// ---------------------------------------------------------------------------
// Mock UI context
// ---------------------------------------------------------------------------

export interface MockUI extends ExtensionUIContext {
	calls: Array<{ method: string; args: unknown[] }>;
}

/** Recording ExtensionUIContext: setWidget/notify/etc. push into `calls`. */
export function createMockUI<T extends Record<string, unknown>>(overrides: T = {} as T): MockUI & T {
	const calls: MockUI["calls"] = [];
	const ui = {
		theme: makeIdentityTheme(),
		setWidget: (...args: unknown[]) => {
			calls.push({ method: "setWidget", args });
		},
		notify: (...args: unknown[]) => {
			calls.push({ method: "notify", args });
		},
		setStatus: () => {},
		getToolsExpanded: () => false,
		onTerminalInput: () => () => {},
		...overrides,
	};
	return Object.assign(ui, { calls }) as unknown as MockUI & T;
}

// ---------------------------------------------------------------------------
// Mock ctx
// ---------------------------------------------------------------------------

export function createMockCtx(overrides: {
	sessionId?: string;
	branch?: unknown[];
	hasUI?: boolean;
	ui?: Partial<ExtensionUIContext>;
} = {}) {
	const ui = createMockUI(overrides.ui ?? {});
	return {
		hasUI: overrides.hasUI ?? true,
		mode: "tui",
		cwd: process.cwd(),
		ui,
		sessionManager: {
			getSessionId: () => overrides.sessionId ?? "test-session",
			getBranch: () => overrides.branch ?? [],
		},
	};
}

// ---------------------------------------------------------------------------
// Mock pi (ExtensionAPI)
// ---------------------------------------------------------------------------

export interface MockPiCaptured {
	tools: Map<string, Record<string, unknown>>;
	commands: Map<string, Record<string, unknown>>;
	shortcuts: Map<string, { description: string; handler: (ctx: unknown) => void }>;
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}

export function createMockPi() {
	const captured: MockPiCaptured = {
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		events: new Map(),
	};
	const pi = {
		registerTool: (tool: Record<string, unknown>) => {
			captured.tools.set(tool.name as string, tool);
		},
		registerCommand: (name: string, def: Record<string, unknown>) => {
			captured.commands.set(name, def);
		},
		registerShortcut: (key: string, options: { description: string; handler: (ctx: unknown) => void }) => {
			captured.shortcuts.set(key, options);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			if (!captured.events.has(event)) captured.events.set(event, []);
			captured.events.get(event)!.push(handler);
		},
	};
	return { pi, captured };
}

// ---------------------------------------------------------------------------
// Branch entry builders (for replay tests)
// ---------------------------------------------------------------------------

export function makeUserMessage(text: string): unknown {
	return { type: "message", message: { role: "user", text } };
}

export function makeTodoToolResult(details: TaskDetails): unknown {
	return { type: "message", message: { role: "toolResult", toolName: "todo", details } };
}

/** Wrap raw branch entries in the `sessionManager.getBranch()` return shape. */
export function buildSessionEntries(entries: unknown[]): unknown[] {
	return entries;
}