/**
 * Extension configuration.
 *
 * Learned from nicobailon/pi-subagents src/extension/config.ts.
 *
 * Config file: <agentDir>/extensions/pi-subagents/config.json
 * (override with PI_SUBAGENT_CONFIG).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, expandTilde, atomicWriteFileSync } from "../shared/utils.ts";
import type { ForkContextConfig } from "../runs/fork-context.ts";

export interface SubagentConfig {
	/** Spawn background children by default (the subagent tool returns immediately). */
	asyncByDefault: boolean;
	/** Default timeout for foreground runs in ms. */
	defaultTimeoutMs?: number;
	/**
	 * Default model for subagent children (provider/model, optionally with a
	 * :thinking suffix). When unset, children inherit the parent session's
	 * current model.
	 */
	defaultModel?: string;
	/** Pruned-fork settings for agents whose defaultContext is "fork". */
	forkContext?: ForkContextConfig;
	/** Maximum nesting depth for subagent-of-subagent runs. */
	maxSubagentDepth?: number;
	/** How many days background run artifacts are kept. */
	runsRetentionDays?: number;
}

const DEFAULT_CONFIG: SubagentConfig = {
	asyncByDefault: true,
	maxSubagentDepth: 8,
	runsRetentionDays: 7,
};

export function configPath(): string {
	const override = process.env.PI_SUBAGENT_CONFIG;
	if (override) return expandTilde(override);
	return path.join(getAgentDir(), "extensions", "pi-subagents", "config.json");
}

/**
 * Read the config file, but only when it is a regular file. A FIFO, device
 * node, or socket at the config path would block readFileSync forever (L5);
 * statSync is safe on those and lets us skip them (returns null).
 */
