/**
 * Configuration for pi-todo.
 *
 * JSON config at `<XDG_CONFIG_HOME>/pi-todo/config.json` (default
 * `~/.config/pi-todo/config.json`), overridable via the `PI_TODO_CONFIG`
 * environment variable. The file is read, never written; malformed JSON falls
 * back to defaults with a warning.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Guidance fields that can override what the model sees for the tool.
 * Mirrors the shape used across the rpiv-* family (GuidanceFields).
 */
export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface TodoConfig {
	guidance?: GuidanceFields;
	/**
	 * Content-row budget for the overlay, heading included. Minimum `3`.
	 */
	maxWidgetLines?: number;
	/**
	 * Key spec for the overlay collapse/expand shortcut, in the same format as
	 * pi-coding-agent keybinding ids (`modifier+key`, e.g. `ctrl+shift+t`, `alt+o`).
	 * Defaults to `"ctrl+shift+t"`. Pass `"off"` to disable the collapse shortcut
	 * entirely. Validation happens in `resolveCollapseKey`, not at load.
	 */
	collapseKey?: string;
}

/** Turn log lookback for the stale-task reminder (B4): a task untouched for
 *  this many turns is considered stalled. */
export const STALE_TURNS = 2;

/** Default content-row budget when the config is missing/invalid. */
export const DEFAULT_MAX_WIDGET_LINES = 12;

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+shift+t"` or `"alt+o"`. */
export type CollapseKeySpec = string;

/** Default collapse/expand key when `collapseKey` is missing/empty/blank/invalid. */
export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+shift+t";

/** Sentinel value for `collapseKey` that disables the collapse shortcut entirely. */
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

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
	return join(homedir(), ".config", "pi-todo", file);
}

/** Config path honoring `PI_TODO_CONFIG` → XDG → legacy `~/.config`. */
export function configPath(file: string = "config.json"): string {
	const override = process.env.PI_TODO_CONFIG?.trim();
	if (override) return expandTilde(override);
	return join(resolveConfigDir(), "pi-todo", file);
}

interface JsonCache {
	path: string;
	mtimeMs: number;
	exists: boolean;
	data: unknown;
}

let jsonCache: JsonCache | undefined;

/** Test-only: drop the mtime cache so the next load re-reads from disk. */
export function __resetConfigCache(): void {
	jsonCache = undefined;
}

/**
 * Load and parse a JSON config file. Returns `{}` for missing files, malformed
 * JSON, or non-plain-object values (arrays, primitives, null). Cached by
 * path + mtime so overlay paints don't hit the filesystem every frame.
 */
function loadJsonConfig<T>(path: string): T {
	let mtimeMs = 0;
	let exists = false;
	try {
		mtimeMs = statSync(path).mtimeMs;
		exists = true;
	} catch {
		exists = false;
	}

	if (jsonCache?.path === path && jsonCache.exists === exists && jsonCache.mtimeMs === mtimeMs) {
		return jsonCache.data as T;
	}

	if (!exists) {
		const empty = {};
		jsonCache = { path, mtimeMs: 0, exists: false, data: empty };
		return empty as T;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		const data = parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ? {} : parsed;
		jsonCache = { path, mtimeMs, exists: true, data };
		return data as T;
	} catch (err) {
		console.warn(`pi-todo: invalid JSON at ${path}, using default ({}) — ${(err as Error).message}`);
		const empty = {};
		jsonCache = { path, mtimeMs, exists: true, data: empty };
		return empty as T;
	}
}

/** Load the user config, preferring the XDG-resolved path with legacy-fallback. */
export function loadConfig(): TodoConfig {
	return loadJsonConfigWithLegacyFallback<TodoConfig>();
}

function loadJsonConfigWithLegacyFallback<T>(): T {
	const xdgPath = configPath();
	if (existsSync(xdgPath)) {
		return loadJsonConfig<T>(xdgPath);
	}
	return loadJsonConfig<T>(legacyConfigPath("config.json"));
}

// ---------------------------------------------------------------------------
// Config-derived settings
// ---------------------------------------------------------------------------

/** Content-row budget for the overlay, read fresh on every call (per-render —
 *  no `/reload`). A non-number or a value below the floor of 3 falls back to
 *  the default; no ceiling. */
export function getMaxWidgetLines(config: Pick<TodoConfig, "maxWidgetLines"> = loadConfig()): number {
	const lines = config.maxWidgetLines;
	if (typeof lines !== "number" || lines < 3) return DEFAULT_MAX_WIDGET_LINES;
	return lines;
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

/** Validate a collapse-key spec against pi-tui's KeyId grammar. Exported for unit tests. */
export function isValidCollapseKeySpec(spec: string): boolean {
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

/** Resolve the collapse/expand key from config, read fresh on every call.
 *  Returns DEFAULT_COLLAPSE_KEY when the field is missing/non-string/empty/blank/
 *  invalid, COLLAPSE_KEY_OFF when set to the sentinel, or the lowercased validated
 *  spec. */
export function resolveCollapseKey(config: Pick<TodoConfig, "collapseKey"> = loadConfig()): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}