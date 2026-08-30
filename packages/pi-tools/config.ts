/**
 * pi-tools configuration.
 *
 * Optional JSON file `pi-tools.json` in the pi agent dir (~/.pi, or the
 * project `.pi` dir in a trusted project). Controls which built-in tools the
 * extension overrides and how the grep engine behaves.
 *
 * Example:
 * ```json
 * {
 *   "tools": { "grep": true, "read": true, "write": true, "find": false, "ls": false, "edit": false },
 *   "grep": { "rgFirst": false }
 * }
 * ```
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE = "pi-tools.json";

export interface PiToolsConfig {
	/** Master switch. Default true (all tools registered). */
	enabled?: boolean;
	/** Per-tool override switches (all default true). */
	tools?: {
		grep?: boolean;
		read?: boolean;
		write?: boolean;
		find?: boolean;
		ls?: boolean;
		edit?: boolean;
	};
	/** grep engine options. */
	grep?: {
		/** Prefer the rg binary when available. Default true. */
		rgFirst?: boolean;
	};
}

export const DEFAULT_CONFIG: PiToolsConfig = {
	enabled: true,
	tools: { grep: true, read: true, write: true, find: true, ls: true, edit: true },
	grep: { rgFirst: true },
};

export const TOOL_NAMES = ["grep", "read", "write", "find", "ls", "edit"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeConfig(raw: unknown): PiToolsConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
	const tools = isRecord(raw.tools) ? raw.tools : undefined;
	const grep = isRecord(raw.grep) ? raw.grep : undefined;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		tools: {
			grep: typeof tools?.grep === "boolean" ? tools.grep : DEFAULT_CONFIG.tools!.grep,
			read: typeof tools?.read === "boolean" ? tools.read : DEFAULT_CONFIG.tools!.read,
			write: typeof tools?.write === "boolean" ? tools.write : DEFAULT_CONFIG.tools!.write,
			find: typeof tools?.find === "boolean" ? tools.find : DEFAULT_CONFIG.tools!.find,
			ls: typeof tools?.ls === "boolean" ? tools.ls : DEFAULT_CONFIG.tools!.ls,
			edit: typeof tools?.edit === "boolean" ? tools.edit : DEFAULT_CONFIG.tools!.edit,
		},
		grep: {
			rgFirst: typeof grep?.rgFirst === "boolean" ? grep.rgFirst : DEFAULT_CONFIG.grep!.rgFirst,
		},
	};
}

let cached: PiToolsConfig | undefined;

/** Load configuration (cached). Reads `<agentDir>/pi-tools.json`. */
export function loadConfig(): PiToolsConfig {
	if (cached) return cached;
	const agentDir = getAgentDir();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE), "utf8"));
	} catch {
		raw = {};
	}
	cached = sanitizeConfig(raw);
	return cached;
}

/** Runtime in-memory overrides (set by /tools). */
export const runtimeOverrides = {
	tools: new Map<ToolName, boolean>(),
};

/** Effective enabled state of a tool (config ∧ runtime override). */
export function isToolEnabled(name: ToolName): boolean {
	const config = loadConfig();
	if (config.enabled === false) return false;
	if (config.tools && config.tools[name] === false) return false;
	const override = runtimeOverrides.tools.get(name);
	return override ?? true;
}