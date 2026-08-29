/**
 * Agent discovery and configuration.
 *
 * Learned from nicobailon/pi-subagents src/agents/agents.ts:
 *
 * An "agent" is a markdown file with YAML frontmatter. The body is the
 * system prompt handed to the child pi session.
 *
 * Discovery order (later sources override earlier ones by name/alias):
 *   1. builtin  — agents/ shipped with this package
 *   2. user     — ~/.pi/agent/subagents/ + ~/.pi/agent/agents/ + ~/.agents
 *   3. project  — nearest .pi/subagents/ walking up from cwd
 *
 * Both user and project directories are scanned for `*.md` files and for
 * subdirectories containing `*.md` files, so `~/.agents/reviewer.md` and
 * `~/.pi/agent/subagents/review-team/` both work.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";
import { BUILTIN_AGENT_NAMES } from "./builtin-names.ts";

export type AgentSource = "builtin" | "user" | "project";
export type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";

export interface AgentConfig {
	name: string;
	description: string;
	aliases?: string[];
	tools?: string[];
	model?: string;
	thinking?: string | false;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryReport {
	agents: AgentConfig[];
	directories: string[];
	errors: string[];
	cwd: string;
}

/** Defaults mirror the reference package: only `delegate` appends to the base prompt. */
export function defaultSystemPromptMode(name: string): SystemPromptMode {
	return name === "delegate" ? "append" : "replace";
}

function truthy(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return value !== "false" && value !== "0" && value !== "no";
}

function parseAgentFile(filePath: string, source: AgentSource): AgentConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const { frontmatter, body } = parseFrontmatter(content);
	const name = frontmatter.name?.trim();
	if (!name) return null;
	if (!body.trim()) return null;

	const tools = parseFrontmatterList(frontmatter.tools);
	const aliases = parseFrontmatterList(frontmatter.aliases);
	const thinking = frontmatter.thinking?.trim();
	const rawDefaultContext = frontmatter.defaultContext?.trim();

	return {
		name,
		description: frontmatter.description?.trim() ?? "",
		...(aliases?.length ? { aliases } : {}),
		...(tools?.length ? { tools } : {}),
		...(frontmatter.model?.trim() ? { model: frontmatter.model.trim() } : {}),
		...(thinking && thinking !== "" ? { thinking: thinking === "off" ? false : thinking } : {}),
		systemPromptMode:
			frontmatter.systemPromptMode?.trim() === "append" ? "append" : defaultSystemPromptMode(name),
		inheritProjectContext: truthy(frontmatter.inheritProjectContext) ?? false,
		inheritSkills: truthy(frontmatter.inheritSkills) ?? false,
		...(rawDefaultContext === "fork" || rawDefaultContext === "fresh" ? { defaultContext: rawDefaultContext } : {}),
		systemPrompt: body,
		source,
		filePath,
	};
}

function listAgentFiles(dir: string, depth = 0): { files: string[]; error?: string } {
	const files: string[] = [];
	// L1: bound the recursion so a pathological directory tree cannot turn
	// agent discovery (tool execution + every autocomplete keystroke) into
	// an unbounded synchronous walk.
	if (depth > MAX_AGENT_SCAN_DEPTH) {
		return { files, error: `directory nesting deeper than ${MAX_AGENT_SCAN_DEPTH} levels was skipped` };
	}
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(full);
			} else if (entry.isDirectory()) {
				files.push(...listAgentFiles(full, depth + 1).files);
			}
		}
	} catch (error) {
		return { files, error: error instanceof Error ? error.message : String(error) };
	}
	return { files };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const { files, error } = listAgentFiles(dir);
	if (error) return [];
	return files
		.map((file) => parseAgentFile(file, source))
		.filter((agent): agent is AgentConfig => agent !== null);
}

/** Directory that ships with this package: <pkg>/agents */
function builtinAgentsDir(): string {
	return path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), "agents");
}

/** User definition directories (mirrors the reference package's layout). */
export function userAgentDirs(agentDir: string): string[] {
	return [
		path.join(agentDir, "subagents"),
		path.join(agentDir, "agents"),
		path.join(os.homedir(), ".agents"),
	];
}

export const PROJECT_SUBAGENTS_RELATIVE_DIR = ".pi/subagents";

/** Find the nearest project subagents dir by walking up until the fs root. */
export function findProjectSubagentsDir(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, PROJECT_SUBAGENTS_RELATIVE_DIR);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** L1: max depth of the recursive agent-file scan. */
const MAX_AGENT_SCAN_DEPTH = 8;

