/**
 * Subagent executor: agent resolution → prepare child session/fork → run
 * foreground or async.
 *
 * Learned from nicobailon/pi-subagents src/runs/foreground/subagent-executor.ts.
 */

import * as path from "node:path";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, resolveAgentName, type AgentConfig } from "../agents/agents.ts";
import type { AsyncJob, Details, SingleResult, ToolResult } from "../shared/types.ts";
import { getAgentDir, getSubagentSessionRoot, sanitizeRunId } from "../shared/utils.ts";
import { runSync } from "./execution.ts";
import { createAsyncController, defaultRunsDir, type AsyncController } from "./async.ts";
import { resolveForkSessionFile, type ForkContextConfig } from "./fork-context.ts";
import { SUBAGENT_PARENT_DEPTH_ENV, SUBAGENT_PARENT_SESSION_ENV } from "./pi-args.ts";

export interface ExecutorDependencies {
	config: {
		asyncByDefault: boolean;
		defaultTimeoutMs?: number;
		defaultModel?: string;
		forkContext?: ForkContextConfig;
		maxSubagentDepth?: number;
		runsRetentionDays?: number;
	};
	events: { emit(channel: string, data: unknown): void };
	onAsyncComplete?: (job: AsyncJob, result: ToolResult<Details>) => void;
}

export interface SubagentParamsLike {
	agent: string;
	task: string;
	instructions?: string;
	async?: boolean;
	model?: string;
	thinking?: string;
	tools?: string[];
	context?: string;
	timeoutMs?: number;
}

export interface AgentReport {
	agents: AgentConfig[];
	directories: string[];
	errors: string[];
}

