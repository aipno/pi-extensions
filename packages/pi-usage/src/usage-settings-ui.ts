import {
	type ExtensionCommandContext,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	Input,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { errorMessage } from "./core.ts";
import {
	newApiSystemTokenIssue,
	newApiUserIdIssue,
	type UsageSettings,
	type UsageSettingsPatch,
	type UsageSettingsRuntime,
} from "./settings.ts";

const OFF = "Off";
const ON = "On";
const NEW_API_UNSET = "not set";
const NEW_API_SET = "configured";
const TOKEN_MASK = "•";

type UsageSettingId =
	| "codexFastMode"
	| "xaiUsage"
	| "usageStatusline"
	| "newApiSystemToken"
	| "newApiUserId";

export async function showUsageSettings(
	ctx: ExtensionCommandContext,
	settingsRuntime: UsageSettingsRuntime,
	parentSignal: AbortSignal,
	isCurrent: () => boolean,
	onApplied: (id: UsageSettingId, previous: boolean, next: boolean) => void,
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${settingsRuntime.get().path}`, "info");
		return false;
	}
	if (parentSignal.aborted || !isCurrent()) return false;

	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const localController = new AbortController();
		const signal = AbortSignal.any([parentSignal, localController.signal]);
		let changed = false;
		let closing = false;
		let saveQueue = Promise.resolve();
		const state = settingsRuntime.get();
		// Text editors hand the selected *display* value back through the
		// SettingsList submenu contract; the raw submitted secret is parked here per
		// item id so onChange can persist it without it ever reaching the list.
		const pendingNewApiValues = new Map<"newApiSystemToken" | "newApiUserId", string>();
		const items: SettingItem[] = [
			{
				id: "codexFastMode",
				label: "Codex Fast mode",
				description: "Use faster Codex routing at increased plan allowance consumption.",
				currentValue: state.settings.codexFastMode ? ON : OFF,
				values: [OFF, ON],
			},
			{
				id: "xaiUsage",
				label: "xAI usage",
				description: "Report OAuth subscription allowance and credits.",
				currentValue: state.kind !== "invalid" && state.settings.xaiUsage ? ON : OFF,
				values: [OFF, ON],
			},
			{
				id: "usageStatusline",
				label: "Usage statusline",
				description: "Show provider usage in the footer statusline.",
				currentValue: state.kind !== "invalid" && state.settings.usageStatusline ? ON : OFF,
				values: [OFF, ON],
			},
			{
				id: "newApiSystemToken",
				label: "New API system token",
				description:
					"New API gateway system access token (个人设置 → 安全设置 → 系统访问令牌) used to " +
					"query /api/user/self and /api/data/self. The sk- inference token is rejected by " +
					"these management endpoints. Stored values stay hidden; leave the field empty to erase.",
				currentValue: newApiDisplayValue(state.settings, "token"),
				submenu: (_current, submenuDone) =>
					createTextEditor({
						title: "New API system token",
						fieldLabel: "System access token",
						initialValue: "",
						configured: settingsRuntime.get().settings.newApiSystemToken !== undefined,
						mask: true,
						note: settingsRuntime.get().settings.newApiSystemToken
							? "A token is stored and stays hidden while you type."
							: undefined,
						validate: newApiSystemTokenIssue,
						valueToDisplay: (value) => (value.trim().length === 0 ? NEW_API_UNSET : NEW_API_SET),
						theme,
						done(action) {
							if (action.kind === "save") {
								pendingNewApiValues.set("newApiSystemToken", action.raw.trim());
								submenuDone(action.display);
							} else {
								pendingNewApiValues.delete("newApiSystemToken");
								submenuDone(undefined);
							}
						},
					}),
			},
			{
				id: "newApiUserId",
				label: "New API user ID",
				description:
					"Numeric User ID from the gateway profile page (个人设置). Sent as the New-Api-User " +
					"header for deployments that still require it; newer versions ignore it.",
				currentValue: newApiDisplayValue(state.settings, "userId"),
				submenu: (_current, submenuDone) =>
					createTextEditor({
						title: "New API user ID",
						fieldLabel: "User ID",
						initialValue:
							settingsRuntime.get().settings.newApiUserId !== undefined
								? String(settingsRuntime.get().settings.newApiUserId)
								: "",
						configured: settingsRuntime.get().settings.newApiUserId !== undefined,
						mask: false,
						validate: newApiUserIdIssue,
						valueToDisplay: (value) => {
							const trimmed = value.trim();
							return trimmed.length === 0 ? NEW_API_UNSET : String(Number(trimmed));
						},
						theme,
						done(action) {
							if (action.kind === "save") {
								pendingNewApiValues.set("newApiUserId", action.raw.trim());
								submenuDone(action.display);
							} else {
								pendingNewApiValues.delete("newApiUserId");
								submenuDone(undefined);
							}
						},
					}),
			},
		];
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("pi-usage Settings")), 1, 1));

		let settingsList: SettingsList;
		const cancel = () => {
			if (closing) return;
			closing = true;
			localController.abort();
			done(changed);
		};
		const enqueueSave = (operation: () => Promise<void>) => {
			saveQueue = saveQueue.then(operation, operation);
		};
		settingsList = new SettingsList(
			items,
			items.length + 2,
			getSettingsListTheme(),
			(id, _value) => {
				if (closing || signal.aborted || !isCurrent()) return;
				if (id === "newApiSystemToken" || id === "newApiUserId") {
					enqueueSave(async () => {
						const tokenKind = id === "newApiSystemToken";
						const previous = settingsRuntime.get();
						if (previous.kind === "invalid") {
							pendingNewApiValues.delete(id as "newApiSystemToken" | "newApiUserId");
							if (!signal.aborted && isCurrent()) {
								ctx.ui.notify("Repair pi-usage.json and reload before changing settings.", "error");
								tui.requestRender();
							}
							return;
						}
						const submitted = pendingNewApiValues.get(id as "newApiSystemToken" | "newApiUserId");
						pendingNewApiValues.delete(id as "newApiSystemToken" | "newApiUserId");
						if (submitted === undefined) return;
						// Only persist when the stored value actually changes.
						const storedBefore = tokenKind
							? (previous.settings.newApiSystemToken ?? "")
							: previous.settings.newApiUserId;
						const nextValue = tokenKind ? 0 : Number(submitted);
						if (tokenKind ? storedBefore === submitted : storedBefore === nextValue) {
							return;
						}
						const patch: UsageSettingsPatch = tokenKind
							? { newApiSystemToken: submitted }
							: { newApiUserId: nextValue };
						try {
							const saved = await settingsRuntime.update(patch, signal);
							const hadBefore = tokenKind
								? previous.settings.newApiSystemToken !== undefined
								: previous.settings.newApiUserId !== undefined;
							const hasNow = tokenKind
								? saved.settings.newApiSystemToken !== undefined
								: saved.settings.newApiUserId !== undefined;
							if (hadBefore !== hasNow) {
								changed = true;
								onApplied(id, hadBefore, hasNow);
							}
							if (signal.aborted || !isCurrent()) return;
							settingsList.updateValue(
								id,
								newApiDisplayValue(saved.settings, tokenKind ? "token" : "userId"),
							);
							tui.requestRender();
						} catch (error) {
							if (signal.aborted || !isCurrent()) return;
							settingsList.updateValue(id, newApiDisplayValue(previous.settings, tokenKind ? "token" : "userId"));
							ctx.ui.notify(`Could not save pi-usage.json: ${errorMessage(error)}`, "error");
							tui.requestRender();
						}
					});
					return;
				}
				const settingId = id as "codexFastMode" | "xaiUsage" | "usageStatusline";
				const requested = _value !== OFF;
				enqueueSave(async () => {
					const previous = settingsRuntime.get().settings[settingId];
					if (settingsRuntime.get().kind === "invalid") {
						const effectivePrevious = settingId === "xaiUsage" ? false : previous;
						settingsList.updateValue(id, displayValue(settingId, effectivePrevious));
						if (!signal.aborted && isCurrent()) {
							ctx.ui.notify("Repair pi-usage.json and reload before changing settings.", "error");
							tui.requestRender();
						}
						return;
					}
					try {
						await settingsRuntime.update({ [settingId]: requested }, signal);
					} catch (error) {
						if (signal.aborted || !isCurrent()) return;
						settingsList.updateValue(id, displayValue(settingId, previous));
						ctx.ui.notify(`Could not save pi-usage.json: ${errorMessage(error)}`, "error");
						tui.requestRender();
						return;
					}
					if (previous !== requested) {
						changed = true;
						onApplied(settingId, previous, requested);
					}
					if (signal.aborted || !isCurrent()) return;
					settingsList.updateValue(id, displayValue(settingId, requested));
					tui.requestRender();
				});
			},
			cancel,
		);
		container.addChild(settingsList);

		parentSignal.addEventListener("abort", cancel, { once: true });
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (closing) return;
				if (matchesKey(data, Key.ctrl("c"))) cancel();
				else settingsList.handleInput(data);
				tui.requestRender();
			},
			dispose() {
				localController.abort();
				parentSignal.removeEventListener("abort", cancel);
			},
		};
	});
}

function displayValue(_id: "codexFastMode" | "xaiUsage" | "usageStatusline", enabled: boolean): string {
	return enabled ? ON : OFF;
}

function newApiDisplayValue(settings: UsageSettings, which: "token" | "userId"): string {
	if (which === "token") {
		// The stored token stays hidden; only its presence is reflected.
		return settings.newApiSystemToken ? NEW_API_SET : NEW_API_UNSET;
	}
	// The user id is not secret, so the row shows the stored value itself.
	return settings.newApiUserId !== undefined ? String(settings.newApiUserId) : NEW_API_UNSET;
}

type TextEditorAction =
	| { kind: "cancel" }
	| { kind: "save"; raw: string; display: string };

type TextEditorOptions = {
	title: string;
	fieldLabel: string;
	initialValue: string;
	configured: boolean;
	mask: boolean;
	note?: string;
	validate(value: string): string | undefined;
	valueToDisplay(value: string): string;
	theme: { fg(color: string, text: string): string; bold(text: string): string };
	done(action: TextEditorAction): void;
};

/**
 * Single-line text editor rendered as a SettingsList submenu. Enter confirms
 * (an empty configured value first asks for a second Enter to erase), Escape
 * backs out one level at a time, and Ctrl+C cancels. Masked editors never
 * render the raw value.
 */
function createTextEditor(options: TextEditorOptions) {
	const input = new Input();
	input.setValue(options.initialValue);
	let mode: "edit" | "confirm-clear" = "edit";
	let issue: string | undefined;
	const { theme, done } = options;

	const cancelAction = () => done({ kind: "cancel" });
	const confirmEmpty = () => {
		const value = input.getValue();
		if (options.configured && value.trim().length === 0) {
			mode = "confirm-clear";
			issue = undefined;
			return;
		}
		done({ kind: "cancel" });
	};
	const submit = () => {
		const raw = input.getValue();
		const invalid = options.validate(raw);
		if (invalid !== undefined) {
			issue = invalid;
			return;
		}
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			confirmEmpty();
			return;
		}
		done({ kind: "save", raw, display: options.valueToDisplay(trimmed) });
	};

	return {
		invalidate() {},
		render(width: number): string[] {
			const lines: string[] = [];
			lines.push(truncateToWidth(theme.fg("accent", theme.bold(options.title)), width));
			lines.push("");
			if (mode === "confirm-clear") {
				lines.push(...wrapTextWithAnsi(
					`This erases the stored ${options.fieldLabel}. ` +
						"New API usage queries will fail until a new value is saved.",
					width - 4,
				).map((line) => theme.fg("warning", `  ${line}`)));
				lines.push("");
				lines.push(truncateToWidth(theme.fg("dim", "  Enter erase · Esc keep editing"), width));
				return lines;
			}
			if (options.note) {
				lines.push(...wrapTextWithAnsi(options.note, width - 4).map((line) => theme.fg("dim", `  ${line}`)));
				lines.push("");
			}
			lines.push(truncateToWidth(theme.fg("text", `  ${options.fieldLabel}:`), width));
			const value = input.getValue();
			if (options.mask) {
				const rendered = value.length > 0 ? TOKEN_MASK.repeat(value.length) : "(empty)";
				lines.push(truncateToWidth(`  › ${theme.fg(value.length > 0 ? "text" : "muted", rendered)}`, width));
			} else {
				lines.push(truncateToWidth(`  › ${value}`, width));
			}
			lines.push("");
			if (issue !== undefined) {
				lines.push(...wrapTextWithAnsi(issue, width - 4).map((line) => theme.fg("error", `  ${line}`)));
			} else if (options.configured) {
				lines.push(truncateToWidth(theme.fg("dim", "  Empty value erases the stored setting."), width));
			}
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", "  Enter confirm · Esc cancel"), width));
			return lines;
		},
		handleInput(data: string) {
			if (mode === "confirm-clear") {
				if (isEnter(data)) done({ kind: "save", raw: "", display: options.valueToDisplay("") });
				else if (isEscape(data) || matchesKey(data, Key.ctrl("c"))) mode = "edit";
				return;
			}
			if (matchesKey(data, Key.ctrl("c"))) {
				cancelAction();
				return;
			}
			if (isEscape(data)) {
				cancelAction();
				return;
			}
			if (isEnter(data)) {
				submit();
				return;
			}
			input.handleInput(data);
		},
	};
}

function isEnter(data: string): boolean {
	return data === "\r" || data === "\n" || matchesKey(data, Key.enter);
}

function isEscape(data: string): boolean {
	return data === "\u001b" || matchesKey(data, Key.escape);
}