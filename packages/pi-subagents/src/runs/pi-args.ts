/**
 * Build the child `pi` argv/env for one subagent run.
 *
 * Learned from nicobailon/pi-subagents src/runs/shared/pi-args.ts:
 *
 * The child is launched as:
 *
 *   pi --mode json -p [--model m] [--tools a,b] [--system-prompt file]
 *      [--no-context-files] [--no-skills] [--session-dir dir] [--name agent]
 *      [--session file] "Task: <task>"
 *
 * - `--mode json -p` makes the child emit a JSONL event stream on stdout
 *   (message_start/end, tool_execution_*, turn_end, agent_end, ...) and exit.
 * - Long tasks are delivered via @file to keep argv small.
 * - The system prompt is written to a temp file and attached with
 *   `--system-prompt` (replace) or `--append-system-prompt` (append).
 * - Session files let children participate in session navigation and give
 *   the parent a transcript to recover errors from.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../shared/utils.ts";

const TASK_ARG_LIMIT = 8000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
export const SUBAGENT_PARENT_DEPTH_ENV = "PI_SUBAGENT_PARENT_DEPTH";
export const SUBAGENT_PARENT_CWD_ENV = "PI_SUBAGENT_PARENT_CWD";

export function applyThinkingSuffix(model: string | undefined, thinking: string | false | undefined): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))) {
		return model; // already carries a thinking suffix
	}
	return `${model}:${thinking}`;
}

function thinkingSuffixLevel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const colonIdx = model.lastIndexOf(":");
	return colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))
		? model.substring(colonIdx + 1)
		: undefined;
}

function stripThinkingSuffix(model: string | undefined): string | undefined {
	const level = thinkingSuffixLevel(model);
	return level !== undefined && model !== undefined ? model.slice(0, model.length - level.length - 1) : model;
}

export interface BuildPiArgsInput {
	agent: AgentConfig;
	task: string;
	runId: string;
	/** Additional notes appended to the agent system prompt for this run. */
	instructions?: string;
	model?: string;
	thinking?: string | false;
	tools?: string[];
	sessionDir?: string;
	sessionFile?: string;
	sessionName?: string;
	childCwd?: string;
	parentSessionId?: string | null;
	parentDepth?: number;
	/** Pre-written fork session file (context: "fork"). */
	forkSessionFile?: string | null;
}

export interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir: string;
}

/**
 * Prefix/append the agent system prompt with run-level notes and return the
 * path of a temp file containing the effective prompt.
 */
function writeSystemPromptFile(agent: AgentConfig, instructions: string | undefined): string {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-prompt-"));
	const effective = [
		instructions && instructions.trim() ? `## Run instructions\n${instructions.trim()}\n` : "",
		agent.systemPrompt,
	].filter(Boolean).join("\n\n");
	fs.writeFileSync(path.join(tempDir, "prompt.md"), effective, { mode: 0o600 });
	return tempDir;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args: string[] = ["--mode", "json", "-p"];
	const env: Record<string, string | undefined> = {};

	// Model + thinking.
	// The model may come from the call, the agent definition, or the parent
	// session; thinking may be carried in an explicit model suffix or passed
	// as the independent --thinking flag (which also works when no model is
	// pinned at all). An explicit thinking level wins over a conflicting
	// suffix in the resolved model.
	const explicitThinking = input.thinking ?? input.agent.thinking;
	let modelArg = applyThinkingSuffix(input.model ?? input.agent.model, explicitThinking);
	if (modelArg) args.push("--model", modelArg);
	const suffixLevel = thinkingSuffixLevel(modelArg);
	if (explicitThinking === false) {
		// Force thinking off even when the model pins a level.
		if (suffixLevel !== undefined && modelArg) {
			modelArg = stripThinkingSuffix(modelArg);
			args[args.indexOf("--model") + 1] = modelArg!;
		}
		args.push("--thinking", "off");
	} else if (explicitThinking && suffixLevel !== undefined && suffixLevel !== explicitThinking) {
		// The model pins a different level than the explicit override: strip
		// the suffix and let --thinking carry the requested level.
		modelArg = stripThinkingSuffix(modelArg);
		args[args.indexOf("--model") + 1] = modelArg!;
		args.push("--thinking", explicitThinking);
	} else if (explicitThinking && suffixLevel === undefined) {
		args.push("--thinking", explicitThinking);
	}

	// Tool allowlist. When the agent declares `tools`, the child gets exactly
	// those; undefined means "inherit the default builtin tool set".
	const tools = input.tools ?? input.agent.tools;
	if (tools && tools.length > 0) {
		args.push("--tools", tools.join(","));
	}

	// The agent definition file provides the system prompt.
	const promptTempDir = writeSystemPromptFile(input.agent, input.instructions);
	const promptPath = path.join(promptTempDir, "prompt.md");
	if (input.agent.systemPromptMode === "append") {
		args.push("--append-system-prompt", promptPath);
	} else {
		args.push("--system-prompt", promptPath);
	}

	// Context/skills inheritance policy (matches the reference defaults:
	// only delegate inherits project context; nobody inherits skills).
	if (!input.agent.inheritProjectContext) args.push("--no-context-files");
	if (!input.agent.inheritSkills) args.push("--no-skills");

	// Sessions: children live under the parent session's subtree so `pi`
	// session navigation groups children with their parent.
	if (input.forkSessionFile) {
		fs.mkdirSync(path.dirname(input.forkSessionFile), { recursive: true });
		args.push("--session", input.forkSessionFile);
		if (input.sessionName) args.push("--name", input.sessionName);
	} else if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
		if (input.sessionName) args.push("--name", input.sessionName);
	} else if (input.sessionDir) {
		fs.mkdirSync(input.sessionDir, { recursive: true });
		args.push("--session-dir", input.sessionDir);
		if (input.sessionName) args.push("--name", input.sessionName);
	}

	const tempDir = promptTempDir;

	// Task delivery: argv for short tasks, @file for long ones (keeps argv
	// small for EDR-scanning environments, learned from the reference).
	if (input.task.length > TASK_ARG_LIMIT) {
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	// Child coordination env (mirrors the reference protocol).
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SUBAGENT_RUN_ID_ENV] = input.runId;
	env[SUBAGENT_CHILD_AGENT_ENV] = input.agent.name;
	env[SUBAGENT_PARENT_SESSION_ENV] = input.parentSessionId ?? process.env[SUBAGENT_PARENT_SESSION_ENV] ?? "";
	env[SUBAGENT_PARENT_DEPTH_ENV] = String(input.parentDepth ?? 1);
	env[SUBAGENT_PARENT_CWD_ENV] = input.childCwd ?? process.cwd();
	// Only propagate the package root when the parent actually set it:
	// spawn env values must never be undefined — Node would serialize an
	// undefined value as the literal string "undefined" in the child (N3),
	// polluting the child env with a bogus key that future existence checks
	// could trip on.
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (packageRoot !== undefined) env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = packageRoot;

	// Defensive sweep: drop any other key that slipped in with an undefined
	// value so spawn({ env }) never seeds the child with "undefined" strings.
	const cleanEnv: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		const value = env[key];
		if (value !== undefined) cleanEnv[key] = value;
	}

	return { args, env: cleanEnv, tempDir };
}

export function cleanupTempDir(tempDir: string): void {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Best effort.
	}
}