export interface SubagentExecutor {
	execute(
		toolCallId: string,
		params: SubagentParamsLike,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult<Details>>;
	listAgents(cwd: string): AgentReport;
	listRuns(): ReturnType<AsyncController["listRuns"]>;
	readAsyncResult(runId: string): SingleResult | null;
	/** Reconcile runs left behind by a crashed parent; call on session_start. */
	reconcile(): void;
	bindSession(ctx: ExtensionContext): void;
}

export function createSubagentExecutor(deps: ExecutorDependencies): SubagentExecutor {
	const agentDir = getAgentDir();
	const runsDir = defaultRunsDir();

	const asyncController = createAsyncController({
		runsDir,
		retentionDays: deps.config.runsRetentionDays ?? 7,
		onComplete: (job, result) => deps.onAsyncComplete?.(job, result),
		events: deps.events,
	});

	const parseDepth = (): number => {
		const raw = process.env[SUBAGENT_PARENT_DEPTH_ENV];
		const depth = raw ? Number(raw) : 1;
		return Number.isFinite(depth) && depth >= 1 ? depth : 1;
	};
	const currentDepth = parseDepth();
	const maxDepth = deps.config.maxSubagentDepth ?? 8;

	const resolveAgent = (name: string, cwd: string): { agent?: AgentConfig; error?: string } => {
		const { agents } = discoverAgents(cwd, agentDir);
		const { agent, candidates } = resolveAgentName(name, agents);
		if (agent) return { agent };
		const known = agents.map((a) => a.name).join(", ");
		const hint = candidates.length > 0 ? ` Did you mean: ${candidates.join(", ")}?` : "";
		return { error: `Unknown subagent '${name}'.${hint} Available agents: ${known || "(none)"}` };
	};

	const execute = async (
		toolCallId: string,
		params: SubagentParamsLike,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult<Details>> => {
		// M2: toolCallId is provider-controlled and may contain path-breaking
		// sequences; the sanitized form is used for every filesystem touch
		// (session files, persisted output). Display ids downstream are safe
		// by construction: it only rewrites characters that are invalid in
		// paths anyway.
		const runId = sanitizeRunId(toolCallId);
		const resolved = resolveAgent(params.agent, ctx.cwd);
		if (!resolved.agent) {
			return {
				content: [{ type: "text", text: resolved.error ?? `Unknown subagent '${params.agent}'.` }],
				isError: true,
				details: { mode: "single", results: [], progress: [] },
			};
		}
		const agent = resolved.agent;

		// Depth guard: children of children inherit a depth counter through
		// SUBAGENT_PARENT_DEPTH_ENV (PI_SUBAGENT_PARENT_DEPTH).
		if (currentDepth >= maxDepth) {
			return {
				content: [{ type: "text", text: `Maximum subagent depth (${maxDepth}) reached; refusing to spawn '${agent.name}'.` }],
				isError: true,
				details: { mode: "single", results: [], progress: [] },
			};
		}

		const parentSessionFile = safeSessionFile(ctx);
		// Inherit the parent's current model when neither the call, the agent
		// definition, nor the defaultModel setting pins one: last assistant
		// message in the session.
		const model = params.model ?? agent.model ?? deps.config.defaultModel ?? resolveParentModel(ctx);
		const childCwd = ctx.cwd;
		const root = getSubagentSessionRoot(parentSessionFile);
		const sessionFile = path.join(root, runId, "session.jsonl");
		const contextOverride = params.context === "fork" || params.context === "fresh" ? params.context : undefined;
		const fork = resolveForkSessionFile({
			context: contextOverride,
			agentDefaultContext: agent.defaultContext,
			forkConfig: deps.config.forkContext,
			parentSessionFile,
			childSessionFile: sessionFile,
		});
		// A requested fork that fails would silently strip inherited context
		// from oracle/worker; surface it as a run instruction instead.
		const instructions = [
			params.instructions,
			fork.error && (contextOverride === "fork" || agent.defaultContext === "fork")
				? `[Context fork requested but unavailable: ${fork.error}. Proceed with fresh context.]`
				: undefined,
		].filter((note): note is string => Boolean(note)).join("\n\n") || undefined;

		const common = {
			agent,
			task: params.task,
			instructions,
			model,
			thinking: params.thinking,
			tools: params.tools,
			sessionFile,
			sessionName: `${agent.name}-subagent`,
			forkSessionFile: fork.forkSessionFile,
			cwd: childCwd,
			parentSessionId: safeSessionId(ctx),
			parentDepth: currentDepth + 1,
		};

		if (params.async ?? deps.config.asyncByDefault) {
			const job = asyncController.launch({ ...common, timeoutMs: params.timeoutMs });
			if (job.status === "failed" && job.error) {
				return {
					content: [{ type: "text", text: `subagent ${agent.name} failed to start: ${job.error}` }],
					isError: true,
					details: { mode: "async", results: [], progress: [], runId: job.runId },
				};
			}
			return {
				content: [{
					type: "text",
					text: `Started ${agent.name} in the background (run ${job.runId.slice(0, 8)}). You may continue; its result will be delivered separately.`,
				}],
				isError: false,
				details: { mode: "async", results: [], progress: [], runId: job.runId },
			};
		}

		return runSync({
			...common,
			runId,
			timeoutMs: params.timeoutMs ?? deps.config.defaultTimeoutMs,
			signal,
			onUpdate,
		});
	};

	return {
		execute,
		listAgents(cwd: string) {
			return discoverAgents(cwd, agentDir);
		},
		listRuns() {
			return asyncController.listRuns();
		},
		readAsyncResult(runId: string) {
			return asyncController.readResult(runId);
		},
		reconcile() {
			asyncController.reconcileStaleRuns();
			asyncController.cleanupOldRuns();
		},
		bindSession(ctx: ExtensionContext) {
			// Remember the session identity for child processes.
			process.env[SUBAGENT_PARENT_SESSION_ENV] = safeSessionId(ctx) ?? "";
		},
	};
}

function safeSessionFile(ctx: ExtensionContext): string | null {
	try {
		const file = ctx.sessionManager.getSessionFile();
		return typeof file === "string" && file ? file : null;
	} catch {
		return null;
	}
}

function safeSessionId(ctx: ExtensionContext): string | null {
	try {
		const id = ctx.sessionManager.getSessionId();
		return typeof id === "string" && id ? id : null;
	} catch {
		return null;
	}
}

/**
 * Last model the parent actually ran on. pi v3 sessions store entries as
 * {"type":"message", ..., "message":{role, model}} plus
 * {"type":"model_change", provider, modelId} records; the most recent
 * model_change is the most accurate signal, with the last assistant
 * message's model as fallback.
 */
export function resolveParentModel(ctx: { sessionManager: { getEntries?: () => unknown[] } }): string | undefined {
	let messageModel: string | undefined;
	try {
		const entries = ctx.sessionManager.getEntries?.() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; message?: { role?: string; model?: string }; provider?: string; modelId?: string } | undefined;
			if (!entry) continue;
			if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string" && entry.provider && entry.modelId) {
				return `${entry.provider}/${entry.modelId}`;
			}
			const msg = entry.message;
			if (msg?.role === "assistant" && typeof msg.model === "string" && msg.model && !messageModel) {
				messageModel = msg.model;
			}
		}
	} catch {
		// Model inheritance is best-effort; the child falls back to defaults.
	}
	return messageModel;
}