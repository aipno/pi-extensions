import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { shutdownManagedBrowser, syncManagedBrowserSettings } from "./browser-manager.ts";
import { setChromeDevtoolsSessionOwner } from "./lazy-tools.ts";
import { applyRuntimeBrowserSettings, state } from "./runtime.ts";
import {
	type BrowserSettingsPatch,
	type BrowserSettingsSource,
	loadSettings,
	parseBrowserEndpoint,
	type SettingsLoadResult,
	saveBrowserSettings,
} from "./settings.ts";
import { sanitizeChromeDevtoolsDisplay } from "./tool-selector.ts";

type BrowserSettingsScreen = "settings" | "endpoint" | "executable";
type BrowserSettingsAction =
	| "open-endpoint"
	| "save-endpoint"
	| "set-auto-launch"
	| "open-executable"
	| "save-executable";

interface BrowserSettingsMenuState {
	load: SettingsLoadResult;
}

type CommandContext = ExtensionCommandContext;

export async function showChromeDevtoolsBrowserSettings(
	pi: ExtensionAPI,
	ctx: CommandContext,
	generation: number,
): Promise<{ closeParent: boolean }> {
	setChromeDevtoolsSessionOwner(pi, ctx.sessionManager);
	const ownerSignal = state.sessionController.signal;
	const isCurrent = () => generation === state.sessionGeneration && !ownerSignal.aborted;
	const projectTrusted = ctx.isProjectTrusted();
	const menu = defineMenu<BrowserSettingsMenuState, BrowserSettingsScreen, BrowserSettingsAction>({
		start: "settings",
		screens: {
			settings: ({ state: current }) => {
				if (current.load.userFile.kind === "invalid") return invalidSettingsScreen(current.load);
				const browser = current.load.effectiveBrowser;
				return {
					kind: "settings",
					title: "Chrome DevTools Browser settings",
					lines: settingsContextLines(current.load),
					items: [
						{
							id: "endpoint",
							label: "DevTools endpoint",
							description:
								'HTTP origin with an explicit port; enter "default" to restore 127.0.0.1:9222.',
							currentValue: sanitizeChromeDevtoolsDisplay(browser.endpoint),
							action: "open-endpoint",
						},
						{
							id: "auto-launch",
							label: "Auto-launch",
							description:
								"Launch an isolated managed browser when a local endpoint is unavailable.",
							currentValue: browser.autoLaunchEnabled ? "On" : "Off",
							values: ["On", "Off"],
							action: "set-auto-launch",
						},
						{
							id: "executable",
							label: "Browser executable",
							description:
								'Absolute executable path; enter "automatic" to restore browser discovery.',
							currentValue: sanitizeChromeDevtoolsDisplay(browser.executablePath ?? "Automatic"),
							action: "open-executable",
						},
					],
				};
			},
			endpoint: ({ state: current }) => ({
				kind: "input",
				title: "DevTools endpoint",
				lines: [
					sanitizeChromeDevtoolsDisplay(
						`Current effective endpoint: ${current.load.effectiveBrowser.endpoint}`,
					),
					'Enter an HTTP origin with an explicit port, or "default".',
				],
				placeholder: "http://127.0.0.1:9222",
				action: "save-endpoint",
				hint: "back",
			}),
			executable: ({ state: current }) => ({
				kind: "input",
				title: "Browser executable",
				lines: [
					sanitizeChromeDevtoolsDisplay(
						`Current effective executable: ${current.load.effectiveBrowser.executablePath ?? "automatic discovery"}`,
					),
					'Enter an absolute path, or "automatic".',
				],
				placeholder: "absolute browser executable path",
				action: "save-executable",
				hint: "back",
			}),
		},
		actions: {
			"open-endpoint": () => ({ kind: "to", screen: "endpoint" }),
			"save-endpoint": async ({ value, signal }) => {
				if (value === undefined) return { kind: "rejected" };
				let endpoint: string | null;
				try {
					const trimmed = value.trim();
					endpoint =
						trimmed.toLowerCase() === "default" ? null : parseBrowserEndpoint(trimmed).endpoint;
				} catch (error) {
					notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
				const saved = await saveAndApplyBrowserPatch(
					ctx,
					generation,
					projectTrusted,
					signal,
					{ endpoint },
				);
				if (!saved) return { kind: "rejected" };
				notifyEffectiveSave(
					ctx,
					"endpoint",
					saved.effectiveBrowser.endpoint,
					saved.effectiveBrowser.endpointSource,
				);
				return { kind: "back" };
			},
			"set-auto-launch": async ({ value, signal }) => {
				if (value !== "On" && value !== "Off") return { kind: "rejected" };
				const saved = await saveAndApplyBrowserPatch(
					ctx,
					generation,
					projectTrusted,
					signal,
					{ autoLaunch: value === "On" },
				);
				if (!saved) return { kind: "rejected" };
				notifyEffectiveSave(
					ctx,
					"auto-launch",
					saved.effectiveBrowser.autoLaunchEnabled ? "On" : "Off",
					saved.effectiveBrowser.autoLaunchSource,
				);
				return { kind: "stay" };
			},
			"open-executable": () => ({ kind: "to", screen: "executable" }),
			"save-executable": async ({ value, signal }) => {
				if (value === undefined) return { kind: "rejected" };
				const trimmed = value.trim();
				const reset = ["automatic", "default", "none"].includes(trimmed.toLowerCase());
				if (!reset && (!trimmed || !isAbsolute(trimmed))) {
					notifySaveFailure(ctx, new Error('Enter an absolute path or "automatic".'));
					return { kind: "rejected" };
				}
				const executablePath = reset ? null : trimmed;
				const saved = await saveAndApplyBrowserPatch(
					ctx,
					generation,
					projectTrusted,
					signal,
					{ executablePath },
				);
				if (!saved) return { kind: "rejected" };
				notifyEffectiveSave(
					ctx,
					"browser executable",
					saved.effectiveBrowser.executablePath ?? "automatic discovery",
					saved.effectiveBrowser.executablePathSource,
				);
				return { kind: "back" };
			},
		},
	});
	const result = await runMenu(ctx, menu, {
		getState: async ({ signal }) => {
			signal.throwIfAborted();
			const load = await loadSettings({ cwd: ctx.cwd, projectTrusted });
			signal.throwIfAborted();
			return { load };
		},
		signal: ownerSignal,
		isCurrent,
		onError: (currentCtx, error) =>
			currentCtx.ui.notify(
				sanitizeChromeDevtoolsDisplay(
					`Chrome DevTools browser settings failed: ${formatError(error)}`,
				),
				"error",
			),
	});
	return { closeParent: result.kind === "closed" && result.reason === "close" };
}

async function saveAndApplyBrowserPatch(
	ctx: CommandContext,
	generation: number,
	projectTrusted: boolean,
	actionSignal: AbortSignal,
	patch: BrowserSettingsPatch,
) {
	try {
		await ctx.waitForIdle();
		if (!isCurrent(generation, actionSignal)) return false;
		await saveBrowserSettings(patch);
		if (!isCurrent(generation, actionSignal)) return false;
		await shutdownManagedBrowser(undefined, { owner: ctx.sessionManager });
		if (!isCurrent(generation, actionSignal)) return false;
		const loaded = await loadSettings({ cwd: ctx.cwd, projectTrusted });
		if (!isCurrent(generation, actionSignal)) return false;
		applyRuntimeBrowserSettings(loaded.effectiveBrowser, loaded.paths, projectTrusted);
		syncManagedBrowserSettings(ctx.sessionManager, loaded.effectiveBrowser);
		state.settingsNotice = loaded.notice;
		return loaded;
	} catch (error) {
		if (isCurrent(generation, actionSignal)) notifySaveFailure(ctx, error);
		return false;
	}
}

function isCurrent(generation: number, actionSignal: AbortSignal) {
	return generation === state.sessionGeneration && !actionSignal.aborted;
}

function invalidSettingsScreen(load: SettingsLoadResult) {
	const reason =
		load.userFile.kind === "invalid"
			? load.userFile.reason
			: "The user settings file is unavailable.";
	return {
		kind: "detail" as const,
		title: "Chrome DevTools Browser settings · Read only",
		lines: [
			sanitizeChromeDevtoolsDisplay(
				`Fix the active user settings before saving; the file will not be overwritten. ${reason}`,
			),
		],
		hint: "back" as const,
	};
}

function settingsContextLines(load: SettingsLoadResult) {
	const browser = load.effectiveBrowser;
	return [
		`User settings · ${load.paths.user}`,
		`Effective sources: endpoint ${browser.endpointSource} · auto-launch ${browser.autoLaunchSource} · executable ${browser.executablePathSource}`,
		...(load.notice ? [`Warning: ${load.notice}`] : []),
	].map((line) => sanitizeChromeDevtoolsDisplay(line));
}

function notifyEffectiveSave(
	ctx: CommandContext,
	setting: string,
	effectiveValue: string,
	source: BrowserSettingsSource,
) {
	const overrideNotice =
		source === "environment" ? " The deprecated environment override remains effective." : "";
	ctx.ui.notify(
		sanitizeChromeDevtoolsDisplay(
			`Chrome DevTools ${setting} saved. Effective ${setting}: ${effectiveValue} (${source}).${overrideNotice}`,
		),
		"info",
	);
}

function notifySaveFailure(ctx: CommandContext, error: unknown) {
	ctx.ui.notify(
		sanitizeChromeDevtoolsDisplay(
			`Chrome DevTools browser settings save failed; previous settings remain active: ${formatError(error)}`,
		),
		"warning",
	);
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}