/**
 * pi-btw: ask quick side questions in a dedicated fullscreen side thread
 * without derailing the main conversation.
 *
 * The /btw command runs one fullscreen session (menu -> composer <-> answering,
 * settings, bring-to-main preview and delivery). Everything the user does stays
 * out of the main session; only an explicit bring-to-main touches the editor.
 */

import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildConversationContext } from "./context.ts";
import { createModelCompleteSimple, resolveBtwModel, type ResolvedBtwModel } from "./model.ts";
import {
	runBtwSession,
	type BtwResumeThreadSummary,
	type BtwThreadState,
	type RunBtwSessionOptions,
} from "./session.ts";
import {
	type BtwSettings,
	btwSettingsPath,
	readBtwSettings,
} from "./settings.ts";
import {
	completeSideThreadTurn,
	createSideThread,
} from "./side-thread.ts";
import { sanitizeSingleLine } from "./text.ts";

export { BTW_SETTINGS_FILE } from "./settings.ts";
export type { BtwSettings, BtwSettingsLoadResult } from "./settings.ts";
export { normalizeBtwSettings, parseBtwModelReference, readBtwSettings } from "./settings.ts";
export { BTW_THINKING_LEVELS } from "./side-thread.ts";
export type { BtwThinkingLevel } from "./side-thread.ts";
export { buildUserPrompt, completeSideQuestion } from "./side-thread.ts";
export { sanitizeSingleLine } from "./text.ts";

type ModelResolutionOutcome =
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "selected"; selected: ResolvedBtwModel };

export type ResolveModelFn = (
	settings: BtwSettings,
	ctx: ExtensionCommandContext,
) => Promise<ModelResolutionOutcome>;

export interface BtwExtensionDependencies {
	resolveModel?: ResolveModelFn;
	runSession?: typeof runBtwSession;
	loadSettings?: (ctx: ExtensionCommandContext) => Promise<BtwSettings>;
}

export default function btw(pi: ExtensionAPI, dependencies: BtwExtensionDependencies = {}) {
	const resolveModel = dependencies.resolveModel ?? resolveBtwModelWithLoader;
	const runSession = dependencies.runSession ?? runBtwSession;
	const loadSettings = dependencies.loadSettings ?? loadSettingsForCommand;
	// Pi creates a fresh extension instance after session replacement or reload,
	// so in-memory threads only survive while this instance does.
	const resumableThreads = new Map<string, BtwThreadState>();
	let nextThreadNumber = 1;

	const listResumeThreads = (): BtwResumeThreadSummary[] =>
		[...resumableThreads.values()]
			.reverse()
			.filter((state) => state.thread.turns.length > 0 && state.title)
			.sort(
				(first, second) => second.updatedAt - first.updatedAt || second.createdAt - first.createdAt,
			)
			.map((state) => ({
				id: state.id,
				title: state.title ?? "Untitled side thread",
				questionCount: state.thread.turns.length,
			}));

	pi.registerCommand("btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				notifySafely(ctx, "/btw requires interactive TUI mode", "error");
				return;
			}

			const settings = await loadSettings(ctx);
			const resolution = await resolveModel(settings, ctx);
			if (resolution.kind === "cancelled") {
				notifySafely(ctx, "Cancelled", "info");
				return;
			}
			if (resolution.kind === "unavailable") {
				notifySafely(ctx, "No available model for /btw", "error");
				return;
			}
			const selected = resolution.selected;

			// Turn counts of every resumable thread before the session opens, so
			// the registry only reorders a thread when the session added a turn.
			const turnCountsBefore = new Map(
				[...resumableThreads.values()].map((state) => [state.id, state.thread.turns.length]),
			);
			const sessionOptions: RunBtwSessionOptions = {
				ctx,
				createThreadState: () => {
					const createdAt = Date.now();
					return {
						id: `btw-${nextThreadNumber++}`,
						thread: createSideThread(buildConversationContext(ctx.sessionManager.getBranch())),
						thinkingLevel: settings.thinkingLevel ?? pi.getThinkingLevel(),
						createdAt,
						updatedAt: createdAt,
					};
				},
				completeTurn: (thread, turnQuestion, thinkingLevel, signal) =>
					completeSideThreadTurn({
						thread,
						model: selected.model,
						question: turnQuestion,
						thinkingLevel,
						auth: selected.auth,
						signal,
						completeSimple: createModelCompleteSimple(ctx.modelRegistry),
					}),
				getResumeThread: (id) => resumableThreads.get(id),
				resumeThreads: listResumeThreads(),
				settings,
				settingsPath: btwSettingsPath(),
				currentMainThinkingLevel: pi.getThinkingLevel(),
				modelThinkingLevels: getSupportedThinkingLevels(selected.model),
				initialThinkingLevel: clampThinkingLevel(
					selected.model,
					settings.thinkingLevel ?? pi.getThinkingLevel(),
				),
				initialQuestion: question || undefined,
			};
			try {
				const outcome = await runSession(sessionOptions);
				const threadState = outcome.threadState;
				if (threadState?.title && threadState.thread.turns.length > 0) {
					if (threadState.thread.turns.length > (turnCountsBefore.get(threadState.id) ?? 0)) {
						resumableThreads.delete(threadState.id);
					}
					resumableThreads.set(threadState.id, threadState);
				}
			} finally {
				// Session errors still surface through the command; nothing to clean up.
			}
		},
	});
}

async function loadSettingsForCommand(ctx: ExtensionCommandContext): Promise<BtwSettings> {
	const result = await readBtwSettings();
	if (result.kind === "loaded") return result.settings;
	if (result.kind === "invalid") {
		notifySafely(ctx, `pi-btw settings ignored: ${result.reason}`, "warning");
	}
	return {};
}

async function resolveBtwModelWithLoader(
	settings: BtwSettings,
	ctx: ExtensionCommandContext,
): Promise<ModelResolutionOutcome> {
	return ctx.ui.custom<ModelResolutionOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Resolving /btw model credentials...");
		let settled = false;
		loader.onAbort = () => {
			if (settled) return;
			settled = true;
			done({ kind: "cancelled" });
		};

		resolveBtwModel({
			settings,
			currentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			warn: (message) => {
				if (!settled) notifySafely(ctx, message, "warning");
			},
		})
			.then((selected) => {
				if (settled) return;
				settled = true;
				done(selected ? { kind: "selected", selected } : { kind: "unavailable" });
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				done({ kind: "unavailable" });
			});

		return loader;
	});
}

function notifySafely(
	ctx: ExtensionCommandContext,
	message: string,
	level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(sanitizeSingleLine(message), level);
	} catch {
		// Async command continuations may finish after the context is replaced.
	}
}