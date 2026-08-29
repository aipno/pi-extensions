/**
 * Background (async) subagent runs.
 *
 * Learned from nicobailon/pi-subagents src/runs/background/*:
 *
 * The child is spawned detached with its stdout tee'd to
 * <runsDir>/<runId>/output.jsonl. The parent promise resolves immediately;
 * a watcher re-reads the output file when the child exits and recovers the
 * full JSONL transcript exactly like a foreground run, then persists
 * result.json and emits an async-complete event.
 *
 * Because the state lives on disk, runs survive extension reloads and even
 * parent restarts; the extension reconciles "running" runs that outlived the
 * parent as interrupted on the next session_start.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../agents/agents.ts";
import type { AsyncJob, Details, SingleResult, ToolResult, Usage } from "../shared/types.ts";
import {
	atomicWriteFileSync,
	detectSubagentError,
	getFinalOutput,
	readFileTail,
	sanitizeRunId,
	truncateOutput,
} from "../shared/utils.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { buildPiArgs, cleanupTempDir } from "./pi-args.ts";
import { DEFAULT_MAX_OUTPUT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, emptyUsage } from "../shared/types.ts";

export interface AsyncLaunchOptions {
	agent: AgentConfig;
	task: string;
	instructions?: string;
	model?: string;
	thinking?: string | false;
	tools?: string[];
	sessionDir?: string;
	sessionFile?: string;
	sessionName?: string;
	forkSessionFile?: string | null;
	cwd?: string;
	parentSessionId?: string | null;
	parentDepth?: number;
	/** Optional wall-clock limit: the child is SIGTERM'd, then SIGKILL'd. */
	timeoutMs?: number;
}

export interface AsyncRunnerDeps {
	runsDir: string;
	retentionDays: number;
	onStarted?: (job: AsyncJob) => void;
	onComplete?: (job: AsyncJob, result: ToolResult<Details>) => void;
	events: { emit(channel: string, data: unknown): void };
}

export interface AsyncRunSummary {
	runId: string;
	agent: string;
	status: AsyncJob["status"];
	startedAt: number;
	finishedAt?: number;
}

export interface AsyncController {
	launch(options: AsyncLaunchOptions): AsyncJob;
	listRuns(): AsyncRunSummary[];
	readResult(runId: string): SingleResult | null;
	cleanupOldRuns(): void;
	reconcileStaleRuns(): void;
}

interface JsonlMessage {
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
}

/**
 * Replay the tail of the child's JSONL event stream. Bounded read: only the
 * last REPLAY_TAIL_BYTES are loaded — a run that wrote a huge transcript
 * must not make the parent read it all back after the child is gone (M4).
 * The final output only ever comes from the last messages, so the tail is
 * what matters; the first (possibly split) line is skipped by the parser.
 */
const REPLAY_TAIL_BYTES = 8 * 1024 * 1024;

function replayOutputFile(outputPath: string): { messages: unknown[]; usage: Usage; model?: string; settled: boolean } {
	const usage = emptyUsage();
	const messages: unknown[] = [];
	let model: string | undefined;
	let settled = false;
	const raw = readFileTail(outputPath, REPLAY_TAIL_BYTES);
	if (!raw) return { messages, usage, settled };
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let evt: { type?: string; message?: JsonlMessage };
		try {
			evt = JSON.parse(line) as typeof evt;
		} catch {
			continue;
		}
		if (evt.type === "message_end" && evt.message) {
			messages.push(evt.message);
			const msg = evt.message;
			if (msg.role === "assistant") {
				usage.turns++;
				if (msg.usage) {
					usage.input += msg.usage.input ?? 0;
					usage.output += msg.usage.output ?? 0;
					usage.cacheRead += msg.usage.cacheRead ?? 0;
					usage.cacheWrite += msg.usage.cacheWrite ?? 0;
					usage.cost += msg.usage.cost?.total ?? 0;
					usage.tokens = usage.input + usage.output;
				}
				if (msg.model) model = msg.model;
			}
		}
		if (evt.type === "agent_settled") settled = true;
	}
	return { messages, usage, model, settled };
}

/** Last ~4KB of the child stderr, for failure diagnostics. */
function stderrTail(stderrPath: string): string {
	const raw = readFileTail(stderrPath, 8192);
	const tail = raw.slice(-4096);
	return tail
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-5)
		.join(" | ");
}

