/**
 * /tui-style 配置面板 UI。
 *
 * 渲染副作用（applyStyleMode / refreshCurrentTranscript）由 renderer 经
 * CcstylePanelHooks 注入，避免 config → renderer 循环依赖。
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Input, SettingsList, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { CompactThinkingController } from "../feature/compact-thinking.ts";
import { applyFooter } from "../feature/footer.ts";
import { applyStartupHeader } from "../feature/shell/startup-header.ts";
import type { ToolGroupingHooks } from "../renderer/tool/grouping.ts";
import { t } from "../utils/i18n.ts";
import { bindingKeys } from "../utils/key-hint.ts";
import {
	config,
	CONFIG_LANGUAGES,
	DEFAULT_CONFIG,
	DIFF_COLLAPSED_LINES_VALUES,
	DIFF_EMPHASIS_STYLES,
	DIFF_INDENT_GUIDE_MODES,
	DIFF_INDICATOR_MODES,
	DIFF_SPLIT_MIN_WIDTH_VALUES,
	DIFF_VIEW_MODES,
	EXCLUDE_RENDERER_CANDIDATES,
	EXPANDED_PREVIEW_MAX_LINES_VALUES,
	formatExcludeRenderers,
	getCompactThinkingConfig,
	pickPositiveInt,
	pickPositiveNumber,
	SCROLL_STEP_LINES_VALUES,
	THINKING_ANIMATION_INTERVAL_VALUES,
	THINKING_PREVIEW_LINES_VALUES,
	TOOL_INPUT_NAME_LENGTH_VALUES,
	WRITE_DIFF_COLLAPSED_LINES_VALUES,
	updateConfig,
	type CompactStyleMode,
	type Config,
	type DiffEmphasisStyle,
	type DiffIndicatorMode,
	type DiffIndentGuideMode,
	type DiffViewMode,
} from "./config.ts";

/** renderer 注入的渲染副作用，面板自身不触碰渲染状态。 */
export type CcstylePanelHooks = {
	applyStyleMode: (mode: CompactStyleMode, ctx: any, toolGrouping?: ToolGroupingHooks) => void;
	refreshCurrentTranscript: (ctx?: any, toolGrouping?: ToolGroupingHooks) => void;
};

function modeSettingDescription(mode: CompactStyleMode): string {
	if (mode === "compact") {
		return t(
			"panel.mode.desc.compact",
			"(Experimental) One summary line per assistant round; edit/write reuse the same Diff preview settings as on.",
		);
	}
	if (mode === "off") {
		return t(
			"panel.mode.desc.off",
			"Pi native tool rendering. Diff options below still apply independently.",
		);
	}
	return t(
		"panel.mode.desc.on",
		"Pi TUI style with rich edit/write diffs. Tune diff options below.",
	);
}

function excludeRenderersDescription(names: readonly string[]): string {
	return names.length === 0
		? t(
				"panel.exclude.desc.none",
				"No tools excluded. Agent always keeps its dedicated renderer. Enter to toggle common tools.",
			)
		: t(
				"panel.exclude.desc.some",
				"Native renderer for: {names}. Agent is always native. Enter to toggle.",
				{ names: names.join(", ") },
			);
}

function diffViewModeDescription(mode: DiffViewMode): string {
	if (mode === "split") {
		return t("panel.diffView.desc.split", "Force side-by-side diff when width allows; otherwise unified.");
	}
	if (mode === "unified") {
		return t("panel.diffView.desc.unified", "Always render a single unified diff column.");
	}
	return t("panel.diffView.desc.auto", "Auto: split when terminal is wide enough, otherwise unified.");
}

function diffIndicatorDescription(mode: DiffIndicatorMode): string {
	if (mode === "classic") {
		return t("panel.diffIndicator.desc.classic", "Classic +/- gutters on changed lines.");
	}
	if (mode === "none") {
		return t("panel.diffIndicator.desc.none", "No change indicators; rely on color alone.");
	}
	return t("panel.diffIndicator.desc.bars", "Vertical bar indicators on changed lines (default).");
}

