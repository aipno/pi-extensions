/**
 * Shared result/state types for the subagent runtime.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * AgentToolResult + the runtime `isError` flag. pi's tool executor reads
 * isError at runtime to color results as failed; the shipped types omit it,
 * so we keep a local alias and use the module augmentation in
 * src/types/pi-runtime-compat.d.ts as the source of truth.
 */
export type ToolResult<T> = AgentToolResult<T> & { isError?: boolean };

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	tokens: number;
}

export interface ToolCallSummary {
	tool: string;
	args: string;
	endMs: number;
}

export interface AgentProgress {
	status: "pending" | "running" | "completed" | "failed" | "interrupted";
	agent: string;
	task: string;
	model?: string;
	turnCount: number;
	toolCount: number;
	tokens: number;
	durationMs: number;
	currentTool?: string;
	recentTools: ToolCallSummary[];
	recentOutput: string[];
	error?: string;
}

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	model?: string;
	usage: Usage;
	messages: unknown[];
	finalOutput: string;
	error?: string;
	timedOut: boolean;
	interrupted: boolean;
	durationMs: number;
	progress?: AgentProgress;
}

export interface Details {
	mode: "single" | "async" | "management";
	results: SingleResult[];
	progress: AgentProgress[];
	runId?: string;
}

export interface AsyncJob {
	runId: string;
	agent: string;
	task: string;
	status: "queued" | "running" | "completed" | "failed" | "interrupted";
	exitCode: number | null;
	error?: string;
	startedAt: number;
	finishedAt?: number;
	model?: string;
	result?: SingleResult;
	cwd: string;
}

export const SUBAGENT_ASYNC_STARTED_EVENT = "pi-subagents:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "pi-subagents:async-complete";
export const SUBAGENT_NOTIFY_MESSAGE_TYPE = "pi-subagents:notify";
export const SUBAGENTS_RUN_MESSAGE_TYPE = "pi-subagents:runs";
export const SUBAGENTS_CONFIG_MESSAGE_TYPE = "pi-subagents:config";
export const SUBAGENT_RUN_RESULT_MESSAGE_TYPE = "pi-subagents:run-result";

export const DEFAULT_MAX_OUTPUT = 12000; // chars returned inline in the tool result
export const MAX_RECENT_OUTPUT_LINES = 20;
export const MAX_RECENT_TOOLS = 8;

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, tokens: 0 };
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	parentSessionFile: string | null;
	asyncJobs: Map<string, AsyncJob>;
	subagentInProgress: boolean;
	spawnCount: number;
	lastUiContext: unknown;
}

export function createInitialState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		parentSessionFile: null,
		asyncJobs: new Map(),
		subagentInProgress: false,
		spawnCount: 0,
		lastUiContext: null,
	};
}