/**
 * Discovery cache (L1): `execute` rescans every call and autocomplete
 * rescans on every keystroke. A short TTL keeps repeat scans off the hot
 * path while still picking up agent file edits within a couple of seconds.
 * Keyed by cwd + agentDir; bounded by evicting expired entries.
 */
const DISCOVERY_CACHE_TTL_MS = 2000;
const discoveryCache = new Map<string, { at: number; report: AgentDiscoveryReport }>();

function evictExpiredDiscoveryCache(): void {
	const now = Date.now();
	for (const [key, entry] of discoveryCache) {
		if (now - entry.at >= DISCOVERY_CACHE_TTL_MS) discoveryCache.delete(key);
	}
}

/**
 * Discover agents visible from `cwd`: builtin + user + project.
 * `project` overrides `user` overrides `builtin` on name collision so teams
 * can ship project-specific agents that shadow personal ones.
 */
export function discoverAgents(cwd: string, agentDir: string): AgentDiscoveryReport {
	const key = `${cwd}\u0000${agentDir}`;
	const cached = discoveryCache.get(key);
	if (cached && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) return cached.report;
	const report = discoverAgentsUncached(cwd, agentDir);
	if (discoveryCache.size >= 64) evictExpiredDiscoveryCache();
	discoveryCache.set(key, { at: Date.now(), report });
	return report;
}

function discoverAgentsUncached(cwd: string, agentDir: string): AgentDiscoveryReport {
	const directories: string[] = [];
	const errors: string[] = [];

	const builtinDir = builtinAgentsDir();
	directories.push(builtinDir);
	const builtin = loadAgentsFromDir(builtinDir, "builtin");

	const userDirs = userAgentDirs(agentDir);
	const user: AgentConfig[] = [];
	for (const dir of userDirs) {
		directories.push(dir);
		const { files, error } = listAgentFiles(dir);
		if (error) errors.push(`Cannot read user agent directory ${dir}: ${error}`);
		user.push(...loadAgentsFromDir(dir, "user"));
	}

	const projectDir = findProjectSubagentsDir(cwd);
	const project: AgentConfig[] = [];
	if (projectDir) {
		directories.push(projectDir);
		project.push(...loadAgentsFromDir(projectDir, "project"));
	}

	// Merge with override precedence: project > user > builtin.
	const byName = new Map<string, AgentConfig>();
	const merge = (agents: AgentConfig[]) => {
		for (const agent of agents) byName.set(agent.name, agent);
	};
	merge(builtin);
	merge(user);
	merge(project);

	// A custom agent can displace a builtin of the same name; its custom
	// aliases also shadow builtin aliases.
	const agents = [...byName.values()];
	return { agents, directories, errors, cwd: path.resolve(cwd) };
}

/**
 * Resolve an agent by exact name or alias. Unknown names produce a
 * diagnostic listing the closest plausible candidates.
 */
export function resolveAgentName(
	name: string,
	agents: AgentConfig[],
): { agent: AgentConfig | undefined; candidates: string[] } {
	const byName = new Map<string, AgentConfig>();
	for (const agent of agents) {
		byName.set(agent.name, agent);
		for (const alias of agent.aliases ?? []) byName.set(alias, agent);
	}
	const agent = byName.get(name);
	if (agent) return { agent, candidates: [] };
	// Fuzzy candidates for the error message: prefix matches first, then edit-distance <= 2.
	const prefix = agents.filter((a) => a.name.startsWith(name) || (a.aliases ?? []).some((alias) => alias.startsWith(name))).map((a) => a.name);
	const fuzzy = agents
		.filter((a) => !prefix.includes(a.name) && (editDistance(name, a.name) <= 2 || (a.aliases ?? []).some((alias) => editDistance(name, alias) <= 2)))
		.map((a) => a.name);
	return { agent: undefined, candidates: [...prefix, ...fuzzy].slice(0, 5) };
}

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	// L2: length guard — with a threshold of 2, strings whose lengths differ
	// by more than 2 can never be a match, so skip the O(m×n) DP entirely
	// (guards against maliciously over-long names on the hot path).
	if (Math.abs(m - n) > 2) return 3;
	const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		let prev = dp[0]!;
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j]!;
			dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return dp[n]!;
}

export { BUILTIN_AGENT_NAMES } from "./builtin-names.ts";