function readConfigFileRaw(): string | null {
	const file = configPath();
	try {
		const st = fs.statSync(file);
		if (!st.isFile()) return null;
	} catch {
		return null;
	}
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

export function loadConfig(base: Partial<SubagentConfig> = {}): SubagentConfig {
	const config: SubagentConfig = { ...DEFAULT_CONFIG, ...base };
	try {
		const raw = readConfigFileRaw();
		if (raw === null) return config;
		const parsed = JSON.parse(raw) as Partial<SubagentConfig>;
		return {
			...config,
			...parsed,
			forkContext: parsed.forkContext ? { ...parsed.forkContext, mode: "pruned" } : config.forkContext,
		};
	} catch {
		return config;
	}
}

/** Raw values stored in the config file ({} when missing/unreadable). */
export function readConfigFile(): Partial<SubagentConfig> {
	const raw = readConfigFileRaw();
	if (raw === null) return {};
	try {
		const parsed = JSON.parse(raw) as Partial<SubagentConfig>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Merge updates into the config file and write it back, creating the
 * directory as needed. Keys present with an `undefined` value are removed
 * from the file. Returns an error message, or null on success.
 */
export function writeConfigFile(updates: Partial<SubagentConfig>): string | null {
	const file = configPath();
	try {
		const existing = readConfigFile();
		const merged: Partial<SubagentConfig> = { ...existing, ...updates };
		if ("forkContext" in updates) {
			if (updates.forkContext === undefined) {
				delete merged.forkContext;
			} else {
				merged.forkContext = {
					...(existing.forkContext ?? {}),
					...updates.forkContext,
					mode: "pruned" as const,
				};
			}
		} else if (existing.forkContext) {
			merged.forkContext = { ...existing.forkContext, mode: "pruned" as const };
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// L5: refuse to *write* into a FIFO/device — opening it for writing
		// would block or clobber unrelated state.
		try {
			const st = fs.statSync(file);
			if (!st.isFile()) return `Refusing to write config: ${file} is not a regular file.`;
		} catch {
			// File does not exist yet; the atomic write will create it.
		}
		// N4: temp+rename so a crash mid-write can never corrupt the file
		// (which loadConfig would otherwise silently fall back from).
		atomicWriteFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
		return null;
	} catch (error) {
		return `Failed to write ${file}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

const CONFIG_KEYS = ["asyncByDefault", "defaultTimeoutMs", "defaultModel", "maxSubagentDepth", "runsRetentionDays", "forkContext.maxTurns"] as const;

/** provider/model with an optional :thinking suffix (e.g. anthropic/claude-sonnet-4-5:high). */
const MODEL_VALUE_RE = /^[^\s/]+\/[^\s/:]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/;

/** Values that mean "remove the defaultModel override, inherit the parent". */
const INHERIT_VALUES = new Set(["inherit", "unset", "parent"]);

function parsePositiveInt(value: string, key: string): number | string {
	if (!/^[0-9]+$/.test(value)) return `${key} expects a positive integer, got "${value}"`;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < 1) return `${key} expects a positive integer, got "${value}"`;
	return n;
}

/**
 * Parse `key=value` tokens into a partial config. Supports flat keys
 * (asyncByDefault, defaultTimeoutMs, maxSubagentDepth, runsRetentionDays)
 * and the nested forkContext.maxTurns. Returns the first error message.
 */
export function parseConfigUpdates(tokens: string[]): { updates: Partial<SubagentConfig> } | { error: string } {
	const updates: Partial<SubagentConfig> = {};
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq === -1) {
			return { error: `Invalid "${token}": expected key=value. Supported keys: ${CONFIG_KEYS.join(", ")}` };
		}
		const key = token.slice(0, eq).trim();
		const value = token.slice(eq + 1).trim();
		switch (key) {
			case "asyncByDefault": {
				if (value !== "true" && value !== "false") {
					return { error: `asyncByDefault expects true or false, got "${value}"` };
				}
				updates.asyncByDefault = value === "true";
				break;
			}
			case "defaultTimeoutMs": {
				const n = parsePositiveInt(value, key);
				if (typeof n === "string") return { error: n };
				updates.defaultTimeoutMs = n;
				break;
			}
			case "defaultModel": {
				if (INHERIT_VALUES.has(value)) {
					// Present with undefined removes the stored override.
					updates.defaultModel = undefined;
				} else if (!MODEL_VALUE_RE.test(value)) {
					return {
						error: `defaultModel expects "provider/model"/"provider/model:thinking" or "inherit", got "${value}"`,
					};
				} else {
					updates.defaultModel = value;
				}
				break;
			}
			case "maxSubagentDepth": {
				const n = parsePositiveInt(value, key);
				if (typeof n === "string") return { error: n };
				updates.maxSubagentDepth = n;
				break;
			}
			case "runsRetentionDays": {
				const n = parsePositiveInt(value, key);
				if (typeof n === "string") return { error: n };
				updates.runsRetentionDays = n;
				break;
			}
			case "forkContext.maxTurns": {
				const n = parsePositiveInt(value, key);
				if (typeof n === "string") return { error: n };
				updates.forkContext = { mode: "pruned", maxTurns: n };
				break;
			}
			default:
				return { error: `Unknown key "${key}". Supported keys: ${CONFIG_KEYS.join(", ")}` };
		}
	}
	return { updates };
}

/**
 * Persist updates and apply them to the in-memory config so the change is
 * effective without a session restart. Keys present with an `undefined`
 * value are removed. Returns an error message, or null on success.
 */
export function applyConfigUpdates(config: SubagentConfig, updates: Partial<SubagentConfig>): string | null {
	const error = writeConfigFile(updates);
	if (error) return error;
	if (updates.asyncByDefault !== undefined) config.asyncByDefault = updates.asyncByDefault;
	if ("defaultModel" in updates) {
		if (updates.defaultModel === undefined) delete config.defaultModel;
		else config.defaultModel = updates.defaultModel;
	}
	if ("defaultTimeoutMs" in updates) {
		if (updates.defaultTimeoutMs === undefined) delete config.defaultTimeoutMs;
		else config.defaultTimeoutMs = updates.defaultTimeoutMs;
	}
	if ("maxSubagentDepth" in updates) {
		if (updates.maxSubagentDepth === undefined) delete config.maxSubagentDepth;
		else config.maxSubagentDepth = updates.maxSubagentDepth;
	}
	if ("runsRetentionDays" in updates) {
		if (updates.runsRetentionDays === undefined) delete config.runsRetentionDays;
		else config.runsRetentionDays = updates.runsRetentionDays;
	}
	if ("forkContext" in updates) {
		if (updates.forkContext === undefined) config.forkContext = undefined;
		else config.forkContext = { ...config.forkContext, ...updates.forkContext, mode: "pruned" };
	}
	return null;
}