function diffIndentGuideDescription(mode: DiffIndentGuideMode): string {
	if (mode === "dots") {
		return t(
			"panel.diffIndent.desc.dots",
			"Visualize leading indentation as dim dots (·) up to 16 columns deep; inline alignment is untouched.",
		);
	}
	return t("panel.diffIndent.desc.off", "Keep leading indentation as plain spaces.");
}

function diffEmphasisStyleDescription(style: DiffEmphasisStyle): string {
	if (style === "inverse") {
		return t(
			"panel.diffEmphasis.desc.inverse",
			"Reverse-video (SGR 7) for changed segments — position stays visible regardless of terminal palette.",
		);
	}
	return t(
		"panel.diffEmphasis.desc.bg",
		"Blended background tint for changed segments (default, works on every terminal).",
	);
}

/** 额外功能开关项：on/off 二值，描述随状态切换；切换后需重启生效。 */
function featureToggleSetting(
	id: string,
	label: string,
	onDescription: string,
	offDescription: string,
	current: boolean,
) {
	const setting = {
		id,
		label,
		description: current ? onDescription : offDescription,
		currentValue: current ? "on" : "off",
		values: ["on", "off"],
	};
	return {
		setting,
		apply(on: boolean): void {
			setting.currentValue = on ? "on" : "off";
			setting.description = on ? onDescription : offDescription;
		},
	};
}

function buildExcludeRenderersSubmenu(
	onClose: () => void,
	onLiveChange: () => void,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const candidates = [
		...new Set([...EXCLUDE_RENDERER_CANDIDATES, ...config.excludeRenderers]),
	].sort((a, b) => a.localeCompare(b));
	const items = candidates.map((name) => ({
		id: name,
		label: name,
		description:
			name === "Agent"
				? t(
						"panel.exclude.agent.desc",
						"Agent always uses its dedicated renderer and cannot be forced through pi-tui.",
					)
				: t("panel.exclude.item.desc", "Use Pi native renderer for {name} instead of Pi TUI styling.", {
						name,
					}),
		currentValue: config.excludeRenderers.includes(name) ? "exclude" : "style",
		values: ["style", "exclude"],
	}));
	const list = new SettingsList(
		items,
		Math.min(8, Math.max(4, items.length)),
		getSettingsListTheme(),
		(id: string, value: string) => {
			const excluded = new Set(config.excludeRenderers);
			if (value === "exclude") excluded.add(id);
			else excluded.delete(id);
			updateConfig({ excludeRenderers: [...excluded].sort((a, b) => a.localeCompare(b)) });
			onLiveChange();
		},
		() => onClose(),
		{ enableSearch: candidates.length > 8 },
	);
	return {
		render: (width: number) => [
			...list.render(width),
			"",
			// Extra hint: Esc returns to the Style section list.
			truncateToWidth(t("panel.exclude.submenu.hint", "  Esc back to Style settings"), width),
		],
		invalidate: () => list.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
	};
}

/** 数值项手动输入子面板：预填当前值，Space 循环预设，输入数字自定义，Enter 应用，Esc 取消。 */
function buildNumberInputSubmenu(
	theme: any,
	setting: { label: string; values: readonly string[]; currentValue: string },
	closeSubmenu: (selected?: string) => void,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const input = new Input();
	let error = "";
	input.setValue(setting.currentValue);
	input.onSubmit = (value: string) => {
		const raw = value.trim();
		if (raw === "") {
			closeSubmenu(); // 空输入 = 取消
			return;
		}
		if (!Number.isFinite(Number(raw))) {
			error = t("panel.number.invalid", 'Invalid number: "{raw}"', { raw });
			return;
		}
		closeSubmenu(raw);
	};
	input.onEscape = () => closeSubmenu();
	return {
		render: (width: number) => {
			const safe = Math.max(0, Math.floor(width));
			const lines = [
				theme.fg(
					"dim",
					t("panel.number.custom.label", "  {label} — custom value:", { label: setting.label }),
				),
				...input.render(safe),
				// 键位提示从 keybindings manager 取（与面板 footer 同一来源）。
				truncateToWidth(
					theme.fg(
						"dim",
						`  ${bindingKeys("tui.select.confirm", "enter")} to apply · ${bindingKeys("tui.select.cancel", "esc")} to go back`,
					),
					safe,
				),
			];
			if (error !== "") lines.push(theme.fg("dim", `  ${error}`));
			return lines;
		},
		invalidate: () => {},
		handleInput: (data: string) => input.handleInput(data),
	};
}

