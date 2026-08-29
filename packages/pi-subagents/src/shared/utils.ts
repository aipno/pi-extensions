
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export { getAgentDir };

export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

/**
 * Write a file atomically: temp file in the same directory + rename. A crash
 * mid-write leaves either the old file or the new one, never a torn blob
 * (M9/N4: state files such as result.json / config.json are rebuilt from
 * disk on restart, so a half-written file would silently corrupt state).
 */
export function atomicWriteFileSync(file: string, data: string, options?: { mode?: number }): void {
	const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, data, options);
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// Best effort.
		}
		throw error;
	}
}

/**
 * Read the last `maxBytes` of a file. Used instead of full reads where only
 * the tail matters (transcript replay, stderr diagnostics): keeps memory and
 * I/O bounded regardless of how large the file grew (M4). The first line of
 * the tail may be split mid-line; callers must tolerate a partial line.
 * Returns "" when the file is missing/unreadable.
 */
export function readFileTail(filePath: string, maxBytes: number): string {
	try {
		const size = fs.statSync(filePath).size;
		if (size <= 0) return "";
		const offset = Math.max(0, size - maxBytes);
		const length = size - offset;
		const fd = fs.openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(length);
			let read = 0;
			while (read < length) {
				const chunk = fs.readSync(fd, buf, read, length - read, offset + read);
				if (chunk <= 0) break;
				read += chunk;
			}
			return buf.toString("utf-8", 0, read);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** Age after which a temp session root is swept (L3). */
const TEMP_SESSION_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort sweep of stale temp session roots created by
 * `getSubagentSessionRoot` for sessions that have no session file. Without
 * any cleanup path these directories (and the child session.jsonl files
 * under them) accumulated in /tmp forever; deleting dirs older than a day
 * bounds the leak without touching dirs that an in-flight session may still
 * be writing to. Cheap: one readdir of /tmp + one stat per candidate.
 */
function sweepOldTempSessionRoots(): void {
	const tmpDir = os.tmpdir();
	let entries;
	try {
		entries = fs.readdirSync(tmpDir, { withFileTypes: true });
	} catch {
		return;
	}
	const cutoff = Date.now() - TEMP_SESSION_ROOT_MAX_AGE_MS;
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("pi-subagent-session-")) continue;
		const dir = path.join(tmpDir, entry.name);
		try {
			if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	}
}

export function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	// No parent session file: children get a temp root. Sweep yesterday's
	// leftovers once per allocation so the leak stays bounded.
	sweepOldTempSessionRoots();
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

export function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
		let latest: { file: string; mtime: number } | null = null;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const full = path.join(sessionDir, entry.name);
			let mtime = 0;
			try {
				mtime = fs.statSync(full).mtimeMs;
			} catch {
				continue;
			}
			if (!latest || mtime > latest.mtime) latest = { file: full, mtime };
		}
		return latest?.file ?? null;
	} catch {
		return null;
	}
}

export function extractTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } =>
			typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** How many trailing assistant messages getFinalOutput joins. */
const FINAL_OUTPUT_MAX_MESSAGES = 3;

/**
 * Final output: the last clean assistant text. Subagents often spread a
 * report across several assistant messages (analysis, tool round-trips,
 * conclusion); taking only the last one silently drops everything written
 * before it. Walk backwards, skip error messages, and join up to
 * `maxMessages` non-error assistant texts in chronological order.
 */
export function getFinalOutput(messages: unknown[], maxMessages: number = FINAL_OUTPUT_MAX_MESSAGES): string {
	const texts: string[] = [];
	for (let i = messages.length - 1; i >= 0 && texts.length < maxMessages; i--) {
		const msg = messages[i] as { role?: string; content?: unknown; errorMessage?: string; stopReason?: string } | undefined;
		if (!msg || msg.role !== "assistant") continue;
		const hasError = typeof msg.errorMessage === "string" && msg.errorMessage.length > 0
			|| msg.stopReason === "error";
		if (hasError) continue;
		const text = extractTextFromContent(msg.content).trim();
		if (text.length > 0) texts.unshift(text);
	}
	return texts.join("\n\n");
}

export interface ErrorInfo {
	error: string;
	failed: boolean;
}

export function detectSubagentError(messages: unknown[]): ErrorInfo {
	for (const msg of messages) {
		const m = msg as { role?: string; errorMessage?: string; stopReason?: string; content?: unknown } | undefined;
		if (!m || m.role !== "assistant") continue;
		if (typeof m.errorMessage === "string" && m.errorMessage.trim()) {
			return { error: m.errorMessage.trim(), failed: true };
		}
		if (m.stopReason === "error") {
			const text = extractTextFromContent(m.content).trim();
			return { error: text || "Child agent reported an unknown error.", failed: true };
		}
	}
	return { error: "", failed: false };
}

export interface TruncationInfo {
	truncated: boolean;
	/** Path of the persisted complete output, when the marker carries one. */
	fullPath?: string;
}

/** Parse our truncation marker (with or without the full-output path). */
export function truncationInfo(text: string): TruncationInfo {
	const match = text.match(/… \[truncated(?: — full output: ([^\]]+))?\]/);
	if (!match) return { truncated: false };
	const fullPath = match[1];
	return fullPath ? { truncated: true, fullPath } : { truncated: true };
}

/**
 * Truncate a long output for inline delivery. When `fullOutputPath` is
 * given (the caller persisted the complete text), the marker points the
 * parent at the file so a truncated report is never lost:
 * `… [truncated — full output: <path>]` (parseable by truncationInfo).
 */
export function truncateOutput(text: string, maxChars: number, fullOutputPath?: string): string {
	if (text.length <= maxChars) return text;
	const marker = fullOutputPath
		? `\n… [truncated — full output: ${fullOutputPath}]`
		: "\n… [truncated]";
	return text.slice(0, maxChars) + marker;
}

/** The runs dir lives under the pi agent dir so it survives reloads. */
export function resolveRunsDir(agentDir: string): string {
	return path.join(agentDir, "subagents", "runs");
}

export function defaultRunsDir(): string {
	if (process.env.PI_SUBAGENT_RUNS_DIR) return process.env.PI_SUBAGENT_RUNS_DIR;
	return resolveRunsDir(path.join(os.homedir(), ".pi", "agent"));
}

/** Make a run id safe to use as a directory/file name (toolCallIds vary by provider). */
export function sanitizeRunId(runId: string): string {
	return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Best-effort persist of the complete subagent output under
 * `<runsDir>/<runId>/output.txt`, so a truncated inline result can point
 * the parent at the full text. Returns the file path, or null on failure.
 */
export function persistFullOutput(runsDir: string, runId: string, text: string): string | null {
	if (!text) return null;
	try {
		const dir = path.join(runsDir, sanitizeRunId(runId));
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "output.txt");
		fs.writeFileSync(file, text, "utf-8");
		return file;
	} catch {
		return null;
	}
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

export function formatTokens(count: number): string {
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

export function formatCost(cost: number): string {
	if (cost <= 0) return "";
	if (cost < 0.01) return `$${cost.toFixed(5)}`;
	return `$${cost.toFixed(3)}`;
}

export function shortenPath(p: string): string {
	const home = os.homedir();
	if (p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}