function readStartedAt(runsDir: string, runId: string): number | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "started.json"), "utf-8")) as { startedAt?: number };
		return typeof parsed.startedAt === "number" ? parsed.startedAt : null;
	} catch {
		return null;
	}
}

function readAgentName(runsDir: string, runId: string): string | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "started.json"), "utf-8")) as { agent?: string };
		return parsed.agent ?? null;
	} catch {
		return null;
	}
}

/** The child's pid persisted at launch (M5: orphan cleanup after a crash). */
function readRunPid(runsDir: string, runId: string): { pid: number | null; parentPid: number | null } {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "started.json"), "utf-8")) as { pid?: number; parentPid?: number };
		return {
			pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 1 ? parsed.pid : null,
			parentPid: typeof parsed.parentPid === "number" && Number.isInteger(parsed.parentPid) && parsed.parentPid > 1 ? parsed.parentPid : null,
		};
	} catch {
		return { pid: null, parentPid: null };
	}
}

export function createAsyncController(deps: AsyncRunnerDeps): AsyncController {
	const { runsDir } = deps;
	try {
		fs.mkdirSync(runsDir, { recursive: true });
	} catch (error) {
		// M11: an unrunnable runs dir must not break extension registration;
		// individual launches report their own failures instead.
		console.error(`[pi-subagents] cannot create runs directory ${runsDir}:`, error);
	}
	const jobs = new Map<string, AsyncJob>();
	const watchTimers = new Map<string, NodeJS.Timeout>();
	/** runId -> exit code as observed live via the 'exit' listener (null until known). */
	const exitCodes = new Map<string, number | null>();
	/** runId -> prompt/task temp dir; deleted only when the run finalizes. */
	const tempDirs = new Map<string, string>();
	/** runId -> timeoutMs of runs that hit their wall-clock limit (M5). */
	const timedOutRuns = new Map<string, number>();

	/**
	 * Jobs map bound (M3): launch/reconcile keep adding finished runs forever;
	 * evict the oldest finished entries so long-lived sessions stay bounded.
	 * Live runs are never evicted.
	 */
	const MAX_TRACKED_JOBS = 200;
	const evictFinishedJobs = (): void => {
		if (jobs.size <= MAX_TRACKED_JOBS) return;
		const finished = [...jobs.values()]
			.filter((job) => job.status !== "running")
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(MAX_TRACKED_JOBS);
		for (const job of finished) jobs.delete(job.runId);
	};

	const writeResultFile = (runId: string, result: SingleResult): void => {
		try {
			// Keep messages: result.json is the self-contained recovery source
			// (output.jsonl holds the raw event stream, but reading a plain
			// result file is what the parent/tooling does).
			// M9: temp+rename so a crash mid-write never leaves a torn file
			// that would later be misread as a (phantom) completed result.
			atomicWriteFileSync(
				path.join(runsDir, runId, "result.json"),
				JSON.stringify(result, null, 2),
			);
		} catch (error) {
			console.error(`[pi-subagents] failed to persist result for ${runId}:`, error);
		}
	};

	/** Every finalize path must release the child's prompt/task temp dir. */
	const cleanupRunTempDir = (runId: string): void => {
		const tempDir = tempDirs.get(runId);
		if (!tempDir) return;
		tempDirs.delete(runId);
		cleanupTempDir(tempDir);
	};

	const persistAndEmit = (job: AsyncJob, result: SingleResult): void => {
		writeResultFile(job.runId, result);
		// M1: status.json must reflect the terminal state, not stay "running"
		// forever; the file is the on-disk record for tools/reconcilers.
		try {
			atomicWriteFileSync(
				path.join(runsDir, job.runId, "status.json"),
				JSON.stringify({ status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt }, null, 2),
			);
		} catch {
			// Best effort.
		}
		// at DEFAULT_MAX_OUTPUT and point the marker at the persisted full
		// result, which already holds the complete finalOutput (and messages).
		const resultPath = path.join(runsDir, job.runId, "result.json");
		const inlineText = result.error
			? `subagent ${job.agent} failed: ${result.error}`
			: truncateOutput(result.finalOutput || "(no output)", DEFAULT_MAX_OUTPUT, resultPath);
		const toolResult: ToolResult<Details> = {
			content: [{ type: "text", text: inlineText }],
			isError: Boolean(result.error),
			details: {
				mode: "async",
				results: [result],
				progress: [],
				runId: job.runId,
			},
		};
		deps.onComplete?.(job, toolResult);
		deps.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: job.runId, agent: job.agent, status: job.status, result: toolResult });
	};

	const failJob = (job: AsyncJob, message: string): void => {
		if (job.finishedAt) return; // already finalized
		job.status = "failed";
		job.error = message;
		job.exitCode = 1;
		job.finishedAt = Date.now();
		const result: SingleResult = {
			agent: job.agent,
			task: "",
			exitCode: 1,
			usage: emptyUsage(),
			messages: [],
			finalOutput: message,
			error: message,
			timedOut: false,
			interrupted: false,
			durationMs: job.finishedAt - job.startedAt,
		};
		cleanupRunTempDir(job.runId);
		persistAndEmit(job, result);
	};

	const finalizeRun = (runId: string): void => {
		const job = jobs.get(runId);
		if (!job) return;
		if (job.finishedAt) return; // already finalized (e.g. by the error path)

		cleanupRunTempDir(runId);

		const exitCode = exitCodes.get(runId); // null = spawn failure, undefined = unknown
		exitCodes.delete(runId);
		const timeoutMs = timedOutRuns.get(runId); // M5: wall-clock limit hit
		timedOutRuns.delete(runId);
		const { messages, usage, model, settled } = replayOutputFile(path.join(runsDir, runId, "output.jsonl"));
		const result: SingleResult = {
			agent: job.agent,
			task: "",
			exitCode: exitCode ?? (settled ? 0 : 1),
			model,
			usage,
			messages,
			finalOutput: "",
			timedOut: timeoutMs !== undefined,
			interrupted: false,
			durationMs: Date.now() - job.startedAt,
		};
		result.finalOutput = getFinalOutput(messages);

		let error: string | undefined;
		if (timeoutMs !== undefined) {
			error = `Subagent '${job.agent}' timed out after ${timeoutMs}ms.`;
		} else if (exitCode === null || exitCode === undefined) {
			error = "Subagent process failed to start.";
		} else if (exitCode !== 0 || !settled) {
			const detected = detectSubagentError(messages);
			const trailing = stderrTail(path.join(runsDir, runId, "stderr.log"));
			error = detected.error
				|| (settled ? `Subagent exited with code ${exitCode}.` : `Subagent did not finish cleanly (exit ${exitCode ?? "?"}).`)
				|| "Subagent failed.";
			if (!detected.error && trailing) error = `${error} stderr: ${trailing}`;
		} else if (!result.finalOutput) {
			const detected = detectSubagentError(messages);
			error = detected.error || "Subagent produced no output.";
		}
		if (error) {
			result.error = error;
			result.exitCode = exitCode ?? 1;
		}

		job.status = error ? "failed" : "completed";
		job.exitCode = result.exitCode;
		job.finishedAt = Date.now();
		job.result = result;
		job.error = error;
		persistAndEmit(job, result);
		evictFinishedJobs();
	};

	/** Kill a spawned child and its process group when the parent is dead (M5). */
	const killProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
		try {
			// Detached children own their process group; negative pid targets it.
			process.kill(-pid, signal);
		} catch {
			try {
				process.kill(pid, signal);
			} catch {
				// Already gone.
			}
		}
	};

	const launch = (options: AsyncLaunchOptions): AsyncJob => {
		const runId = randomUUID();
		const dir = path.join(runsDir, runId);
		const startedAt = Date.now();
		const job: AsyncJob = {
			runId,
			agent: options.agent.name,
			task: options.task,
			status: "running",
			exitCode: null,
			startedAt,
			cwd: options.cwd ?? process.cwd(),
		};
		jobs.set(runId, job);
		try {
			// M11: a run directory that cannot be created fails the job, not
			// the whole extension; the child pid is persisted for crash
			// recovery (M5).
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify({ runId, agent: job.agent, startedAt, task: "[task redacted]" }));
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ status: "running", startedAt }));
		} catch (error) {
			failJob(job, `Failed to initialize run directory: ${error instanceof Error ? error.message : String(error)}`);
			return job;
		}

		let built;
		try {
			built = buildPiArgs({
				agent: options.agent,
				task: options.task,
				runId,
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
			failJob(job, error instanceof Error ? error.message : String(error));
			return job;
		}
		// The temp dir holds prompt.md (and possibly task.md) that the child
		// reads lazily at startup; it must outlive the spawn call. It is
		// deleted in finalizeRun once the transcript has been replayed.
		tempDirs.set(runId, built.tempDir);

		const spawnSpec = getPiSpawnCommand(built.args);
		let stdoutFile: number;
		let stderrFile: number;
		try {
			stdoutFile = fs.openSync(path.join(dir, "output.jsonl"), "w");
			stderrFile = fs.openSync(path.join(dir, "stderr.log"), "w");
		} catch (error) {
			// M11: initialization failures fail the job, never the caller.
			failJob(job, `Failed to open run output files: ${error instanceof Error ? error.message : String(error)}`);
			return job;
		}
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(spawnSpec.command, spawnSpec.args, {
				cwd: options.cwd,
				env: { ...process.env, ...built.env },
				stdio: ["ignore", stdoutFile, stderrFile],
				detached: true,
				windowsHide: true,
			});
		} catch (error) {
			fs.closeSync(stdoutFile);
			fs.closeSync(stderrFile);
			failJob(job, `Failed to start '${job.agent}': ${error instanceof Error ? error.message : String(error)}`);
			return job;
		}
		fs.closeSync(stdoutFile);
		fs.closeSync(stderrFile);

		// Persist the child pid (and the parent pid) for crash recovery: a
		// future session_start can then tell orphaned processes from runs
		// whose parent is still alive (M5).
		try {
			fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify({ runId, agent: job.agent, startedAt, pid: proc.pid ?? null, parentPid: process.pid, task: "[task redacted]" }));
		} catch {
			// Best effort; orphan cleanup just won't fire for this run.
		}

		// Optional wall-clock limit (M5): SIGTERM at the deadline, SIGKILL 3s
		// later. The finalize path marks the result timedOut.
		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			const timeoutTimer = setTimeout(() => {
				if (job.finishedAt) return;
				timedOutRuns.set(runId, options.timeoutMs!);
				killProcessGroup(proc.pid ?? -1, "SIGTERM");
				const killTimer = setTimeout(() => {
					killProcessGroup(proc.pid ?? -1, "SIGKILL");
				}, 3000);
				killTimer.unref?.();
			}, options.timeoutMs);
			timeoutTimer.unref?.();
		}

		// Async spawn failures surface as an 'error' event (e.g. ENOENT for
		// the PATH fallback). Without a listener they would crash the parent.
		proc.on("error", (error) => {
			clearInterval(watchTimers.get(runId));
			watchTimers.delete(runId);
			if (job.finishedAt) return; // the poller may have finalized first
			exitCodes.delete(runId);
			cleanupRunTempDir(runId);
			job.status = "failed";
			job.error = `Failed to start '${job.agent}': ${error.message}`;
			job.exitCode = 1;
			job.finishedAt = Date.now();
			const result: SingleResult = {
				agent: job.agent,
				task: "",
				exitCode: 1,
				usage: emptyUsage(),
				messages: [],
				finalOutput: job.error,
				error: job.error,
				timedOut: false,
				interrupted: false,
				durationMs: job.finishedAt - job.startedAt,
			};
			persistAndEmit(job, result);
			evictFinishedJobs();
		});
		// L7: finalize from the real 'exit' event instead of relying on a
		// kill(pid, 0) probe (which can spin forever on pid reuse). For
		// detached children 'exit' still fires while the parent lives; the
		// poller below stays as a fallback for exotic cases.
		proc.on("exit", (code) => {
			exitCodes.set(runId, code);
			const poller = watchTimers.get(runId);
			if (poller) clearInterval(poller);
			watchTimers.delete(runId);
			finalizeRun(runId);
		});
		proc.unref();

		deps.onStarted?.(job);
		deps.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { runId, agent: job.agent });

		// Poll until the process is gone, then replay the transcript from
		// disk. In practice the 'exit' listener above finalizes first; this
		// covers cases where exit/close events are missed entirely.
		const timer = setInterval(() => {
			if (job.finishedAt) {
				// Already finalized by the error/exit path; stop polling.
				clearInterval(timer);
				watchTimers.delete(runId);
				return;
			}
			let alive = false;
			try {
				process.kill(proc.pid ?? -1, 0);
				alive = true;
			} catch {
				alive = false;
			}
			if (!alive) {
				clearInterval(timer);
				watchTimers.delete(runId);
				finalizeRun(runId);
			}
		}, 2000);
		timer.unref?.();
		watchTimers.set(runId, timer);

		return job;
	};

	const reconcileStaleRuns = (): void => {
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(runsDir);
		} catch {
			return;
		}
		// M7 + H1: cap the synchronous scan at the most recent entries and
		// never let one unreadable entry (dangling symlink, race, EACCES)
		// crash session_start. Older entries stay on disk for retention
		// cleanup; they are not rehydrated into the job map.
		const MAX_RECONCILE_ENTRIES = 200;
		const recent = entries
			.map((entry) => {
				try {
					const st = fs.statSync(path.join(runsDir, entry));
					return st.isDirectory() ? { entry, mtime: st.mtimeMs } : null;
			} catch {
				return null;
			}
		})
			.filter((item): item is { entry: string; mtime: number } => item !== null)
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, MAX_RECONCILE_ENTRIES);

		for (const { entry } of recent) {
			const dir = path.join(runsDir, entry);
			// Live runs are watched by an in-process poller; never touch them.
			if (jobs.has(entry)) continue;
			const startedAt = readStartedAt(runsDir, entry) ?? Date.now();
			if (fs.existsSync(path.join(dir, "result.json"))) {
				// Already finalized by a watcher (or a previous parent);
				// rehydrate the job map with the true status.
				const parsed = readResultFromFile(runsDir, entry);
				if (parsed) {
					jobs.set(entry, {
						runId: entry,
						agent: readAgentName(runsDir, entry) ?? "?",
						task: "",
						status: parsed.error ? "failed" : "completed",
						exitCode: parsed.exitCode ?? 0,
						startedAt,
						finishedAt: parsed.durationMs ? startedAt + parsed.durationMs : startedAt,
						cwd: "",
						...(parsed.error ? { error: parsed.error } : {}),
						result: parsed,
					});
					continue;
				}
				// M9: an unreadable/corrupt result.json must NOT be rehydrated
				// as a phantom "completed" run — fall through to transcript
				// recovery instead.
			}
			// A run whose parent died mid-run (or whose result.json is
			// corrupt): recover whatever transcript exists, mark it
			// interrupted/failed, and stop any still-live orphan process.
			const job = recoverOrphanRun(entry, dir, startedAt);
			if (job) {
				jobs.set(entry, job);
				if (job.result) writeResultFile(entry, job.result);
				try {
					atomicWriteFileSync(
						path.join(dir, "status.json"),
						JSON.stringify({ status: job.status, startedAt, finishedAt: job.finishedAt }, null, 2),
					);
				} catch {
					// Best effort.
				}
			}
		}
		evictFinishedJobs();
	};

	/**
	 * Recovery path for a run with no (readable) result.json (M8/M9): try to
	 * replay the transcript the child already produced before the parent
	 * died — a completed report must not be lost just because the parent
	 * crashed before persisting result.json. Also stops the orphan child
	 * process when its recorded parent is gone (M5). Returns null when the
	 * run belongs to a still-alive parent (another live session); such runs
	 * are left untouched.
	 */
	const recoverOrphanRun = (entry: string, dir: string, startedAt: number): AsyncJob | null => {
		const { pid, parentPid } = readRunPid(runsDir, entry);
		if (parentPid !== null) {
			try {
				process.kill(parentPid, 0);
				// The recorded parent is still alive (e.g. another session of
				// the same agent dir); it supervises this run — leave it alone.
				return null;
			} catch {
				// Parent is gone; proceed with recovery + orphan reaping.
			}
		}

		const job: AsyncJob = {
			runId: entry,
			agent: readAgentName(runsDir, entry) ?? "?",
			task: "",
			status: "interrupted",
			exitCode: null,
			startedAt,
			finishedAt: startedAt,
			cwd: "",
			error: "Parent session restarted before this run finished.",
		};

		// Replay the transcript (M8): the child may well have finished its
		// work even though the parent crashed before writing result.json.
		const recovery = replayOutputFile(path.join(dir, "output.jsonl"));
		if (recovery.settled || recovery.messages.length > 0) {
			const result: SingleResult = {
				agent: job.agent,
				task: "",
				exitCode: 0,
				model: recovery.model,
				usage: recovery.usage,
				messages: recovery.messages,
				finalOutput: getFinalOutput(recovery.messages),
				timedOut: false,
				interrupted: false,
				durationMs: Date.now() - startedAt,
			};
			const detected = detectSubagentError(recovery.messages);
			const error = detected.error
				|| (recovery.settled ? (result.finalOutput ? undefined : "Subagent produced no output.") : "Subagent did not finish cleanly (parent restarted before completion).");
			if (error) {
				result.error = error;
				result.exitCode = 1;
			}
			job.status = error ? "failed" : "completed";
			job.exitCode = result.exitCode;
			job.finishedAt = Date.now();
			job.result = result;
			job.error = error;
		}

		// M5: the child may still be alive and writing output.jsonl; its
		// parent is gone (checked above), so stop it. Identity-checked via
		// ps lstart to avoid killing a recycled pid.
		if (pid !== null) reapOrphanProcess(pid, startedAt);

		return job;
	};

	/**
	 * Kill a process only when it is really the orphan we launched: verify
	 * its start time via `ps -o lstart` against the run's startedAt (guards
	 * against pid reuse). Best-effort; never throws.
	 */
	const reapOrphanProcess = (pid: number, startedAt: number): void => {
		try {
			const out = String(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: 3000 })).trim();
			if (!out) return;
			const start = Date.parse(out);
			if (!Number.isFinite(start)) return;
			const drift = Math.abs(start - startedAt);
			if (drift > 120_000) return; // not the process we spawned
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000 });
			} else {
				killProcessGroup(pid, "SIGTERM");
				const killTimer = setTimeout(() => killProcessGroup(pid, "SIGKILL"), 5000);
				killTimer.unref?.();
			}
		} catch {
			// ps unavailable, or the process is already gone.
		}
	};

	const listRuns = (): AsyncRunSummary[] => {
		return [...jobs.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, 50)
			.map((job) => ({
				runId: job.runId,
				agent: job.agent,
				status: job.status,
				startedAt: job.startedAt,
				finishedAt: job.finishedAt,
			}));
	};

	const readResult = (runId: string): SingleResult | null => {
		// N2: never let an unsanitized runId reach a filesystem path.
		const safe = sanitizeRunId(runId);
		const job = jobs.get(safe);
		if (job?.result) return job.result;
		return readResultFromFile(runsDir, safe);
	};

	const cleanupOldRuns = (): void => {
		const retentionMs = deps.retentionDays * 86_400_000;
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(runsDir);
		} catch {
			return;
		}
		for (const entry of entries) {
			// N1: only runs that are LIVE here are protected from retention
			// cleanup. Reconcile rehydrates finished/interrupted runs into the
			// job map, so `jobs.has(entry)` alone would short-circuit every
			// entry and retention would never delete anything.
			const job = jobs.get(entry);
			if (job?.status === "running") continue;
			const dir = path.join(runsDir, entry);
			// Age the run by its recorded start time: reconcile's recovery
			// path writes status.json/result.json, which refreshes the
			// directory mtime and would otherwise keep an expired run alive
			// forever (every session_start bumped it). startedAt does not move.
			const startedAt = readStartedAt(runsDir, entry);
			let ageMs: number | null = null;
			if (startedAt !== null) {
				ageMs = Date.now() - startedAt;
			} else {
				try {
					ageMs = Date.now() - fs.statSync(dir).mtimeMs;
				} catch {
					continue;
				}
			}
			if (ageMs >= retentionMs) {
				try {
					fs.rmSync(dir, { recursive: true, force: true });
					jobs.delete(entry);
				} catch {
					// Best effort.
				}
			}
		}
	};

	return { launch, listRuns, readResult, cleanupOldRuns, reconcileStaleRuns };
}

function readResultFromFile(runsDir: string, runId: string): SingleResult | null {
	try {
		// N2: sanitize the runId before it reaches a filesystem path (runs
		// on disk always use sanitized ids; this closes the read side of the
		// escape surface, e.g. via executor.readAsyncResult).
		return JSON.parse(fs.readFileSync(path.join(runsDir, sanitizeRunId(runId), "result.json"), "utf-8")) as SingleResult;
	} catch {
		return null;
	}
}

/** The runs dir lives under the pi agent dir so it survives reloads. */
export { resolveRunsDir, defaultRunsDir } from "../shared/utils.ts";