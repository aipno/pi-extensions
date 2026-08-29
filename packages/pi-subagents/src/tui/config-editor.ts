/**
 * Interactive config editor for /subagents-config.
 *
 * Mirrors the built-in /settings UX: a focused SettingsList where the arrow
 * keys move the cursor and Enter/Space cycle through the allowed values for
 * the selected key. Every change is applied immediately (persisted to the
 * config file and hot-applied to the in-memory config).
 *
 * The defaultModel key opens a model picker submenu (SelectList) populated
 * from the session's available models; "inherit" restores the parent-model
 * inheritance behavior.
 */

import type { ExtensionUIContext, ModelRegistry, ScopedModel } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	SettingsList,
	type SettingItem,
	type SettingsListTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { applyConfigUpdates, type SubagentConfig } from "../extension/config.ts";
import { DEFAULT_FORK_MAX_TURNS } from "../runs/fork-context.ts";

/** Sentinel value meaning "no override, inherit the parent session's model". */
const INHERIT_MODEL_VALUE = "inherit";

export interface ModelOption {
	provider: string;
	id: string;
	name: string;
}

/**
 * Collect the models the user can pick from: the session-scoped catalogue
 * first, falling back to the registry's available models when no scoping is
 * configured. Deduplicated by provider/id.
 */
export async function modelsFromContext(
	scopedModels: readonly ScopedModel[],
	registry: ModelRegistry,
): Promise<ModelOption[]> {
	const seen = new Set<string>();
	const out: ModelOption[] = [];
	const push = (model: { provider: string; id: string; name: string }): void => {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ provider: model.provider, id: model.id, name: model.name });
	};
	for (const scoped of scopedModels) push(scoped.model);
	if (out.length === 0) {
		try {
			for (const model of await registry.getAvailable()) push(model);
		} catch {
			// Registry unavailable (e.g. offline refresh): picker shows inherit only.
		}
	}
	return out;
}

const TIMEOUT_DISPLAYS = ["unset", "1 min", "5 min", "10 min", "30 min", "1 hour"] as const;
const TIMEOUT_MS_BY_DISPLAY: Record<string, number | undefined> = {
	unset: undefined,
	"1 min": 60_000,
	"5 min": 300_000,
	"10 min": 600_000,
	"30 min": 1_800_000,
	"1 hour": 3_600_000,
};

function timeoutDisplayFromMs(ms: number | undefined): string {
	if (ms === undefined) return "unset";
	for (const display of TIMEOUT_DISPLAYS) {
		if (TIMEOUT_MS_BY_DISPLAY[display] === ms) return display;
	}
	// A custom value not in the presets: show it raw (Enter cycles to "unset").
	return String(ms);
}

function defaultModelDisplay(model: string | undefined): string {
	return model ?? `${INHERIT_MODEL_VALUE} (parent session)`;
}

function buildItems(config: SubagentConfig, models: ModelOption[], theme: ThemeLike): SettingItem[] {
	return [
		{
			id: "asyncByDefault",
			label: "asyncByDefault",
			description: "Spawn background children by default; pass async:false to stream progress in the current conversation.",
			currentValue: String(config.asyncByDefault),
			values: ["true", "false"],
		},
		{
			id: "defaultModel",
			label: "defaultModel",
			description:
				"Default model for subagent children. Enter opens the model picker; \"inherit (parent session)\" uses the parent session's current model.",
			currentValue: defaultModelDisplay(config.defaultModel),
			submenu: (_currentValue, done) => buildModelSubmenu(theme, config, models, done),
		},
		{
			id: "defaultTimeoutMs",
			label: "defaultTimeoutMs",
			description: "Default timeout for foreground runs. Enter/Space cycles presets; unset means no timeout.",
			currentValue: timeoutDisplayFromMs(config.defaultTimeoutMs),
			values: [...TIMEOUT_DISPLAYS],
		},
		{
			id: "maxSubagentDepth",
			label: "maxSubagentDepth",
			description: "Maximum nesting depth for subagent-of-subagent runs.",
			currentValue: String(config.maxSubagentDepth ?? 8),
			values: ["2", "4", "6", "8", "10", "12"],
		},
		{
			id: "runsRetentionDays",
			label: "runsRetentionDays",
			description: "How many days background run artifacts are kept.",
			currentValue: String(config.runsRetentionDays ?? 7),
			values: ["1", "2", "3", "7", "14", "30"],
		},
		{
			id: "forkContext.maxTurns",
			label: "forkContext.maxTurns",
			description: "Assistant turns kept in a pruned fork for agents whose defaultContext is \"fork\".",
			currentValue: String(config.forkContext?.maxTurns ?? DEFAULT_FORK_MAX_TURNS),
			values: ["4", "6", "8", "12", "16", "20"],
		},
	];
}

