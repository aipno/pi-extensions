/**
 * Harness for driving BtwSessionView with the fakes from helpers.ts.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	BtwSessionView,
	type BtwSessionResult,
	type BtwSessionViewOptions,
	type BtwThreadState,
} from "../session.ts";
import type { BtwSettings } from "../settings.ts";
import type { BtwThinkingLevel, CompleteSideThreadTurnResult, SideThread } from "../side-thread.ts";
import {
	FakeEditor,
	FakeKeybindings,
	FakeTui,
	PlainTheme,
	fakeAssistantMessage,
	plainTranscript,
} from "./helpers.ts";

export interface SessionHarness {
	view: BtwSessionView;
	tui: FakeTui;
	theme: PlainTheme;
	keybindings: FakeKeybindings;
	editors: FakeEditor[];
	threadState: BtwThreadState | undefined;
	turns: SideThread["turns"];
	completeTurnCalls: Array<{
		thread: SideThread;
		question: string;
		level: BtwThinkingLevel;
		signal: AbortSignal;
	}>;
	completeTurnBehavior: (call: {
		thread: SideThread;
		question: string;
		level: BtwThinkingLevel;
		signal: AbortSignal;
	}) => Promise<CompleteSideThreadTurnResult>;
	settingsSaves: Array<Partial<BtwSettings>>;
	saveSettingsError: unknown;
	editorText: string;
	notifications: string[];
	closed: BtwSessionResult | undefined;
	getSettingState(): { kind: "settings" } | undefined;
}

export interface HarnessOptions {
	rows?: number;
	initialQuestion?: string;
	settings?: BtwSettings;
	thinkingLevels?: readonly BtwThinkingLevel[];
	resumeThreads?: Array<{ id: string; title: string; questionCount: number }>;
	resumeThread?: BtwThreadState;
	initialThinkingLevel?: BtwThinkingLevel;
	answer?: Partial<AssistantMessage>;
}

let threadCounter = 0;

export function createHarness(options: HarnessOptions = {}): SessionHarness {
	const tui = new FakeTui();
	if (options.rows !== undefined) tui.terminal.rows = options.rows;
	const theme = new PlainTheme();
	const keybindings = new FakeKeybindings();
	const editors: FakeEditor[] = [];
	const notifications: string[] = [];
	let editorText = "";
	const harness: Omit<SessionHarness, "view"> = {
		tui,
		theme,
		keybindings,
		editors,
		threadState: undefined,
		turns: [],
		completeTurnCalls: [],
		completeTurnBehavior: async ({ thread, question, level, signal }) => {
			if (signal.aborted) return { kind: "aborted" };
			const answer = `answer to: ${question} (${level})`;
			// Mirror the documented contract: an answered turn is appended to the
			// thread before the promise resolves (production: completeSideThreadTurn).
			thread.turns.push({
				kind: "answered",
				question,
				answer,
				response: fakeAssistantMessage(answer),
			});
			return answeredTurn(question, answer);
		},
		settingsSaves: [],
		saveSettingsError: undefined,
		editorText: "",
		notifications,
		closed: undefined,
		getSettingState: () => undefined,
	};

	const viewOptions: BtwSessionViewOptions = {
		tui,
		theme: theme as unknown as Theme,		keybindings,
		createThreadState: () => {
			const now = Date.now();
			const state: BtwThreadState = {
				id: `btw-test-${++threadCounter}`,
				thread: { conversationContext: "ctx", turns: [] },
				thinkingLevel: options.settings?.thinkingLevel ?? options.initialThinkingLevel ?? "low",
				createdAt: now,
				updatedAt: now,
			};
			harness.threadState = state;
			return state;
		},
		completeTurn: (thread, question, level, signal) => {
			const call = { thread, question, level, signal };
			harness.completeTurnCalls.push(call);
			return harness.completeTurnBehavior(call);
		},
		getResumeThread: (id) =>
			options.resumeThread?.id === id ? options.resumeThread : undefined,
		resumeThreads: options.resumeThreads ?? [],
		settings: options.settings ?? {},
		settingsPath: "~/.pi/agent/pi-btw.json",
		currentMainThinkingLevel: "medium",
		modelThinkingLevels: options.thinkingLevels ?? ["off", "low", "medium", "high"],
		initialThinkingLevel: options.initialThinkingLevel ?? "low",
		initialQuestion: options.initialQuestion,
		createEditor: () => {
			const editor = new FakeEditor();
			editors.push(editor);
			return editor;
		},
		renderTranscript: (turns, width, pendingQuestion) =>
			plainTranscript(turns as never, width, pendingQuestion),
		saveSettings: async (patch) => {
			harness.settingsSaves.push(patch);
			if (harness.saveSettingsError !== undefined) throw harness.saveSettingsError;
		},
		getEditorText: () => harness.editorText,
		setEditorText: (text) => {
			harness.editorText = text;
		},
		notify: (message) => {
			notifications.push(message);
		},
		onClose: (result) => {
			harness.closed = result;
		},
	};

	const view = new BtwSessionView(viewOptions);
	// Mutate and return the SAME object: closures inside the view options update
	// these fields, so callers must observe the identical harness instance.
	return Object.assign(harness, { view });
}

/** Fast-forward through one answered turn: submit, wait, and return to composer. */
export async function answerCurrentQuestion(
	harness: SessionHarness,
	question: string,
): Promise<void> {
	const editor = harness.editors.at(-1);
	if (!editor) throw new Error("no editor available");
	editor.setText(question);
	editor.onSubmit?.(question);
	await flushTurns(harness);
}

export async function flushTurns(harness: SessionHarness): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

/** Advance a fake editor helper: directly invoke submit on the given editor. */
export function submitOn(editor: FakeEditor | undefined, text: string): void {
	if (!editor) throw new Error("editor missing");
	editor.setText(text);
	editor.onSubmit?.(text);
}

export function answeredTurn(
	question: string,
	answer = `answer to: ${question}`,
): CompleteSideThreadTurnResult {
	return {
		kind: "answered",
		response: fakeAssistantMessage(answer),
		answer,
	};
}

export function completedThreadState(turns: number): BtwThreadState {
	const now = Date.now();
	return {
		id: `btw-test-${++threadCounter}`,
		thread: { conversationContext: "ctx", turns: [] },
		thinkingLevel: "low",
		createdAt: now,
		updatedAt: now,
	};
}