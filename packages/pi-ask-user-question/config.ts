/**
 * Configuration for pi-ask-user-question.
 *
 * JSON config at `<XDG_CONFIG_HOME>/pi-ask-user-question/config.json`
 * (default `~/.config/pi-ask-user-question/config.json`), overridable via the
 * `PI_ASK_USER_QUESTION_CONFIG` environment variable. The file is read, never
 * written; malformed JSON falls back to defaults with a warning.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

/**
 * Guidance fields that can override what the model sees for the tool.
 * Mirrors the shape used across the rpiv-* family (GuidanceFields).
 */
export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
	description?: string;
}

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
}

/**
 * Validate and extract guidance fields from an unknown value.
 *
 * Returns a clean `GuidanceFields` object with only valid entries.
 */
export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	if (typeof g.description === "string" && g.description.length > 0) {
		result.description = g.description;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Config file resolution
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/**
 * Resolve the config directory honoring `XDG_CONFIG_HOME`:
 * unset / relative → `~/.config` (XDG mandates absolute paths).
 */
function resolveConfigDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (!xdg) return join(homedir(), ".config");
	const expanded = expandTilde(xdg);
	return isAbsolute(expanded) ? expanded : join(homedir(), ".config");
}

/** Always-legacy config path under `~/.config` (used when the XDG path is missing). */
function legacyConfigPath(file: string): string {
	return join(homedir(), ".config", "pi-ask-user-question", file);
}

/** Config path honoring `PI_ASK_USER_QUESTION_CONFIG` → XDG → legacy `~/.config`. */
export function configPath(file: string = "config.json"): string {
	const override = process.env.PI_ASK_USER_QUESTION_CONFIG?.trim();
	if (override) return expandTilde(override);
	return join(resolveConfigDir(), "pi-ask-user-question", file);
}

/**
 * Load and parse a JSON config file. Returns `{}` for missing files, malformed
 * JSON, or non-plain-object values (arrays, primitives, null).
 */
function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (err) {
		console.warn(`pi-ask-user-question: invalid JSON at ${path}, using default ({}) — ${(err as Error).message}`);
		return {} as T;
	}
}

/** Load the user config, preferring the XDG-resolved path with legacy-fallback. */
export function loadConfig(): AskUserQuestionConfig {
	return loadJsonConfigWithLegacyFallback<AskUserQuestionConfig>();
}

function loadJsonConfigWithLegacyFallback<T>(): T {
	const xdgPath = configPath();
	if (existsSync(xdgPath)) {
		return loadJsonConfig<T>(xdgPath);
	}
	return loadJsonConfig<T>(legacyConfigPath("config.json"));
}

// ---------------------------------------------------------------------------
// Collapse key grammar (mirrors pi-tui's KeyId grammar)
// ---------------------------------------------------------------------------

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	// Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
	// base key that is a single printable character or a named special key. A loose
	// check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
	// and ignores unknown parts, so a typo like `ctr+]` would silently match every
	// bare `]` keypress (and the raw terminal listener would consume them globally).
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

// The only compound-word names in SPECIAL_KEYS — first-letter capitalization
// alone would render them "Pageup"/"Pagedown".
const COMPOUND_KEY_DISPLAY: Record<string, string> = {
	pageup: "PageUp",
	pagedown: "PageDown",
};

/**
 * Pretty-print a resolved key spec for UI copy: each `+`-part gets its first
 * character uppercased (`"ctrl+]"` → `"Ctrl+]"`, `"alt+o"` → `"Alt+O"`,
 * `"f9"` → `"F9"`, `"ctrl+pagedown"` → `"Ctrl+PageDown"`). Display-only — key
 * matching always uses the raw lowercase spec (`matchesKey` lowercases ids),
 * so never feed the result back into it.
 */
export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map(
			(part) =>
				COMPOUND_KEY_DISPLAY[part] ??
				(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}