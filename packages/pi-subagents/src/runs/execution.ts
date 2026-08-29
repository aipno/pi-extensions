/**
 * Foreground subagent execution.
 *
 * Learned from nicobailon/pi-subagents src/runs/foreground/execution.ts:
 *
 * The parent spawns the child with `pi --mode json -p` and decodes the
 * JSONL event stream:
 *
 *   {"type":"message_end","message":{role, content, usage, ...}}
 *   {"type":"tool_execution_start","toolName","args"}
 *   {"type":"tool_execution_end","toolName","toolCallId"}
 *   {"type":"agent_settled"}
 *
 * Progress updates are delivered through onUpdate with a compact snapshot
 * (bounded recent tools/output, running cost). Completion rules:
 *   - final output = last clean assistant message text
 *   - turn_end carries the final assistant message + usage
 *   - a timeout aborts via SIGTERM then SIGKILL
 *   - abort signals and errors map to interrupted/failed results
 */

import { spawn } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents/agents.ts";
import {
	type AgentProgress,
	type Details,
	type SingleResult,
	type ToolResult,
	type ToolCallSummary,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	MAX_RECENT_OUTPUT_LINES,
	MAX_RECENT_TOOLS,
	emptyUsage,
} from "../shared/types.ts";
import {
	detectSubagentError,
	extractTextFromContent,
	getFinalOutput,
	defaultRunsDir,
	persistFullOutput,
	truncateOutput,
} from "../shared/utils.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { buildPiArgs, cleanupTempDir, type BuildPiArgsResult } from "./pi-args.ts";

/** L6: cap the retained transcript for long foreground runs. */
const MAX_RESULT_MESSAGES = 500;

export interface RunSyncOptions {
	agent: AgentConfig;
	task: string;
	runId: string;
	instructions?: string;
	model?: string;
	thinking?: string | false;
	tools?: string[];
	sessionDir?: string;
	sessionFile?: string;
	sessionName?: string;
	forkSessionFile?: string | null;
	timeoutMs?: number;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<Details>) => void;
	cwd?: string;
	parentSessionId?: string | null;
	parentDepth?: number;
}

interface ChildEvent {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
		model?: string;
		errorMessage?: string;
		stopReason?: string;
	};
	toolName?: string;
	args?: unknown;
	toolCallId?: string;
	progress?: { error?: string } | null;
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	// Push incrementally: spreading a huge tool-result split() array can
	// blow the argument stack inside a stream data handler.
	let pushed = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		progress.recentOutput.push(trimmed);
		if (progress.recentOutput.length > MAX_RECENT_OUTPUT_LINES) {
			progress.recentOutput.splice(0, progress.recentOutput.length - MAX_RECENT_OUTPUT_LINES);
		}
		if (++pushed >= MAX_RECENT_OUTPUT_LINES) break;
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		task: "[task redacted]",
		recentTools: progress.recentTools.slice(-MAX_RECENT_TOOLS),
		recentOutput: progress.recentOutput.slice(-MAX_RECENT_OUTPUT_LINES),
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		task: "[task redacted]",
		messages: [],
		progress: snapshotProgress(progress),
	};
}

