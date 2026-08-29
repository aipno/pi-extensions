/**
 * The dedicated fullscreen btw session: a state machine rendered as a single
 * `ui.custom` overlay covering the terminal. One overlay for the whole flow
 * means the main view never flashes between sub-views and the main editor
 * draft stays untouched until an explicit bring-to-main.
 *
 * States: menu -> composer <-> answering, plus settings, the bring-to-main
 * scope/from menus, the preview screen, and the append/replace delivery
 * menus. Rendering and input are plain data in / data out, so the view is
 * testable with minimal doubles (see test/helpers.ts).
 */

import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	type Theme,
	UserMessageComponent,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildQuickBringToMainSegments,
	type BtwBringToMainSummary,
	formatBtwBringToMain,
	getAnsweredTurns,
	summarizeBringToMain,
} from "./bring-to-main.ts";
import { updateBtwSettings as updateSettingsFile, type BtwSettings, type BtwSettingsPatch } from "./settings.ts";
import {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	type CompleteSideThreadTurnResult,
	type SideThread,
	type SideThreadTurn,
} from "./side-thread.ts";
import { escapeTerminalControls, sanitizeSingleLine, truncatePreview } from "./text.ts";

const MAX_STEERING_DISPLAY_LINES = 3;
const SAME_AS_MAIN_THREAD = "Same as main thread";
const OSC133_MARKERS = ["\u001b]133;A\u0007", "\u001b]133;B\u0007", "\u001b]133;C\u0007"];

export interface BtwResumeThreadSummary {
	id: string;
	title: string;
	questionCount: number;
}

export interface BtwThreadState {
	id: string;
	title?: string;
	thread: SideThread;
	thinkingLevel: BtwThinkingLevel;
	createdAt: number;
	updatedAt: number;
}

export type BtwSessionResult =
	| { kind: "closed" }
	| { kind: "broughtToMain"; summary: BtwBringToMainSummary };

// ---------------------------------------------------------------------------
// Host abstractions (implemented over the pi runtime; faked in tests)
// ---------------------------------------------------------------------------

export interface BtwSessionTui {
	terminal: { rows: number };
	requestRender(): void;
}

export interface BtwKeybindings {
	matches(data: string, keybinding: string): boolean;
	getKeys(keybinding: string): string[];
}

export interface BtwTextEditor {
	focused: boolean;
	render(width: number): string[];
	handleInput(data: string): void;
	getText(): string;
	setText(text: string): void;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => void;
	dispose?(): void;
}

export type BtwEditorFactory = () => BtwTextEditor;

export type BtwTranscriptRenderer = (
	turns: readonly SideThreadTurn[],
	width: number,
	pendingQuestion?: string,
) => string[];

/** What the view needs from the outside world. */
export interface BtwSessionViewOptions {
	tui: BtwSessionTui;
	theme: Theme;
	keybindings: BtwKeybindings;
	createThreadState: () => BtwThreadState;
	completeTurn: (
		thread: SideThread,
		question: string,
		thinkingLevel: BtwThinkingLevel,
		signal: AbortSignal,
	) => Promise<CompleteSideThreadTurnResult>;
	getResumeThread: (id: string) => BtwThreadState | undefined;
	resumeThreads: readonly BtwResumeThreadSummary[];
	settings: BtwSettings;
	settingsPath: string;
	currentMainThinkingLevel: BtwThinkingLevel;
	modelThinkingLevels: readonly BtwThinkingLevel[];
	initialThinkingLevel: BtwThinkingLevel;
	initialQuestion?: string;
	createEditor: BtwEditorFactory;
	renderTranscript: BtwTranscriptRenderer;
	saveSettings: (patch: BtwSettingsPatch) => Promise<void>;
	getEditorText: () => string;
	setEditorText: (text: string) => void;
	notify: (message: string) => void;
	onClose: (result: BtwSessionResult) => void;
}

export interface RunBtwSessionOptions {
	ctx: ExtensionCommandContext;
	createThreadState: () => BtwThreadState;
	completeTurn: (
		thread: SideThread,
		question: string,
		thinkingLevel: BtwThinkingLevel,
		signal: AbortSignal,
	) => Promise<CompleteSideThreadTurnResult>;
	getResumeThread: (id: string) => BtwThreadState | undefined;
	resumeThreads: readonly BtwResumeThreadSummary[];
	settings: BtwSettings;
	settingsPath: string;
	currentMainThinkingLevel: BtwThinkingLevel;
	modelThinkingLevels: readonly BtwThinkingLevel[];
	initialThinkingLevel: BtwThinkingLevel;
	initialQuestion?: string;
	// Test seams; defaults build the real pi components.
	createEditor?: BtwEditorFactory;
	renderTranscript?: BtwTranscriptRenderer;
	saveSettings?: (patch: BtwSettingsPatch) => Promise<void>;
}

function defaultTranscriptRenderer(theme: Theme): BtwTranscriptRenderer {
	let cachedKey = "";
	let cachedLines: string[] = [];
	return (turns, width, pendingQuestion) => {
		const key = `${width}|${turns.length}|${pendingQuestion ?? ""}`;
		if (key === cachedKey) return cachedLines;
		cachedKey = key;
		const components: Component[] = [];
		for (const turn of turns) {
			components.push(
				new UserMessageComponent(escapeTerminalControls(turn.question), getMarkdownTheme(), 1),
			);
			if (turn.kind === "error") {
				components.push(
					new Markdown(
						`Error: ${escapeTerminalControls(turn.answer)}`,
						1,
						1,
						getMarkdownTheme(),
						{ color: (text) => theme.fg("error", text) },
					),
				);
			} else {
				components.push(
					new AssistantMessageComponent(
						{
							...turn.response,
							content: [{ type: "text", text: escapeTerminalControls(turn.answer) }],
							stopReason: "stop",
							errorMessage: undefined,
						},
						true,
						getMarkdownTheme(),
						"",
						1,
					),
				);
			}
		}
		if (pendingQuestion) {
			components.push(
				new UserMessageComponent(escapeTerminalControls(pendingQuestion), getMarkdownTheme(), 1),
			);
		}
		cachedLines = components.flatMap((component) => component.render(width)).map(stripOsc133);
		return cachedLines;
	};
}

