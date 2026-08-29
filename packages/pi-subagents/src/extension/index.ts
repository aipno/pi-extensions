/**
 * Extension registration: the `subagent` tool, message renderers, slash
 * commands, and session lifecycle wiring.
 *
 * Learned from nicobailon/pi-subagents src/extension/index.ts.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import * as path from "node:path";
import { createSubagentParamsSchema } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import { createSubagentExecutor, type SubagentExecutor } from "../runs/executor.ts";
import { SUBAGENT_CHILD_ENV } from "../runs/pi-args.ts";
import { defaultRunsDir, truncationInfo } from "../shared/utils.ts";
import {
	type AsyncJob,
	type Details,
	type ToolResult,
	SUBAGENT_NOTIFY_MESSAGE_TYPE,
	SUBAGENTS_RUN_MESSAGE_TYPE,
	SUBAGENTS_CONFIG_MESSAGE_TYPE,
	SUBAGENT_RUN_RESULT_MESSAGE_TYPE,
} from "../shared/types.ts";
import {
	renderAsyncNotify,
	renderConfigCard,
	renderRunsList,
	renderSubagentCall,
	renderSubagentResult,
	ResultBox,
} from "./render.ts";
import { registerSlashCommands } from "../slash/commands.ts";

const paramsSchema = createSubagentParamsSchema();
export type SubagentToolParams = Static<typeof paramsSchema>;

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "interrupted";
	taskInfo?: string;
	durationMs?: number;
	resultPreview: string;
	runId: string;
	sessionLabel?: string;
	sessionValue?: string;
	cost?: number;
	tokens?: number;
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	// Children of a subagent tree do not re-register the parent runtime.
	if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

	const config = loadConfig();

	// The executor owns agent discovery, child spawning, and background runs.
	// It is created once at registration; session_start only rebinds it to
	// the active session (reload-safe, per reference runtime registry design).
	const executor: SubagentExecutor = createSubagentExecutor({
		config,
		events: pi.events,
		onAsyncComplete: (job, result) => handleAsyncComplete(pi, executor, job, result),
	});

	const handleAsyncComplete = (pi: ExtensionAPI, _executor: SubagentExecutor, job: AsyncJob, result: ToolResult<Details>): void => {
		// This runs inside the 2s poller callback / exit handler of the async
		// runner; any exception here would escape as an uncaught error and
		// could take the whole runtime down (M6 family).
		try {
			const single = result.details?.results?.[0];
			const preview = single?.finalOutput ?? job.error ?? "(no output)";
			const details: SubagentNotifyDetails = {
				agent: job.agent,
				status: job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : "interrupted",
				durationMs: job.finishedAt ? job.finishedAt - job.startedAt : undefined,
				resultPreview: preview,
				runId: job.runId,
				// L4: old/corrupt result files may lack usage entirely.
				cost: single?.usage?.cost,
				tokens: single?.usage?.tokens,
			};
			// The inline content must stay small; when the report is longer than
			// the preview window (or truncated), point at the persisted full
			// result instead of silently cutting it.
			const reportPath = path.join(defaultRunsDir(), job.runId, "result.json");
			const previewCut = preview.length > 120 || truncationInfo(preview).truncated;
			const contentPreview = previewCut ? `${preview.slice(0, 120)}… [full output: ${reportPath}]` : preview;
			pi.sendMessage(
				{
					customType: SUBAGENT_NOTIFY_MESSAGE_TYPE,
					content: `${details.agent} ${details.status}: ${contentPreview}`,
					details,
					display: true,
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			console.error(`[pi-subagents] failed to deliver async completion for ${job.runId}:`, error);
		}
	};

	// ------------------------------------------------------------------
	// Message renderers (custom message types shown in the transcript)
	// ------------------------------------------------------------------
	pi.registerMessageRenderer<SubagentNotifyDetails>(SUBAGENT_NOTIFY_MESSAGE_TYPE, (message, _options, theme) => {
		if (!message.details) return undefined;
		return renderAsyncNotify(message.details, theme);
	});

	pi.registerMessageRenderer<{ path: string; message?: string; entries: Array<{ key: string; value: string; source: "default" | "file" }> }>(
		SUBAGENTS_CONFIG_MESSAGE_TYPE,
		(message, _options, theme) => {
			if (!message.details) return undefined;
			return renderConfigCard(message.details, theme);
		},
	);

	pi.registerMessageRenderer<{ runs: Array<{ runId: string; agent: string; status: string; startedAt: number; finishedAt?: number }> }>(
		SUBAGENTS_RUN_MESSAGE_TYPE,
		(message, _options, theme) => {
			if (!message.details) return undefined;
			return renderRunsList(message.details, theme);
		},
	);

	// Result of `/run <agent> ...` rendered as a result card.
	pi.registerMessageRenderer<Details>(SUBAGENT_RUN_RESULT_MESSAGE_TYPE, (message, options, theme) => {
		if (!message.details) return undefined;
		const result: ToolResult<Details> = {
			content: Array.isArray(message.content) && message.content.length > 0
				? message.content
				: [{ type: "text", text: typeof message.content === "string" ? message.content : "" }],
			isError: (message.details as Details).results?.some((r) => r.error) ?? false,
			details: message.details as Details,
		};
		return ResultBox(result, options, theme);
	});

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------
	registerSlashCommands(pi, { executor, config });

	// ------------------------------------------------------------------
	// Session lifecycle
	// ------------------------------------------------------------------
	pi.on("session_start", (_event, ctx) => {
		executor.bindSession(ctx);
		executor.reconcile();
	});

	pi.on("session_shutdown", () => {
		// Async children are OS-owned detached processes; nothing to stop.
		// Their results are reconciled from disk on the next session_start.
	});

	// ------------------------------------------------------------------
	// The subagent tool
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a focused task to a child agent running in its own pi session, then bring the result back.",
			"Agents: scout (codebase recon), worker (implementation), reviewer (evidence-based review), oracle (second opinion), researcher (web research), delegate (general-purpose), or custom agents defined in .pi/subagents/ or ~/.pi/agent/subagents/ as frontmatter .md files.",
			"async defaults to background (recommended for long tasks); pass async:false to stream progress in the current conversation.",
			"context:\"fork\" seeds the child with a pruned copy of this conversation so it can honor decisions already made.",
		].join("\n"),
		parameters: paramsSchema,
		async execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},
		renderResult(result, options, theme) {
			const r = result as ToolResult<Details>;
			if (r.details?.mode === "async" || r.details?.mode === "management") {
				return renderSubagentResult(r, options, theme);
			}
			return ResultBox(r, options, theme);
		},
	});
}