/** Section tabs for /tui-style — matches Zentui-style "A / B / C" headers. */
type CcstyleSection = {
	id: "style" | "diff" | "thinking" | "ui" | "feature";
	label: string;
	items: any[];
};

function isForwardTabKey(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isBackTabKey(data: string): boolean {
	// CSI Z is the common terminal encoding for Shift+Tab.
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

function renderPanelRule(theme: any, width: number): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function renderSectionTabBar(
	theme: any,
	sections: readonly { label: string }[],
	activeIndex: number,
	width: number,
): string {
	const pieces: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (i > 0) pieces.push(theme.fg("dim", " / "));
		const label = sections[i]?.label ?? "";
		pieces.push(
			i === activeIndex
				? theme.fg("text", typeof theme.bold === "function" ? theme.bold(label) : label)
				: theme.fg("dim", label),
		);
	}
	return truncateToWidth(pieces.join(""), Math.max(0, width));
}

export async function showCcstylePanel(
	ctx: any,
	hooks: CcstylePanelHooks,
	toolGrouping?: ToolGroupingHooks,
	compactThinking?: CompactThinkingController,
): Promise<void> {
	if (ctx?.mode !== "tui" || !ctx?.hasUI || typeof ctx.ui?.custom !== "function") {
		ctx.ui?.notify?.("/tui-style requires TUI mode", "warning");
		return;
	}

	await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
		const modeSetting = {
			id: "mode",
			label: t("panel.mode.label", "Mode"),
			description: modeSettingDescription(config.mode),
			currentValue: config.mode === "compact" ? "compact (Experimental)" : config.mode,
			values: ["on", "compact (Experimental)", "off"],
		};
		// Tracks whether the Exclude-tools submenu is open so Tab switches sections
		// only at the top level (mirrors Zentui settings: Tab = switch sections).
		let excludeSubmenuOpen = false;
		const excludeSetting = {
			id: "excludeRenderers",
			label: t("panel.exclude.label", "Exclude tools"),
			description: excludeRenderersDescription(config.excludeRenderers),
			currentValue: formatExcludeRenderers(config.excludeRenderers),
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) => {
				excludeSubmenuOpen = true;
				return buildExcludeRenderersSubmenu(
					() => {
						excludeSubmenuOpen = false;
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						closeSubmenu();
					},
					() => {
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						hooks.refreshCurrentTranscript(ctx);
					},
				);
			},
		};
		const toolInputNameSetting = {
			id: "toolInputNameLength",
			label: t("panel.toolInput.label", "Input clip"),
			description: t(
				"panel.toolInput.desc",
				"Max characters for path/command/name in single and grouped tool summaries. Enter to type a custom value.",
			),
			currentValue: String(config.toolInputNameLength),
			values: [...TOOL_INPUT_NAME_LENGTH_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, toolInputNameSetting, closeSubmenu),
		};
		const diffViewSetting = {
			id: "diffViewMode",
			label: t("panel.diffView.label", "Diff layout"),
			description: diffViewModeDescription(config.diffViewMode),
			currentValue: config.diffViewMode,
			values: [...DIFF_VIEW_MODES],
		};
		const diffIndicatorSetting = {
			id: "diffIndicatorMode",
			label: t("panel.diffIndicator.label", "Diff indicator"),
			description: diffIndicatorDescription(config.diffIndicatorMode),
			currentValue: config.diffIndicatorMode,
			values: [...DIFF_INDICATOR_MODES],
		};
		const diffIndentGuideSetting = {
			id: "diffIndentGuide",
			label: t("panel.diffIndent.label", "Indent guide"),
			description: diffIndentGuideDescription(config.diffIndentGuide),
			currentValue: config.diffIndentGuide,
			values: [...DIFF_INDENT_GUIDE_MODES],
		};
		const diffEmphasisStyleSetting = {
			id: "diffEmphasisStyle",
			label: t("panel.diffEmphasis.label", "Segment emphasis"),
			description: diffEmphasisStyleDescription(config.diffEmphasisStyle),
			currentValue: config.diffEmphasisStyle,
			values: [...DIFF_EMPHASIS_STYLES],
		};
		const diffSplitSetting = {
			id: "diffSplitMinWidth",
			label: t("panel.diffSplit.label", "Split min width"),
			description: t(
				"panel.diffSplit.desc",
				"Minimum terminal width before auto/split layout uses side-by-side columns. Enter to type a custom value.",
			),
			currentValue: String(config.diffSplitMinWidth),
			values: [...DIFF_SPLIT_MIN_WIDTH_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, diffSplitSetting, closeSubmenu),
		};
		const diffCollapsedSetting = {
			id: "editDiffCollapsedLines",
			label: t("panel.editCollapsed.label", "Edit collapsed lines"),
			description: t(
				"panel.editCollapsed.desc",
				"How many edit/diff body lines to show before the expand hint (Ctrl+O / click). Write uses its own setting below.",
			),
			currentValue: String(config.editDiffCollapsedLines),
			values: [...DIFF_COLLAPSED_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, diffCollapsedSetting, closeSubmenu),
		};
		const writeDiffCollapsedSetting = {
			id: "writeDiffCollapsedLines",
			label: t("panel.writeCollapsed.label", "Write collapsed lines"),
			description: t(
				"panel.writeCollapsed.desc",
				"Write-only collapsed body lines. 0 shows ↳ created + expand hint (stats stay on the title). Enter to type a custom value.",
			),
			currentValue: String(config.writeDiffCollapsedLines),
			values: [...WRITE_DIFF_COLLAPSED_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, writeDiffCollapsedSetting, closeSubmenu),
		};
		const diffWordWrapSetting = {
			id: "diffWordWrap",
			label: t("panel.wordWrap.label", "Diff word wrap"),
			description: config.diffWordWrap
				? t("panel.wordWrap.desc.on", "Long diff lines wrap within the panel width.")
				: t("panel.wordWrap.desc.off", "Long diff lines are truncated to the panel width."),
			currentValue: config.diffWordWrap ? "on" : "off",
			values: ["on", "off"],
		};
		const expandedMaxSetting = {
			id: "expandedPreviewMaxLines",
			label: t("panel.expandedMax.label", "Expanded max lines"),
			description: t(
				"panel.expandedMax.desc",
				"Max Output/diff body lines when expanded. Default 40 keeps the TUI compact; raise for large dumps.",
			),
			currentValue: String(config.expandedPreviewMaxLines),
			values: [...EXPANDED_PREVIEW_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, expandedMaxSetting, closeSubmenu),
		};
		const thinkingTitleSetting = {
			id: "useSummaryTitlesAsThinkingTitle",
			label: t("panel.thinkingTitle.label", "Summary title"),
			description: t(
				"panel.thinkingTitle.desc",
				"Use the latest provider summary as the active thinking title.",
			),
			currentValue: config.useSummaryTitlesAsThinkingTitle ? "on" : "off",
			values: ["on", "off"],
		};
		const thinkingPreviewSetting = {
			id: "previewLines",
			label: t("panel.previewLines.label", "Preview lines"),
			description: t("panel.previewLines.desc", "Thinking preview lines; 0 hides the preview body."),
			currentValue: String(config.previewLines),
			values: [...THINKING_PREVIEW_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, thinkingPreviewSetting, closeSubmenu),
		};
		const thinkingAnimationSetting = {
			id: "animationIntervalMs",
			label: t("panel.animation.label", "Animation interval ms"),
			description: t(
				"panel.animation.desc",
				"Thinking title animation interval for the next thinking run.",
			),
			currentValue: String(config.animationIntervalMs),
			values: [...THINKING_ANIMATION_INTERVAL_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, thinkingAnimationSetting, closeSubmenu),
		};
		const thinkingDimSetting = {
			id: "dimThinkingText",
			label: t("panel.dimThinking.label", "Dim thinking text"),
			description: config.dimThinkingText
				? t("panel.dimThinking.desc.on", "Thinking text uses the theme's dim color.")
				: t("panel.dimThinking.desc.off", "Keep the default thinking text color."),
			currentValue: config.dimThinkingText ? "on" : "off",
			values: ["on", "off"],
		};
		const startupHeaderSetting = {
			id: "showStartupHeader",
			label: t("panel.startupHeader.label", "Startup header"),
			description: config.showStartupHeader
				? t(
						"panel.startupHeader.desc.on",
						"Show the boxed animated logo header (model/cwd + command tips) on new sessions.",
					)
				: t("panel.startupHeader.desc.off", "Use Pi's native startup header instead."),
			currentValue: config.showStartupHeader ? "on" : "off",
			values: ["on", "off"],
		};
		const footerSetting = {
			id: "enableCustomFooter",
			label: t("panel.feature.footer.label", "Custom footer"),
			description: config.enableCustomFooter
				? t(
						"panel.feature.footer.desc.on",
						"Replace Pi's built-in footer with the status line: model · thinking | context progress; cwd | branch | MCP | CH | cost. Applies immediately.",
					)
				: t("panel.feature.footer.desc.off", "Use Pi's native footer."),
			currentValue: config.enableCustomFooter ? "on" : "off",
			values: ["on", "off"],
		};
		const scrollStepSetting = {
			id: "scrollStepLines",
			label: t("panel.scrollStep.label", "Scroll step"),
			description: t("panel.scrollStep.desc", "Mouse wheel scroll lines in fullscreen mode."),
			currentValue: String(config.scrollStepLines),
			values: [...SCROLL_STEP_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, scrollStepSetting, closeSubmenu),
		};

		// 语言设置：切换立即生效（与重启生效的 toggle 类不同），渲染时读 config。
		const languageSetting = {
			id: "language",
			label: t("panel.language.label", "Language"),
			description: t(
				"panel.language.desc",
				"UI text language: en (English) or zh (中文). Applies immediately.",
			),
			currentValue: config.language,
			values: [...CONFIG_LANGUAGES],
		};

		// 额外功能开关：注册于扩展加载期，切换后需重启（/reload）生效。
		const contextCommandToggle = featureToggleSetting(
			"enableContextCommand",
			t("panel.feature.contextCommand.label", "Context usage"),
			t(
				"panel.feature.contextCommand.desc.on",
				"/context shows context-window distribution with previews. Next restart applies.",
			),
			t("panel.feature.contextCommand.desc.off", "Context command disabled."),
			config.enableContextCommand,
		);
		const agentSummaryToggle = featureToggleSetting(
			"enableAgentSummary",
			t("panel.feature.agentSummary.label", "Agent summary"),
			t(
				"panel.feature.agentSummary.desc.on",
				"Append per-round tool stats after each agent turn. Next restart applies.",
			),
			t("panel.feature.agentSummary.desc.off", "Agent summary disabled."),
			config.enableAgentSummary,
		);
		const workingMessageToggle = featureToggleSetting(
			"enableWorkingMessage",
			t("panel.feature.workingMessage.label", "Working message"),
			t(
				"panel.feature.workingMessage.desc.on",
				"Extend Working... footer with token count and elapsed time. Next restart applies.",
			),
			t("panel.feature.workingMessage.desc.off", "Native Working... footer only."),
			config.enableWorkingMessage,
		);
		const aliasesToggle = featureToggleSetting(
			"enableAliases",
			t("panel.feature.aliases.label", "Aliases"),
			t("panel.feature.aliases.desc.on", "/clear and /exit aliases enabled. Next restart applies."),
			t("panel.feature.aliases.desc.off", "Aliases disabled."),
			config.enableAliases,
		);
		const featureToggles: Record<string, { apply: (on: boolean) => void }> = {
			enableContextCommand: contextCommandToggle,
			enableAgentSummary: agentSummaryToggle,
			enableWorkingMessage: workingMessageToggle,
			enableAliases: aliasesToggle,
		};

		const onSettingChange = (id: string, value: string) => {
			// 额外功能开关：字段名与配置布尔字段一一对应，切换后重启生效。
			const featureToggle = featureToggles[id];
			if (featureToggle) {
				updateConfig({ [id]: value === "on" } as Partial<Config>);
				featureToggle.apply(value === "on");
				ctx.ui.notify(
					t("panel.updated.restart", "Updated {id}: {value} (next restart)", { id, value }),
					"info",
				);
				return;
			}
			switch (id) {
				case "toolInputNameLength":
					updateConfig({
						toolInputNameLength: pickPositiveInt(value, DEFAULT_CONFIG.toolInputNameLength, 8, 500),
					});
					toolInputNameSetting.currentValue = String(config.toolInputNameLength);
					break;
				case "mode": {
					// 选项值带 Experimental 标记，选择后还原为真实 mode 值。
					const mode: CompactStyleMode =
						value === "compact (Experimental)" ? "compact" : (value as CompactStyleMode);
					modeSetting.description = modeSettingDescription(mode);
					hooks.applyStyleMode(mode, ctx, toolGrouping);
					return;
				}
				case "excludeRenderers":
					excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
					excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
					return;
				case "diffViewMode":
					updateConfig({ diffViewMode: value as DiffViewMode });
					diffViewSetting.description = diffViewModeDescription(config.diffViewMode);
					break;
				case "diffIndicatorMode":
					updateConfig({ diffIndicatorMode: value as DiffIndicatorMode });
					diffIndicatorSetting.description = diffIndicatorDescription(config.diffIndicatorMode);
					break;
				case "diffIndentGuide":
					updateConfig({ diffIndentGuide: value as DiffIndentGuideMode });
					diffIndentGuideSetting.description = diffIndentGuideDescription(config.diffIndentGuide);
					break;
				case "diffEmphasisStyle":
					updateConfig({ diffEmphasisStyle: value as DiffEmphasisStyle });
					diffEmphasisStyleSetting.description = diffEmphasisStyleDescription(
						config.diffEmphasisStyle,
					);
					break;
				case "diffSplitMinWidth":
					updateConfig({
						diffSplitMinWidth: pickPositiveInt(value, DEFAULT_CONFIG.diffSplitMinWidth, 40, 300),
					});
					diffSplitSetting.currentValue = String(config.diffSplitMinWidth);
					break;
				case "editDiffCollapsedLines":
					updateConfig({
						editDiffCollapsedLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.editDiffCollapsedLines,
							1,
							500,
						),
					});
					diffCollapsedSetting.currentValue = String(config.editDiffCollapsedLines);
					break;
				case "writeDiffCollapsedLines":
					updateConfig({
						writeDiffCollapsedLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.writeDiffCollapsedLines,
							0,
							500,
						),
					});
					writeDiffCollapsedSetting.currentValue = String(config.writeDiffCollapsedLines);
					break;
				case "diffWordWrap":
					updateConfig({ diffWordWrap: value === "on" });
					diffWordWrapSetting.description = config.diffWordWrap
						? "Long diff lines wrap within the panel width."
						: "Long diff lines are truncated to the panel width.";
					break;
				case "expandedPreviewMaxLines":
					updateConfig({
						expandedPreviewMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.expandedPreviewMaxLines,
							10,
							50_000,
						),
					});
					expandedMaxSetting.currentValue = String(config.expandedPreviewMaxLines);
					break;
				case "useSummaryTitlesAsThinkingTitle":
					updateConfig({ useSummaryTitlesAsThinkingTitle: value === "on" });
					break;
				case "previewLines":
					updateConfig({ previewLines: pickPositiveInt(value, DEFAULT_CONFIG.previewLines, 0) });
					thinkingPreviewSetting.currentValue = String(config.previewLines);
					break;
				case "animationIntervalMs":
					updateConfig({
						animationIntervalMs: pickPositiveNumber(value, DEFAULT_CONFIG.animationIntervalMs),
					});
					thinkingAnimationSetting.currentValue = String(config.animationIntervalMs);
					break;
				case "dimThinkingText":
					updateConfig({ dimThinkingText: value === "on" });
					thinkingDimSetting.description = config.dimThinkingText
						? "Thinking text uses the theme's dim color."
						: "Keep the default thinking text color.";
					break;
				case "showStartupHeader":
					updateConfig({ showStartupHeader: value === "on" });
					startupHeaderSetting.description = config.showStartupHeader
						? "Show the boxed animated logo header (model/cwd + command tips) on new sessions."
						: "Use Pi's native startup header instead.";
					// 实时切换：on → 自定义 header；off → 官方默认 header。
					applyStartupHeader(ctx);
					break;
				case "enableCustomFooter":
					updateConfig({ enableCustomFooter: value === "on" });
					footerSetting.description = config.enableCustomFooter
						? "Replace Pi's built-in footer with the status line: model · thinking | context progress; cwd | branch | MCP | CH | cost. Applies immediately."
						: "Use Pi's native footer.";
					// 实时切换：on → 自定义 footer；off → 官方默认 footer。
					applyFooter(ctx);
					break;
				case "scrollStepLines":
					updateConfig({
						scrollStepLines: pickPositiveInt(value, DEFAULT_CONFIG.scrollStepLines, 1, 50),
					});
					scrollStepSetting.currentValue = String(config.scrollStepLines);
					break;
				case "language":
					// 即时生效：languageSetting 渲染时已读取 config；其它面板文案下次打开面板更新。
					updateConfig({ language: value === "zh" ? "zh" : "en" });
					languageSetting.currentValue = config.language;
					break;
				default:
					return;
			}
			compactThinking?.updateConfig(getCompactThinkingConfig());
			hooks.refreshCurrentTranscript(ctx);
			ctx.ui.notify(t("panel.updated", "Updated {id}: {value}", { id, value }), "info");
		};

		const sections: CcstyleSection[] = [
			{
				id: "style",
				label: t("panel.section.style", "Style"),
				items: [modeSetting, excludeSetting],
			},
			{
				id: "diff",
				label: t("panel.section.diff", "Diff"),
				items: [
					diffViewSetting,
					diffIndicatorSetting,
					diffIndentGuideSetting,
					diffEmphasisStyleSetting,
					diffSplitSetting,
					diffCollapsedSetting,
					writeDiffCollapsedSetting,
					diffWordWrapSetting,
					expandedMaxSetting,
					toolInputNameSetting,
				],
			},
			{
				id: "thinking",
				label: t("panel.section.thinking", "Thinking"),
				items: [
					thinkingTitleSetting,
					thinkingPreviewSetting,
					thinkingAnimationSetting,
					thinkingDimSetting,
				],
			},
			{
				id: "ui",
				label: t("panel.section.ui", "UI"),
				items: [languageSetting, startupHeaderSetting, footerSetting, scrollStepSetting],
			},
			{
				id: "feature",
				label: t("panel.section.feature", "Feature"),
				items: [
					contextCommandToggle.setting,
					agentSummaryToggle.setting,
					workingMessageToggle.setting,
					aliasesToggle.setting,
				],
			},
		];

		let activeSection = 0;
		const settingsTheme = getSettingsListTheme();
		// type-to-filter（omp settings-list 模式）：宿主 SettingsList 词级 fuzzyFilter
		// （token 局部匹配打分，避免字母散落长描述误中）。当前页签 >5 项时启用。
		const searchableSections = new Set(
			sections.filter((section) => section.items.length > 5).map((section) => section.id),
		);
		const lists = sections.map(
			(section) =>
				new SettingsList(
					section.items,
					Math.min(8, Math.max(section.items.length, 1)),
					settingsTheme,
					onSettingChange,
					() => done(),
					{ enableSearch: searchableSections.has(section.id) },
				),
		);

		const activeList = () => lists[activeSection]!;

		const switchSection = (delta: number) => {
			if (excludeSubmenuOpen) return;
			activeSection = (activeSection + delta + sections.length) % sections.length;
		};

		/** 数值项：当前选中项有 submenu + values 时，Space 仅循环预设，不打开子面板。 */
		const cyclePresetInList = (list: InstanceType<typeof SettingsList>): boolean => {
			const internal = list as unknown as {
				submenuComponent: unknown;
				searchInput: { getValue(): string } | undefined;
				items: {
					id: string;
					currentValue: string;
					submenu?: unknown;
					values?: readonly string[];
				}[];
				selectedIndex: number;
			};
			if (internal.submenuComponent) return false;
			// 搜索中（filter 框非空）：Space 应输入空格，不抢键。
			if (internal.searchInput && internal.searchInput.getValue().length > 0) return false;
			const item = internal.items[internal.selectedIndex];
			if (!item?.submenu || !item.values?.length) return false;
			const i = item.values.indexOf(item.currentValue);
			item.currentValue = item.values[i === -1 ? 0 : (i + 1) % item.values.length]!;
			onSettingChange(item.id, item.currentValue);
			return true;
		};

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(0, Math.floor(width));
				const rule = renderPanelRule(theme, safeWidth);
				const body = activeList().render(safeWidth);
				// Drop SettingsList's built-in hint — the panel footer below is the single source.
				while (body.length > 0 && body[body.length - 1] === "") body.pop();
				const listHintIndex = body.findIndex(
					(line) =>
						typeof line === "string" &&
						(line.includes("Enter/Space to change") || line.includes("Esc to cancel")),
				);
				const listBody = listHintIndex >= 0 ? body.slice(0, listHintIndex) : body;
				while (listBody.length > 0 && listBody[listBody.length - 1] === "") listBody.pop();

				// Frame: top rule · tabs · mid rule · settings · mid rule · footer · bottom rule
				// 键位提示从 keybindings manager 取（改键后自动跟随）；未绑定项自动隐藏。
				const confirmKeys = bindingKeys("tui.select.confirm", "enter");
				const cancelKeys = bindingKeys("tui.select.cancel", "esc");
				const activeSectionId = sections[activeSection]?.id;
				const parts = [
					searchableSections.has(activeSectionId ?? "") ? "type to filter" : "",
					`${confirmKeys}/Space to change`,
					"Enter on numbers types a custom value",
					"Tab/Shift+Tab to switch sections",
					cancelKeys ? `${cancelKeys} to close` : "",
				].filter(Boolean);
				return [
					rule,
					renderSectionTabBar(theme, sections, activeSection, safeWidth),
					rule,
					...listBody,
					rule,
						truncateToWidth(theme.fg("dim", `  ${parts.join(" · ")}`), safeWidth),
					rule,
				];
			},
			invalidate() {
				for (const list of lists) list.invalidate();
			},
			handleInput(data: string) {
				if (!excludeSubmenuOpen && isForwardTabKey(data)) {
					switchSection(1);
					tui.requestRender();
					return;
				}
				if (!excludeSubmenuOpen && isBackTabKey(data)) {
					switchSection(-1);
					tui.requestRender();
					return;
				}
				const list = activeList();
				// Space 循环预设（数值项不进子面板、搜索框为空时）；Enter 打开子面板输入自定义值。
				if (data === " " && cyclePresetInList(list)) {
					tui.requestRender();
					return;
				}
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
	// 面板卸下后主 transcript 重新挂载；再刷一次，吃掉打开期间扫树失败的切换。
	hooks.refreshCurrentTranscript(ctx, toolGrouping);
}