function applyChange(config: SubagentConfig, id: string, displayValue: string): string | null {
	const updates: Partial<SubagentConfig> = {};
	switch (id) {
		case "asyncByDefault":
			updates.asyncByDefault = displayValue === "true";
			break;
		case "defaultModel":
			// "inherit" maps to undefined, which removes the stored override.
			updates.defaultModel = displayValue === INHERIT_MODEL_VALUE ? undefined : displayValue;
			break;
		case "defaultTimeoutMs":
			// "unset" maps to undefined, which removes the stored key.
			updates.defaultTimeoutMs = TIMEOUT_MS_BY_DISPLAY[displayValue];
			break;
		case "maxSubagentDepth":
			updates.maxSubagentDepth = Number(displayValue);
			break;
		case "runsRetentionDays":
			updates.runsRetentionDays = Number(displayValue);
			break;
		case "forkContext.maxTurns":
			updates.forkContext = { mode: "pruned", maxTurns: Number(displayValue) };
			break;
		default:
			return `Unknown config key "${id}"`;
	}
	return applyConfigUpdates(config, updates);
}

/** Display string to show after a change (pickered values need reformatting). */
function displayAfterChange(id: string, displayValue: string, config: SubagentConfig): string {
	return id === "defaultModel" ? defaultModelDisplay(config.defaultModel) : displayValue;
}

function buildModelSubmenu(
	theme: ThemeLike,
	config: SubagentConfig,
	models: ModelOption[],
	done: (selectedValue?: string) => void,
): Component {
	const container = new Container();
	container.addChild(new Text(theme.bold(theme.fg("accent", "Default subagent model")), 0, 0));
	container.addChild(new Spacer(1));
	const options: SelectItem[] = [
		{
			value: INHERIT_MODEL_VALUE,
			label: `${INHERIT_MODEL_VALUE} (parent session)`,
			description: "Each subagent uses the parent session's current model.",
		},
		...models.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: model.id,
			description: `${model.name} · ${model.provider}`,
		})),
	];
	const selectList = new SelectList(options, Math.min(options.length, 10), selectListTheme(theme));
	const preselect = options.findIndex((option) => option.value === (config.defaultModel ?? INHERIT_MODEL_VALUE));
	selectList.setSelectedIndex(preselect >= 0 ? preselect : 0);
	selectList.onSelect = (item) => done(item.value);
	selectList.onCancel = () => done(undefined);
	container.addChild(selectList);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	// The SettingsList delegates keyboard input to this component while the
	// submenu is open; without handleInput every key (including Esc) would
	// be silently dropped and the editor would appear frozen.
	return {
		render: (width) => container.render(width),
		handleInput: (data) => {
			selectList.handleInput(data);
		},
		invalidate: () => {
			container.invalidate();
			selectList.invalidate();
		},
	};
}

/** Minimal structural slice of the pi theme used by the editor. */
type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

function settingsListTheme(theme: ThemeLike): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

function selectListTheme(theme: ThemeLike): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

/**
 * Open the full-screen config editor. Resolves when the user closes it
 * (Esc). Every modified key is persisted and hot-applied immediately.
 */
export async function openConfigEditor(
	ui: ExtensionUIContext,
	config: SubagentConfig,
	models: ModelOption[],
): Promise<void> {
	await ui.custom<null>((tui, theme, _keybindings, done) => {
		const settingsList = new SettingsList(buildItems(config, models, theme), 6, settingsListTheme(theme), (id, displayValue) => {
			const error = applyChange(config, id, displayValue);
			if (error) {
				ui.notify(error, "error");
				return;
			}
			settingsList.updateValue(id, displayAfterChange(id, displayValue, config));
			tui.requestRender();
		}, () => done(null));

		return {
			render: (width) => {
				const lines = settingsList.render(width);
				const title = theme.bold("Subagent config");
				return [title, "", ...lines];
			},
			handleInput: (data) => {
				settingsList.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => settingsList.invalidate(),
		};
	});
}