function stripOsc133(line: string): string {
	return OSC133_MARKERS.reduce((result, marker) => result.replaceAll(marker, ""), line);
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

type BtwMenuId = "main" | "resume" | "scope" | "from" | "delivery" | "confirm-replace";

interface BtwMenuItem {
	id: string;
	label: string;
	description?: string;
}

interface BtwMenuSpec {
	id: BtwMenuId;
	title: string;
	lines?: string[];
	items: BtwMenuItem[];
	hint: "back" | "close";
}

type BtwSessionState =
	| { kind: "menu"; menuId: BtwMenuId; selectedIndex: number; scrollOffset: number; warning?: string }
	| { kind: "settings"; selectedRow: number; status?: string; statusIsError: boolean }
	| { kind: "composer"; warning?: string }
	| { kind: "answering"; question: string; warning?: string }
	| { kind: "preview"; title: string; summaryLine: string; lines: string[]; from: "scope" | "from" };

type BtwMenuSelections = Partial<Record<BtwMenuId, number>>;

interface BringToMainDraft {
	draft: string;
	summary: BtwBringToMainSummary;
}

const MENU_HINTS: Record<BtwMenuId, string> = {
	main: "Esc close · ↑/↓ move · Enter select",
	resume: "Esc back · ↑/↓ move · Enter select",
	scope: "Esc back · ↑/↓ move · Enter select",
	from: "Esc back · ↑/↓ move · Enter select",
	delivery: "Esc back · ↑/↓ move · Enter select",
	"confirm-replace": "Esc back · ↑/↓ move · Enter select",
};

export class BtwSessionView implements Component, Focusable {
	private readonly options: BtwSessionViewOptions;
	private threadState: BtwThreadState | undefined;
	private settingsCopy: BtwSettings;
	private activeThinkingLevel: BtwThinkingLevel;
	private currentMainThinkingLevel: BtwThinkingLevel;
	private steeringQueue: string[] = [];
	private menuSelections: BtwMenuSelections = {};
	private state!: BtwSessionState;
	private closed = false;
	private focusedValue = false;
	private composerEditor: BtwTextEditor | undefined;
	private steeringEditor: BtwTextEditor | undefined;
	private activeController: AbortController | undefined;
	private pendingDelivery: BringToMainDraft | undefined;
	private replaceSnapshot: string | undefined;
	private scrollOffset = 0;
	private followEnd = true;
	private transcriptContentHeight = 0;
	private transcriptViewportHeight = 0;
	private previewOffset = 0;
	private readonly tui: BtwSessionTui;
	private readonly theme: Theme;
	private readonly keybindings: BtwKeybindings;
	private readonly settingsPath: string;
	private readonly onClose: (result: BtwSessionResult) => void;
	private readonly modelThinkingLevels: readonly BtwThinkingLevel[];

	constructor(options: BtwSessionViewOptions) {
		this.options = options;
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.settingsPath = options.settingsPath;
		this.onClose = options.onClose;
		this.settingsCopy = { ...options.settings };
		this.currentMainThinkingLevel = options.currentMainThinkingLevel;
		this.modelThinkingLevels =
			options.modelThinkingLevels.length > 0 ? [...options.modelThinkingLevels] : ["off"];
		this.activeThinkingLevel = clampToAvailableThinkingLevel(
			options.initialThinkingLevel,
			this.modelThinkingLevels,
		);
		if (options.initialQuestion) {
			this.enterAnswering(options.initialQuestion);
		} else {
			this.state = {
				kind: "menu",
				menuId: "main",
				selectedIndex: 0,
				scrollOffset: 0,
			};
		}
	}

	// -- Component / Focusable --------------------------------------------------

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		const editor = this.activeEditor();
		if (editor) editor.focused = value;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const rows = Math.max(1, this.tui.terminal.rows);
		if (this.closed) return Array.from({ length: rows }, () => "");
		const lines =
			this.state.kind === "menu"
				? this.renderMenuState(safeWidth, rows)
				: this.state.kind === "settings"
					? this.renderSettingsState(safeWidth, rows)
					: this.state.kind === "preview"
						? this.renderPreviewState(safeWidth, rows)
						: this.state.kind === "composer"
							? this.renderComposerState(safeWidth, rows)
							: this.renderAnsweringState(safeWidth, rows);
		return fitScreen(lines, rows);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		switch (this.state.kind) {
			case "menu":
				this.handleMenuInput(data);
				return;
			case "settings":
				this.handleSettingsInput(data);
				return;
			case "preview":
				this.handlePreviewInput(data);
				return;
			case "composer":
				this.handleComposerInput(data);
				return;
			case "answering":
				this.handleAnsweringInput(data);
				return;
		}
	}

	invalidate(): void {
		// Every render is derived from the current state; nothing to cache.
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.activeController?.abort();
	}

	/** The thread state the session ended with (undefined if none was started). */
	get finalThreadState(): BtwThreadState | undefined {
		return this.threadState;
	}

	// -- State transitions -------------------------------------------------------

	private requireThreadState(): BtwThreadState {
		this.threadState ??= this.options.createThreadState();
		return this.threadState;
	}

	private startFreshThread(): void {
		this.threadState = this.options.createThreadState();
		this.threadState.thinkingLevel = this.activeThinkingLevel;
		this.steeringQueue = [];
		
		this.resetScroll(false);
		this.state = { kind: "composer" };
		this.getComposerEditor()?.setText("");
		this.requestRender();
	}

	private resumeThread(id: string): void {
		const resumed = this.options.getResumeThread(id);
		if (!resumed) {
			this.state = {
				kind: "menu",
				menuId: "resume",
				selectedIndex: this.menuSelections.resume ?? 0,
				scrollOffset: 0,
				warning: "The selected side thread is no longer available",
			};
			this.requestRender();
			return;
		}
		this.activeThinkingLevel = clampToAvailableThinkingLevel(
			resumed.thinkingLevel,
			this.modelThinkingLevels,
		);
		this.threadState = resumed;
		this.steeringQueue = [];
		
		this.resetScroll(true);
		this.state = { kind: "composer" };
		this.getComposerEditor()?.setText("");
		this.requestRender();
	}

	private enterMenu(menuId: BtwMenuId, warning?: string): void {
		const items = this.buildMenu(menuId).items;
		this.state = {
			kind: "menu",
			menuId,
			selectedIndex: clamp(this.menuSelections[menuId] ?? 0, 0, Math.max(0, items.length - 1)),
			scrollOffset: 0,
			warning,
		};
		this.requestRender();
	}

	private enterSettings(): void {
		this.state = { kind: "settings", selectedRow: 0, statusIsError: false };
		this.requestRender();
	}

	private enterComposer(clearDraft: boolean): void {
		this.activeController = undefined;
		this.resetScroll((this.threadState?.thread.turns.length ?? 0) > 0);
		if (clearDraft) {
			this.getComposerEditor()?.setText("");
		}
		this.state = { kind: "composer" };
		this.requestRender();
	}

	private enterAnswering(question: string): void {
		this.resetScroll(true);
		this.state = { kind: "answering", question };
		this.requestRender();
		const threadState = this.requireThreadState();
		const controller = new AbortController();
		this.activeController = controller;
		const turn = this.options.completeTurn(
			threadState.thread,
			question,
			this.activeThinkingLevel,
			controller.signal,
		);
		void turn.then(
			(result) => this.handleTurnResult(question, result),
			() =>
				this.handleTurnResult(question, {
					kind: "error",
					message: "The side request failed unexpectedly.",
				}),
		);
	}

	private handleTurnResult(question: string, result: CompleteSideThreadTurnResult): void {
		if (this.closed) return;
		const threadState = this.threadState;
		if (!threadState) return;
		if (result.kind === "aborted") {
			this.close({ kind: "closed" }, { notify: "Cancelled" });
			return;
		}
		if (result.kind === "error") {
			threadState.thread.turns.push({ kind: "error", question, answer: result.message });
		}
		threadState.title ||= sanitizeSingleLine(question) || "Untitled side thread";
		threadState.updatedAt = Date.now();
		threadState.thinkingLevel = this.activeThinkingLevel;
		const next = this.steeringQueue.shift();
		if (next !== undefined) {
			this.enterAnswering(next);
			return;
		}
		this.enterComposer(true);
	}

	private close(result: BtwSessionResult, extras: { notify?: string } = {}): void {
		if (this.closed) return;
		this.closed = true;
		this.activeController?.abort();
		this.composerEditor?.dispose?.();
		this.steeringEditor?.dispose?.();
		if (extras.notify) this.options.notify(extras.notify);
		this.onClose(result);
	}

	// -- Thinking level ------------------------------------------------------------

	private cycleThinking(): void {
		if (this.modelThinkingLevels.length < 2) return;
		const currentIndex = this.modelThinkingLevels.indexOf(this.activeThinkingLevel);
		const next = this.modelThinkingLevels[(currentIndex + 1) % this.modelThinkingLevels.length];
		if (!next || this.closed) return;
		this.activeThinkingLevel = next;
		if (this.threadState) this.threadState.thinkingLevel = next;
		this.requestRender();
		const remember =
			this.settingsCopy.thinkingLevel !== undefined &&
			(this.settingsCopy.rememberThinkingLevelChanges ?? true);
		if (!remember) return;
		void this.options.saveSettings({ thinkingLevel: next }).catch((error: unknown) => {
			if (this.closed) return;
			this.showTransientWarning(
				`Thinking level changed to ${next}, but could not be remembered in pi-btw.json: ${formatError(error)}`,
			);
		});
	}

	private isThinkingCycle(data: string): boolean {
		return this.options.keybindings.matches(data, "app.thinking.cycle");
	}

	// -- Input handlers -------------------------------------------------------------

	private handleMenuInput(data: string): void {
		const state = this.state;
		if (state.kind !== "menu") return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.close({ kind: "closed" });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (state.menuId === "main") this.close({ kind: "closed" });
			else this.enterMenu("main");
			return;
		}
		const items = this.buildMenu(state.menuId).items;
		if (matchesKey(data, Key.up)) {
			this.moveMenuSelection(state.menuId, -1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveMenuSelection(state.menuId, 1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.moveMenuSelection(state.menuId, -Math.max(1, Math.floor(this.tui.terminal.rows / 2)));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.moveMenuSelection(state.menuId, Math.max(1, Math.floor(this.tui.terminal.rows / 2)));
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const item = items[state.selectedIndex];
			if (item) this.selectMenuItem(state.menuId, item.id);
		}
	}

	private moveMenuSelection(menuId: BtwMenuId, delta: number): void {
		const state = this.state;
		if (state.kind !== "menu" || state.menuId !== menuId) return;
		const items = this.buildMenu(menuId).items;
		if (items.length === 0) return;
		const next = clamp(state.selectedIndex + delta, 0, items.length - 1);
		const itemRows = this.menuItemRows(menuId);
		const scrollOffset = clamp(state.scrollOffset, Math.max(0, next - itemRows + 1), next);
		this.state = { ...state, selectedIndex: next, scrollOffset, warning: undefined };
		this.menuSelections[menuId] = next;
		this.requestRender();
	}

	private selectMenuItem(menuId: BtwMenuId, itemId: string): void {
		this.menuSelections[menuId] = this.state.kind === "menu" ? this.state.selectedIndex : 0;
		switch (menuId) {
			case "main":
				if (itemId === "start") this.startFreshThread();
				else if (itemId === "resume") this.enterMenu("resume");
				else if (itemId === "settings") this.enterSettings();
				return;
			case "resume":
				this.resumeThread(itemId);
				return;
			case "scope":
				this.selectScope(itemId);
				return;
			case "from":
				this.selectFromQuestion(itemId);
				return;
			case "delivery":
				this.selectDelivery(itemId);
				return;
			case "confirm-replace":
				this.selectConfirmReplace(itemId);
				return;
		}
	}

	private handleSettingsInput(data: string): void {
		const state = this.state;
		if (state.kind !== "settings") return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.close({ kind: "closed" });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.enterMenu("main");
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.state = { ...state, selectedRow: 0 };
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.state = { ...state, selectedRow: 1 };
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.cycleSettingsValue(-1);
			return;
		}
		if (
			matchesKey(data, Key.right) ||
			matchesKey(data, Key.space) ||
			matchesKey(data, Key.enter)
		) {
			this.cycleSettingsValue(1);
			return;
		}
	}

	private cycleSettingsValue(direction: -1 | 1): void {
		const state = this.state;
		if (state.kind !== "settings") return;
		if (state.selectedRow === 0) {
			const { current, next } = cycleOption(
				this.thinkingLevelOptions(),
				this.settingsCopy.thinkingLevel ?? SAME_AS_MAIN_THREAD,
				direction,
			);
			if (!next || next === current) return;
			const patch: BtwSettingsPatch =
				next === SAME_AS_MAIN_THREAD
					? { thinkingLevel: undefined }
					: { thinkingLevel: next as BtwThinkingLevel };
			this.applySettingsPatch(patch, `Pi BTW thinking level: ${next}.`);
			return;
		}
		const current = effectiveRemember(this.settingsCopy) ? "On" : "Off";
		const next = current === "On" ? "Off" : "On";
		this.applySettingsPatch(
			{ rememberThinkingLevelChanges: next === "On" },
			`Remember thinking level changes: ${next}.`,
		);
	}

	private applySettingsPatch(patch: BtwSettingsPatch, status: string): void {
		const state = this.state;
		if (state.kind !== "settings") return;
		this.state = { ...state, status: "Saving…", statusIsError: false };
		this.requestRender();
		void this.options
			.saveSettings(patch)
			.then(() => {
				if (this.closed) return;
				if (Object.hasOwn(patch, "thinkingLevel")) {
					this.settingsCopy = { ...this.settingsCopy, thinkingLevel: patch.thinkingLevel };
				}
				if (Object.hasOwn(patch, "rememberThinkingLevelChanges")) {
					this.settingsCopy = {
						...this.settingsCopy,
						rememberThinkingLevelChanges: patch.rememberThinkingLevelChanges,
					};
				}
				this.updateSettingsStatus(status, false);
			})
			.catch((error: unknown) => {
				if (this.closed) return;
				this.updateSettingsStatus(
					`pi-btw settings were not saved; the previous value remains active: ${formatError(error)}`,
					true,
				);
			});
	}

	private updateSettingsStatus(status: string, statusIsError: boolean): void {
		const state = this.state;
		if (state.kind !== "settings") return;
		this.state = { ...state, status, statusIsError };
		this.requestRender();
	}

	private handleComposerInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.close({ kind: "closed" });
			return;
		}
		const canBringToMain = getAnsweredTurns(this.requireThreadState().thread.turns).length > 0;
		if (canBringToMain && matchesKey(data, Key.ctrl("r"))) {
			this.enterMenu("scope");
			return;
		}
		if (this.isThinkingCycle(data)) {
			this.cycleThinking();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-Math.max(1, this.transcriptViewport()));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(Math.max(1, this.transcriptViewport()));
			return;
		}
		this.getComposerEditor().handleInput(data);
	}

	private handleAnsweringInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.close({ kind: "closed" }, { notify: "Cancelled" });
			return;
		}
		if (this.isThinkingCycle(data)) {
			this.cycleThinking();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-Math.max(1, this.transcriptViewport()));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(Math.max(1, this.transcriptViewport()));
			return;
		}
		this.getSteeringEditor()?.handleInput(data);
	}

	private handlePreviewInput(data: string): void {
		const state = this.state;
		if (state.kind !== "preview") return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.close({ kind: "closed" });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.returnFromPreview();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.deliverDraft(this.pendingDelivery);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollPreview(-Math.max(1, Math.floor(this.tui.terminal.rows / 2)));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollPreview(Math.max(1, Math.floor(this.tui.terminal.rows / 2)));
			return;
		}
	}

	private returnFromPreview(): void {
		const state = this.state;
		if (state.kind !== "preview") return;
		if (state.from === "from") {
			this.enterMenu("from");
		} else {
			this.enterMenu("scope");
		}
	}

	// -- Bring to main ---------------------------------------------------------------

	private selectScope(itemId: string): void {
		const threadState = this.requireThreadState();
		const turns = threadState.thread.turns;
		if (itemId === "cancel") {
			this.enterComposer(false);
			return;
		}
		if (itemId === "latest") {
			this.enterPreview(makeDraft(buildQuickBringToMainSegments(turns, { kind: "latest" })), "scope");
			return;
		}
		if (itemId === "entire") {
			this.enterPreview(makeDraft(buildQuickBringToMainSegments(turns, { kind: "entire" })), "scope");
			return;
		}
		if (itemId === "from") {
			if (getAnsweredTurns(turns).length > 0) this.enterMenu("from");
		}
	}

	private selectFromQuestion(itemId: string): void {
		const answered = getAnsweredTurns(this.requireThreadState().thread.turns);
		const prefix = "from-";
		if (!itemId.startsWith(prefix)) return;
		const answeredTurnIndex = Number.parseInt(itemId.slice(prefix.length), 10);
		if (
			Number.isNaN(answeredTurnIndex) ||
			answeredTurnIndex < 0 ||
			answeredTurnIndex >= answered.length
		) {
			return;
		}
		const draft = makeDraft(
			buildQuickBringToMainSegments(this.requireThreadState().thread.turns, {
				kind: "from",
				answeredTurnIndex,
			}),
		);
		this.enterPreview(draft, "from");
	}

	private enterPreview(draft: BringToMainDraft, from: "scope" | "from"): void {
		const summary = draft.summary;
		const count = summary.messages === 1 ? "1 message" : `${summary.messages} messages`;
		const lineCount = summary.lines === 1 ? "1 line" : `${summary.lines} lines`;
		this.pendingDelivery = draft;
		this.previewOffset = 0;
		this.state = {
			kind: "preview",
			title: `Preview · ${count} · ${lineCount} · ~${summary.tokens} tokens`,
			summaryLine: "This block is what gets loaded into the main editor.",
			lines: draft.draft.split("\n"),
			from,
		};
		this.requestRender();
	}

	private deliverDraft(draft: BringToMainDraft | undefined): void {
		if (!draft) return;
		const existing = this.options.getEditorText();
		if (!existing.trim()) {
			this.options.setEditorText(draft.draft);
			this.options.notify(describeDelivery(draft.summary, "Brought"));
			this.close({ kind: "broughtToMain", summary: draft.summary });
			return;
		}
		this.enterMenu("delivery");
	}

	private selectDelivery(itemId: string): void {
		const draft = this.pendingDelivery;
		if (!draft) return;
		if (itemId === "cancel") {
			this.enterComposer(false);
			return;
		}
		if (itemId === "append") {
			this.options.setEditorText(`${this.options.getEditorText()}\n\n${draft.draft}`);
			this.options.notify(describeDelivery(draft.summary, "Appended"));
			this.close({ kind: "broughtToMain", summary: draft.summary });
			return;
		}
		if (itemId === "replace") {
			this.replaceSnapshot = this.options.getEditorText();
			this.enterMenu("confirm-replace");
		}
	}

	private selectConfirmReplace(itemId: string): void {
		const draft = this.pendingDelivery;
		if (!draft) return;
		if (itemId === "back") {
			this.enterMenu("delivery");
			return;
		}
		if (itemId !== "replace") return;
		// The editor is owned by the main view; a concurrent change while the
		// confirmation was open must not be silently overwritten.
		if (this.options.getEditorText() !== this.replaceSnapshot) {
			this.enterMenu(
				"delivery",
				"The main editor changed during confirmation. Review the updated draft and choose again.",
			);
			return;
		}
		this.options.setEditorText(draft.draft);
		this.options.notify(describeDelivery(draft.summary, "Replaced"));
		this.close({ kind: "broughtToMain", summary: draft.summary });
	}

	// -- Scroll handling ---------------------------------------------------------------

	private transcriptViewport(): number {
		return Math.max(0, this.transcriptViewportHeight);
	}

	private scrollBy(delta: number): void {
		const maxOffset = Math.max(0, this.transcriptContentHeight - this.transcriptViewport());
		const next = clamp(this.scrollOffset + delta, 0, maxOffset);
		if (next !== this.scrollOffset) {
			this.scrollOffset = next;
			this.followEnd = next >= maxOffset;
			this.requestRender();
		}
	}

	private resetScroll(followEnd: boolean): void {
		this.scrollOffset = 0;
		this.followEnd = followEnd;
	}

	private updateScrollForContent(contentHeight: number, viewportHeight: number): void {
		this.transcriptContentHeight = contentHeight;
		this.transcriptViewportHeight = viewportHeight;
		const maxOffset = Math.max(0, contentHeight - viewportHeight);
		if (this.followEnd) this.scrollOffset = maxOffset;
		else this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
	}

	private scrollPreview(delta: number): void {
		const state = this.state;
		if (state.kind !== "preview") return;
		const maxOffset = Math.max(0, state.lines.length - this.previewViewport());
		const next = clamp(this.previewOffset + delta, 0, maxOffset);
		if (next !== this.previewOffset) {
			this.previewOffset = next;
			this.requestRender();
		}
	}

	private previewViewport(): number {
		return Math.max(1, this.tui.terminal.rows - 5);
	}

	// -- Rendering ------------------------------------------------------------------------

	private renderMenuState(width: number, rows: number): string[] {
		const state = this.state;
		if (state.kind !== "menu") return [];
		const menu = this.buildMenu(state.menuId);
		const header = this.renderHeader("menu", width);
		const body = this.menuBodyLines(menu);

		const itemRows = Math.max(1, rows - 4 - body.length - (state.warning ? 1 : 0));
		const visible = menu.items.slice(state.scrollOffset, state.scrollOffset + itemRows);
		for (const [index, item] of visible.entries()) {
			const itemIndex = state.scrollOffset + index;
			const selected = itemIndex === state.selectedIndex;
			const prefix = "▸ ";
			const labelText = selected
				? this.theme.bold(this.theme.fg("accent", `${prefix}${item.label}`))
				: `${prefix}${item.label}`;
			const description = item.description
				? this.theme.fg("muted", `  ${item.description}`)
				: "";
			body.push(truncateToWidth(`${labelText}${description}`, width));
		}
		if (menu.items.length === 0) {
			body.push(this.theme.fg("muted", "  (nothing to show here)"));
		}
		const footer = this.renderFooter(
			state.warning
				? this.theme.fg("warning", state.warning)
				: this.theme.fg("muted", MENU_HINTS[menu.id]),
			width,
		);
		return [header, ...body, footer];
	}

	private renderSettingsState(width: number, rows: number): string[] {
		const state = this.state;
		if (state.kind !== "settings") return [];
		const header = this.renderHeader("settings", width);
		const body: string[] = [
			this.theme.bold(this.theme.fg("accent", "Pi BTW Settings")),
			this.theme.fg("muted", `User settings · ${sanitizeSingleLine(this.settingsPath)}`),
			"",
		];
		const thinkingValue =
			this.settingsCopy.thinkingLevel ??
			`${SAME_AS_MAIN_THREAD} (currently ${this.currentMainThinkingLevel})`;
		body.push(
			this.renderSettingsRow(0, state.selectedRow === 0, "Thinking level", thinkingValue),
		);
		const rememberValue = effectiveRemember(this.settingsCopy) ? "On" : "Off";
		const rememberSummary =
			this.settingsCopy.thinkingLevel === undefined
				? `${rememberValue} (fixed levels only)`
				: rememberValue;
		body.push(
			this.renderSettingsRow(
				1,
				state.selectedRow === 1,
				"Remember thinking level changes",
				rememberSummary,
			),
		);
		if (state.status) {
			body.push(this.theme.fg(state.statusIsError ? "error" : "muted", state.status));
		}
		const footer = this.renderFooter(
			this.theme.fg("muted", "Esc back · ↑/↓ row · ←/→ or Enter change · Ctrl+C close"),
			width,
		);
		return [header, ...body, footer];
	}

	private renderSettingsRow(rowIndex: number, selected: boolean, label: string, value: string): string {
		const prefix = selected ? "▸ " : "  ";
		const labelText = selected
			? this.theme.bold(this.theme.fg("accent", `${prefix}${label}`))
			: `${prefix}${label}`;
		const valueText = this.theme.fg("accent", value);
		return truncateToWidth(`${labelText}  ${valueText}`, 120);
	}

	private thinkingLevelOptions(): string[] {
		return [SAME_AS_MAIN_THREAD, ...this.modelThinkingLevels];
	}

	private renderComposerState(width: number, rows: number): string[] {
		const threadState = this.requireThreadState();
		const header = this.renderHeader("side thread", width);
		const editorLines = this.getComposerEditor().render(width);
		const contentRows = Math.max(0, rows - 3 - editorLines.length);
		const content = this.renderTranscriptSlice(threadState.thread.turns, width, contentRows);
		const footer = this.renderFooter(this.composerFooter(width), width);
		return [header, ...content, footer, ...editorLines];
	}

	private composerFooter(width: number): string {
		const state = this.state;
		if (state.kind !== "composer") return "";
		if (state.warning) {
			return width < 32
				? this.theme.fg("warning", `${state.warning} • Ctrl+C exit`)
				: this.theme.fg("warning", state.warning);
		}
		const canBringToMain =
			getAnsweredTurns(this.requireThreadState().thread.turns).length > 0;
		const base = canBringToMain
			? "btw • Enter send • Ctrl+R bring to main • Ctrl+C exit"
			: "btw • Enter send • Ctrl+C exit";
		const scrollable = this.transcriptContentHeight > this.transcriptViewport();
		const hints = `${base}${this.cycleHint()}${scrollable ? " • PgUp/PgDn history" : ""}`;
		return visibleWidth(hints) <= width
			? this.theme.fg("muted", hints)
			: this.theme.fg("muted", `${base}${this.cycleHint()}`);
	}

	private cycleHint(): string {
		if (this.modelThinkingLevels.length < 2) return "";
		const key =
			sanitizeSingleLine(String(this.options.keybindings.getKeys("app.thinking.cycle")[0] ?? "shift+tab")) ||
			"Shift+Tab";
		return ` • thinking ${this.activeThinkingLevel} • ${formatKeyLabel(key)} cycle`;
	}

	private renderAnsweringState(width: number, rows: number): string[] {
		const state = this.state;
		if (state.kind !== "answering") return [];
		const threadState = this.requireThreadState();
		const header = this.renderHeader("side thread", width);
		const editorLines = this.getSteeringEditor()?.render(width) ?? [];
		const steeringLines = this.renderSteeringLines(width);
		const contentRows = Math.max(
			0,
			rows - 4 - editorLines.length - steeringLines.length,
		);
		const content = this.renderTranscriptSlice(
			threadState.thread.turns,
			width,
			contentRows,
			state.question,
		);
		const footer = this.renderFooter(this.answeringFooter(width), width);
		return [header, ...content, ...steeringLines, footer, ...editorLines];
	}

	private answeringFooter(width: number): string {
		const state = this.state;
		if (state.kind !== "answering") return "";
		if (state.warning) {
			return width < 32
				? this.theme.fg("warning", `${state.warning} • Ctrl+C cancel`)
				: this.theme.fg("warning", state.warning);
		}
		const scrollable = this.transcriptContentHeight > this.transcriptViewport();
		const hints = `Answering… • Enter steer • Ctrl+C cancel${this.cycleHint()}${scrollable ? " • PgUp/PgDn history" : ""}`;
		return visibleWidth(hints) <= width
			? this.theme.fg("muted", hints)
			: this.theme.fg("muted", "Answering… • Enter • Ctrl+C");
	}

	private renderSteeringLines(width: number): string[] {
		const questions = this.steeringQueue;
		if (questions.length === 0) return [];
		const formatQuestion = (question: string) =>
			sanitizeSingleLine(question) || "(non-printing message)";
		const maxLines = MAX_STEERING_DISPLAY_LINES;
		if (maxLines <= 1 && questions.length > 1) {
			return [
				truncateToWidth(
					this.theme.fg(
						"dim",
						`Steering (+${questions.length - 1} more): ${formatQuestion(questions[0] ?? "")}`,
					),
					width,
				),
			];
		}
		const hasOverflow = questions.length > maxLines;
		const questionLimit = hasOverflow ? Math.max(1, maxLines - 1) : maxLines;
		const lines = questions
			.slice(0, questionLimit)
			.map((question) =>
				truncateToWidth(
					this.theme.fg("dim", `Steering: ${formatQuestion(question)}`),
					width,
				),
			);
		if (hasOverflow) {
			lines.push(
				truncateToWidth(
					this.theme.fg("dim", `Steering: … +${questions.length - questionLimit} more`),
					width,
				),
			);
		}
		return lines;
	}

	private renderPreviewState(width: number, rows: number): string[] {
		const state = this.state;
		if (state.kind !== "preview") return [];
		const header = this.renderHeader("bring to main", width);
		const body: string[] = [
			this.theme.bold(this.theme.fg("accent", state.title)),
			this.theme.fg("muted", state.summaryLine),
			"",
		];
		const viewport = this.previewViewport();
		const maxOffset = Math.max(0, state.lines.length - viewport);
		if (this.previewOffset > maxOffset) this.previewOffset = maxOffset;
		const visible = state.lines.slice(this.previewOffset, this.previewOffset + viewport);
		body.push(
			...visible.map((line) => {
				const escaped = escapeTerminalControls(line).replaceAll("\t", "    ");
				if (escaped === "") return "";
				return truncateToWidth(this.theme.fg("text", escaped), width, "");
			}),
		);
		const scrollable = state.lines.length > viewport;
		const footer = this.renderFooter(
			this.theme.fg(
				"muted",
				`Enter bring • Esc back • Ctrl+C close${scrollable ? " • PgUp/PgDn scroll" : ""}`,
			),
			width,
		);
		return [header, ...body, footer];
	}

	private renderTranscriptSlice(
		turns: readonly SideThreadTurn[],
		width: number,
		rows: number,
		pendingQuestion?: string,
	): string[] {
		const allLines = this.options.renderTranscript(turns, width, pendingQuestion);
		this.updateScrollForContent(allLines.length, Math.max(0, rows));
		return allLines.slice(this.scrollOffset, this.scrollOffset + Math.max(0, rows));
	}

	private renderHeader(section: string, width: number): string {
		const thinking = this.modelThinkingLevels.length > 1 ? ` · thinking ${this.activeThinkingLevel}` : "";
		const title = `─ btw · ${section}${thinking} `;
		const ruleWidth = Math.max(0, width - visibleWidth(title));
		return this.theme.fg("muted", `${truncateToWidth(title, width, "")}${"─".repeat(ruleWidth)}`);
	}

	private renderFooter(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private showTransientWarning(message: string): void {
		const state = this.state;
		if (state.kind === "composer" || state.kind === "answering") {
			this.state = { ...state, warning: message };
			this.requestRender();
		} else {
			this.options.notify(message);
		}
	}

	// -- Editors ---------------------------------------------------------------------

	private activeEditor(): BtwTextEditor | undefined {
		if (this.state.kind === "composer") return this.getComposerEditor();
		if (this.state.kind === "answering") return this.getSteeringEditor();
		return undefined;
	}

	private getComposerEditor(): BtwTextEditor {
		this.composerEditor ??= this.options.createEditor();
		const editor = this.composerEditor;
		editor.onChange = () => {
			if (this.state.kind === "composer" && this.state.warning) {
				this.state = { ...this.state, warning: undefined };
				this.requestRender();
			}
		};
		editor.onSubmit = (text: string) => {
			if (this.state.kind !== "composer") return;
			const question = text.trim();
			if (!question) {
				this.state = { ...this.state, warning: "Question cannot be empty" };
				this.requestRender();
				return;
			}
			
			this.enterAnswering(question);
		};
		return this.composerEditor;
	}

	private getSteeringEditor(): BtwTextEditor | undefined {
		if (this.state.kind !== "answering") return undefined;
		this.steeringEditor ??= this.options.createEditor();
		const editor = this.steeringEditor;
		editor.onChange = () => {
			if (this.state.kind === "answering" && this.state.warning) {
				this.state = { ...this.state, warning: undefined };
				this.requestRender();
			}
		};
		editor.onSubmit = (text: string) => {
			if (this.state.kind !== "answering") return;
			const question = text.trim();
			if (!question) {
				this.state = { ...this.state, warning: "Question cannot be empty" };
				this.requestRender();
				return;
			}
			this.steeringQueue.push(question);
			editor.setText("");
			this.requestRender();
		};
		return this.steeringEditor;
	}

	// -- Menu specs ----------------------------------------------------------------------

	private menuItemRows(menuId: BtwMenuId): number {
		const rows = Math.max(1, this.tui.terminal.rows);
		const bodyLength = this.menuBodyLines(this.buildMenu(menuId)).length;
		return Math.max(1, rows - 4 - bodyLength - 1);
	}

	private menuBodyLines(menu: BtwMenuSpec): string[] {
		const body: string[] = [this.theme.bold(this.theme.fg("accent", menu.title))];
		for (const line of menu.lines ?? []) body.push(this.theme.fg("muted", line));
		body.push("");
		return body;
	}

	private buildMenu(menuId: BtwMenuId): BtwMenuSpec {
		switch (menuId) {
			case "main":
				return {
					id: "main",
					title: "Pi BTW",
					lines: [
						this.mainMenuSummary(),
						"",
						"Side questions stay out of the main conversation until you bring them back.",
					],
					items: [
						{ id: "start", label: "Start side thread", description: "Open an empty side thread" },
						...(this.options.resumeThreads.length > 0
							? [
									{
										id: "resume" as const,
										label: "Resume side thread" as const,
										description: "Continue an in-memory side thread",
									},
								]
							: []),
						{
							id: "settings",
							label: "Settings",
							description: "Choose pi-btw thinking level and shortcut memory",
						},
					],
					hint: "close",
				};
			case "resume":
				return {
					id: "resume",
					title: "Resume BTW side thread",
					items: this.options.resumeThreads.map((thread) => ({
						id: thread.id,
						label: sanitizeSingleLine(thread.title) || "Untitled side thread",
						description: `${thread.questionCount} ${thread.questionCount === 1 ? "question" : "questions"}`,
					})),
					hint: "back",
				};
			case "scope": {
				const answered = getAnsweredTurns(this.requireThreadState().thread.turns);
				const latest = makeDraft(
					buildQuickBringToMainSegments(this.requireThreadState().thread.turns, {
						kind: "latest",
					}),
				);
				const entire = makeDraft(
					buildQuickBringToMainSegments(this.requireThreadState().thread.turns, {
						kind: "entire",
					}),
				);
				return {
					id: "scope",
					title: "Bring what back to the main thread?",
					items: [
						{
							id: "latest",
							label: "Latest question and answer",
							description: `1 Q&A · ~${latest.summary.tokens} tokens`,
						},
						...(answered.length > 1
							? [
									{
										id: "from" as const,
										label: "From a question onward…" as const,
										description: "Choose a starting question",
									},
								]
							: []),
						{
							id: "entire",
							label: "Entire side thread",
							description: `${answered.length} Q&A · ~${entire.summary.tokens} tokens`,
						},
						{ id: "cancel", label: "Cancel", description: "Return to the side thread" },
					],
					hint: "back",
				};
			}
			case "from": {
				const answered = getAnsweredTurns(this.requireThreadState().thread.turns);
				return {
					id: "from",
					title: "Start from which question?",
					items: answered.map((turn, index) => ({
						id: `from-${index}`,
						label: `${index + 1}. ${truncatePreview(sanitizeSingleLine(turn.question))}`,
					})),
					hint: "back",
				};
			}
			case "delivery":
				return {
					id: "delivery",
					title: "The main editor already has a draft",
					items: [
						{
							id: "append",
							label: "Append after current draft",
							description: "Recommended — keeps the existing draft",
						},
						{
							id: "replace",
							label: "⚠ Replace current draft",
							description: "Discards current editor text",
						},
						{ id: "cancel", label: "Cancel", description: "Return to the side thread" },
					],
					hint: "back",
				};
			case "confirm-replace": {
				const characters = [...this.options.getEditorText()].length;
				return {
					id: "confirm-replace",
					title: `Replace the current ${characters}-character editor draft?`,
					items: [
						{ id: "back", label: "Back", description: "Keep current editor text" },
						{
							id: "replace",
							label: "⚠ Replace current draft",
							description: "Cannot be undone",
						},
					],
					hint: "back",
				};
			}
		}
	}

	private mainMenuSummary(): string {
		const levels = this.settingsCopy.thinkingLevel;
		return `Thinking: ${
			levels === undefined
				? `${SAME_AS_MAIN_THREAD} (currently ${this.currentMainThinkingLevel})`
				: levels
		} · Remember changes: ${effectiveRemember(this.settingsCopy) ? "On" : "Off"}${
			levels === undefined ? " (fixed levels only)" : ""
		}`;
	}
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

export async function runBtwSession(
	options: RunBtwSessionOptions,
): Promise<{ result: BtwSessionResult; threadState?: BtwThreadState }> {
	const ctx = options.ctx;
	const outcome = await ctx.ui.custom<{
		result: BtwSessionResult;
		threadState?: BtwThreadState;
	}>(
		(tui, theme, keybindings, done) => {
			const editorTheme: EditorTheme = {
				borderColor: (text) => theme.fg("accent", text),
				selectList: {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			};
			const view = new BtwSessionView({
				tui,
				theme,
				keybindings: keybindings as unknown as BtwKeybindings,
				createThreadState: options.createThreadState,
				completeTurn: options.completeTurn,
				getResumeThread: options.getResumeThread,
				resumeThreads: options.resumeThreads,
				settings: options.settings,
				settingsPath: options.settingsPath,
				currentMainThinkingLevel: options.currentMainThinkingLevel,
				modelThinkingLevels: options.modelThinkingLevels,
				initialThinkingLevel: options.initialThinkingLevel,
				initialQuestion: options.initialQuestion,
				createEditor:
					options.createEditor ??
					(() => new Editor(tui, editorTheme)),
				renderTranscript: options.renderTranscript ?? defaultTranscriptRenderer(theme),
				saveSettings:
					options.saveSettings ??
					(async (patch: BtwSettingsPatch) => {
						await updateSettingsFile(patch);
					}),
				getEditorText: () => ctx.ui.getEditorText(),
				setEditorText: (text) => ctx.ui.setEditorText(text),
				notify: (message) => {
					try {
						ctx.ui.notify(sanitizeSingleLine(message), "info");
					} catch {
						// The command context may be replaced while the session is open.
					}
				},
				onClose: (result) => done({ result, threadState: view.finalThreadState }),
			});
			return view;
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", anchor: "top-left", row: 0, col: 0 },
		},
	);
	return outcome;
}

function makeDraft(segments: ReturnType<typeof buildQuickBringToMainSegments>): BringToMainDraft {
	const summary = summarizeBringToMain(segments);
	return { draft: formatBtwBringToMain(segments), summary };
}

function describeDelivery(summary: BtwBringToMainSummary, verb: string): string {
	const count = summary.messages === 1 ? "1 message" : `${summary.messages} messages`;
	const tokenCount = summary.tokens === 1 ? "1 token" : `~${summary.tokens} tokens`;
	return `${verb} ${count} (${tokenCount}) to the main editor. Review and submit when ready.`;
}

function effectiveRemember(settings: BtwSettings): boolean {
	return settings.rememberThinkingLevelChanges ?? true;
}

function cycleOption(
	options: readonly string[],
	current: string,
	direction: -1 | 1,
): { current: string; next: string | undefined } {
	if (options.length === 0) return { current, next: undefined };
	const index = options.indexOf(current);
	const nextIndex =
		index < 0 ? 0 : (index + direction + options.length) % options.length;
	return { current, next: options[nextIndex] };
}

function clampToAvailableThinkingLevel(
	requested: BtwThinkingLevel,
	available: readonly BtwThinkingLevel[],
): BtwThinkingLevel {
	if (available.includes(requested)) return requested;
	const requestedIndex = BTW_THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < BTW_THINKING_LEVELS.length; index += 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

function formatKeyLabel(key: string): string {
	return key
		.split("+")
		.map((part) => {
			const lower = part.toLowerCase();
			if (lower === "ctrl") return "Ctrl";
			if (lower === "alt") return "Alt";
			if (lower === "shift") return "Shift";
			if (lower === "escape" || lower === "esc") return "Esc";
			if (lower === "enter" || lower === "return") return "Enter";
			if (lower === "pageup") return "PgUp";
			if (lower === "pagedown") return "PgDn";
			return part.length === 1
				? part.toUpperCase()
				: `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
		})
		.join("+");
}

function fitScreen(lines: string[], rows: number): string[] {
	if (lines.length <= rows) {
		return [...lines, ...Array.from({ length: rows - lines.length }, () => "")];
	}
	if (rows <= 1) return [lines[0] ?? ""];
	return [lines[0] ?? "", ...lines.slice(lines.length - rows + 1)];
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}