export async function runSync(options: RunSyncOptions): Promise<ToolResult<Details>> {
	const { agent, task } = options;
	const startTime = Date.now();
	const usage: Usage = emptyUsage();
	const progress: AgentProgress = {
		status: "running",
		agent: agent.name,
		task,
		turnCount: 0,
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		recentTools: [],
		recentOutput: [],
	};
	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		usage,
		messages: [],
		finalOutput: "",
		timedOut: false,
		interrupted: false,
		durationMs: 0,
		progress,
	};

	let built: BuildPiArgsResult | undefined;
	try {
		built = buildPiArgs({
			agent,
			task,
			runId: options.runId,
			instructions: options.instructions,
			model: options.model,
			thinking: options.thinking,
			tools: options.tools,
			sessionDir: options.sessionDir,
			sessionFile: options.sessionFile,
			sessionName: options.sessionName,
			forkSessionFile: options.forkSessionFile,
			childCwd: options.cwd,
			parentSessionId: options.parentSessionId,
			parentDepth: options.parentDepth,
		});
	} catch (error) {
		result.exitCode = 1;
		result.error = error instanceof Error ? error.message : String(error);
		result.finalOutput = result.error;
		progress.status = "failed";
		progress.error = result.error;
		progress.durationMs = Date.now() - startTime;
		return finalizeToolResult(result, progress, options);
	}

	const fireUpdate = (): void => {
		if (!options.onUpdate) return;
		progress.durationMs = Date.now() - startTime;
		const output = result.finalOutput || getFinalOutput(result.messages ?? []) || "(running...)";
		// M6: the onUpdate callback is external (pi runtime / other
		// extensions); an exception in it must not escape into the stream
		// data handler where it would kill the event loop.
		try {
			options.onUpdate({
				content: [{ type: "text", text: output }],
				details: {
					mode: "single",
					results: [snapshotResult(result, progress)],
					progress: [snapshotProgress(progress)],
					runId: options.runId,
				},
			});
		} catch (error) {
			console.error(`[pi-subagents] onUpdate callback threw:`, error);
		}
	};

	const spawnSpec = getPiSpawnCommand(built.args);
	const spawnEnv = { ...process.env, ...built.env };
	let childExited = false;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	let hardKillTimer: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	let finalDrainTimer: NodeJS.Timeout | undefined;
	/** Timer that resolves the promise from 'exit' when 'close' never fires (H2). */
	let exitDrainTimer: NodeJS.Timeout | undefined;

	const clearDeathTimers = () => {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (killTimer) clearTimeout(killTimer);
		if (hardKillTimer) clearTimeout(hardKillTimer);
		if (finalDrainTimer) clearTimeout(finalDrainTimer);
		if (exitDrainTimer) clearTimeout(exitDrainTimer);
		timeoutTimer = undefined;
		killTimer = undefined;
		hardKillTimer = undefined;
		finalDrainTimer = undefined;
		exitDrainTimer = undefined;
	};

	/** SIGTERM now, SIGKILL 3s later unless the child already exited (H2). */
	const killWithEscalation = (proc: ReturnType<typeof spawn>) => {
		if (childExited) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			return;
		}
		killTimer = setTimeout(() => {
			if (!childExited) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}, 3000);
		killTimer.unref?.();
	};

	// The child is expected to exit on its own shortly after `agent_settled` /
	// a terminal assistant stop. If it lingers, escalate SIGTERM -> SIGKILL.
	// A terminal stop means the final message is already flushed to the stream
	// protocol, so the child deserves a longer grace; without one it is stuck.
	let sawTerminalStop = false;
	const armFinalDrain = (proc: ReturnType<typeof spawn>): void => {
		if (childExited || finalDrainTimer) return;
		const graceMs = sawTerminalStop ? 3000 : 1500;
		finalDrainTimer = setTimeout(() => {
			if (childExited) return;
			proc.kill("SIGTERM");
			hardKillTimer = setTimeout(() => {
				if (!childExited) proc.kill("SIGKILL");
			}, 5000);
			hardKillTimer.unref?.();
		}, graceMs);
		finalDrainTimer.unref?.();
	};

	const exitCode = await new Promise<number>((resolveExit) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(spawnSpec.command, spawnSpec.args, {
				cwd: options.cwd,
				env: spawnEnv,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			result.exitCode = 1;
			result.error = `Failed to spawn pi for subagent '${agent.name}': ${error instanceof Error ? error.message : String(error)}`;
			progress.status = "failed";
			progress.error = result.error;
			resolveExit(1);
			return;
		}

		// Timeout handling: SIGTERM at deadline, SIGKILL 3s later (H2).
		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (childExited) return;
				result.timedOut = true;
				result.error = `Subagent '${agent.name}' timed out after ${options.timeoutMs}ms.`;
				result.finalOutput = result.error;
				progress.status = "failed";
				progress.error = result.error;
				fireUpdate();
				killWithEscalation(proc);
			}, options.timeoutMs);
			timeoutTimer.unref?.();
		}

		// Abort propagation (parent turn cancelled / stopped).
		if (options.signal) {
			if (options.signal.aborted) {
				// H2: an already-aborted signal kills immediately and escalates.
				killWithEscalation(proc);
			} else {
				abortListener = () => {
					// H2: SIGTERM may be ignored; escalate to SIGKILL 3s later.
					killWithEscalation(proc);
				};
				options.signal.addEventListener("abort", abortListener, { once: true });
			}
		}

		const processLine = (line: string): void => {
			if (!line.trim()) return;
			let evt: ChildEvent;
			try {
				evt = JSON.parse(line) as ChildEvent;
			} catch {
				// Non-JSON stdout lines (e.g. plain logs) are ignored.
				return;
			}
			if (evt.type === "agent_settled") {
				armFinalDrain(proc);
				return;
			}
			if (evt.type === "tool_execution_start" && evt.toolName) {
				progress.toolCount++;
				progress.currentTool = evt.toolName;
				const args = typeof evt.args === "object" && evt.args !== null && !Array.isArray(evt.args)
					? JSON.stringify(evt.args).slice(0, 300)
					: "";
				progress.recentTools.push({ tool: evt.toolName, args, endMs: Date.now() });
				// H3: recentTools must be capped at the source, not only in the
				// snapshot — otherwise a long run grows the array unboundedly
				// and every fireUpdate copies the whole thing.
				if (progress.recentTools.length > MAX_RECENT_TOOLS) {
					progress.recentTools.splice(0, progress.recentTools.length - MAX_RECENT_TOOLS);
				}
				fireUpdate();
				return;
			}
			if (evt.type === "tool_execution_end") {
				progress.currentTool = progress.currentTool === evt.toolName ? undefined : progress.currentTool;
				fireUpdate();
				return;
			}
			if (evt.type === "message_end" && evt.message) {
				const msg = evt.message;
				result.messages.push(msg);
				// L6: keep the transcript bounded for long runs; the tail is
				// what final output and error detection read anyway.
				if (result.messages.length > MAX_RESULT_MESSAGES) {
					result.messages.splice(0, result.messages.length - MAX_RESULT_MESSAGES);
				}
				if (msg.role === "assistant") {
					usage.turns++;
					progress.turnCount = usage.turns;
					if (msg.usage) {
						usage.input += msg.usage.input ?? 0;
						usage.output += msg.usage.output ?? 0;
						usage.cacheRead += msg.usage.cacheRead ?? 0;
						usage.cacheWrite += msg.usage.cacheWrite ?? 0;
						usage.cost += msg.usage.cost?.total ?? 0;
						usage.tokens = usage.input + usage.output;
						progress.tokens = usage.tokens;
					}
					if (msg.model) {
						progress.model = msg.model;
						if (!result.model) result.model = msg.model;
					}
					if (msg.stopReason === "stop") {
						sawTerminalStop = true;
						result.finalOutput = getFinalOutput(result.messages);
					}
				}
				appendRecentOutput(progress, extractTextFromContent(msg.content).split("\n"));
				fireUpdate();
				return;
			}
			if (evt.type === "turn_end" && evt.message && evt.message.role === "assistant") {
				// Final assistant message; settle the output early so the
				// exit path can trust result.finalOutput.
				result.finalOutput = getFinalOutput(result.messages);
			}
		};

		// JSON events can straddle read boundaries, so lines are assembled from
		// a pending buffer; only complete lines are handed to processLine.
		// setEncoding("utf8") uses a StringDecoder, which buffers incomplete
		// multi-byte sequences across chunks safely.
		// M6: every processLine invocation is guarded — a throwing handler
		// (JSON blob too deep, user onUpdate callback raising, ...) must
		// neither crash the parent nor silently swallow the rest of the event
		// stream. The loop continues with the next line.
		const safeProcessLine = (line: string): void => {
			try {
				processLine(line);
			} catch (error) {
				console.error(`[pi-subagents] error processing child event:`, error);
			}
		};
		const MAX_PENDING_LINE_BYTES = 32 * 1024 * 1024;
		let pendingLine = "";
		let pendingDropped = false;
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (text: string) => {
			if (pendingLine.length + text.length > MAX_PENDING_LINE_BYTES) {
				if (!pendingDropped) {
					// M10: surface an explicit warning in the progress output
					// instead of silently dropping gigabytes.
					pendingDropped = true;
					appendRecentOutput(progress, ["[child emitted an event line over 32MB; the line was dropped]"]);
				}
				pendingLine = "";
				// Keep everything after the FIRST newline of this chunk — the
				// oversized line is dropped, but complete lines that follow it
				// in the same chunk are still delivered (M10).
				const cut = text.indexOf("\n");
				if (cut !== -1) text = text.slice(cut + 1);
			}
			pendingLine += text;
			let nl = pendingLine.indexOf("\n");
			while (nl !== -1) {
				safeProcessLine(pendingLine.slice(0, nl));
				pendingLine = pendingLine.slice(nl + 1);
				nl = pendingLine.indexOf("\n");
			}
		});
		proc.stdout?.on("end", () => {
			if (pendingDropped) {
				// M10: the residue after a drop is the broken tail of the
				// oversized line (or an earlier line); never treat it as a
				// valid event, but make sure the reader knows something was cut.
				if (pendingLine.trim()) {
					appendRecentOutput(progress, ["[child output was truncated after an oversized event line]"]);
				}
				pendingLine = "";
			}
			if (pendingLine.length > 0) safeProcessLine(pendingLine);
		});
		proc.stderr?.on("data", (_chunk: Buffer) => {
			// Child stderr is intentionally not surfaced to the conversation;
			// it may contain provider/extension noise.
		});
		proc.on("error", (error) => {
			result.exitCode = 1;
			result.error = `Failed to spawn pi for subagent '${agent.name}': ${error.message}`;
			progress.status = "failed";
			progress.error = result.error;
			// Asynchronous spawn failures fire 'error' and then 'close' (no
			// 'exit'); resolve immediately so the tool call cannot hang.
			childExited = true;
			clearDeathTimers();
			resolveExit(1);
		});
		proc.on("exit", (code) => {
			// H2: 'close' may never fire when a grandchild inherited the
			// stdout pipe fd — the child itself is gone though, and the exit
			// code is authoritative. Give stream events a short drain window
			// and then resolve from the exit code; the standard 'close' path
			// still wins when it fires first.
			if (childExited) return;
			childExited = true;
			clearDeathTimers();
			exitDrainTimer = setTimeout(() => {
				exitDrainTimer = undefined;
				resolveExit(code ?? -1);
			}, 1000);
			exitDrainTimer.unref?.();
		});
		proc.on("close", (code) => {
			childExited = true;
			clearDeathTimers();
			// 'close' fires after stdio are drained, so trailing stream events
			// (final message_end with usage) are processed before this point.
			resolveExit(code ?? -1);
		});
	});

	if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);

	// Post-exit finalization.
	result.durationMs = Date.now() - startTime;
	progress.durationMs = result.durationMs;

	if (options.signal?.aborted && !result.timedOut) {
		result.interrupted = true;
		if (!result.error) result.error = "Subagent was interrupted.";
		progress.status = "interrupted";
		progress.error = result.error;
	}
	if (!result.finalOutput) result.finalOutput = getFinalOutput(result.messages);
	if (result.exitCode !== 0 && !result.error && !result.timedOut && !result.interrupted) {
		const detected = detectSubagentError(result.messages);
		result.error = detected.error || `Subagent exited with code ${result.exitCode}.`;
		progress.status = "failed";
		progress.error = result.error;
	}
	if (!result.error && result.finalOutput) {
		progress.status = "completed";
	} else if (!result.error) {
		const detected = detectSubagentError(result.messages);
		if (detected.failed) {
			result.error = detected.error;
			progress.status = "failed";
			progress.error = detected.error;
		} else {
			result.error = "Subagent produced no output.";
			progress.status = "failed";
			progress.error = result.error;
		}
	}

	if (built) cleanupTempDir(built.tempDir);
	// Persist the complete output to <runsDir>/<runId>/output.txt before
	// truncating. When the inline result has to be cut at DEFAULT_MAX_OUTPUT,
	// the marker points the parent at the full text (fixes the hard-limit
	// truncation that used to leave no recoverable copy for foreground runs).
	const finalText = result.finalOutput || result.error || "";
	const fullOutputPath = persistFullOutput(defaultRunsDir(), options.runId, finalText);
	result.finalOutput = truncateOutput(finalText, DEFAULT_MAX_OUTPUT, fullOutputPath ?? undefined);
	return finalizeToolResult(result, progress, options);
}

function finalizeToolResult(
	result: SingleResult,
	progress: AgentProgress,
	options: RunSyncOptions,
): ToolResult<Details> {
	const finalOutput = result.finalOutput || result.error || "(no output)";
	const isError = Boolean(result.error) || result.exitCode !== 0 || result.timedOut || result.interrupted;
	const details: Details = {
		mode: "single",
		results: [snapshotResult(result, progress)],
		progress: [snapshotProgress(progress)],
		runId: options.runId,
	};
	if (!options.onUpdate) {
		// Non-streamed callers still receive a fresh snapshot.
		progress.durationMs = result.durationMs;
	}
	return {
		content: [{ type: "text", text: isError ? `subagent ${result.agent} failed: ${finalOutput}` : finalOutput }],
		isError,
		details,
	};
}