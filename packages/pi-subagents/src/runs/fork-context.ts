/**
 * Forked-context support.
 *
 * Learned from nicobailon/pi-subagents src/shared/pruned-fork.ts /
 * src/shared/fork-context.ts:
 *
 * Agents like `oracle` and `worker` default to `context: fork`: the child
 * inherits a pruned copy of the parent conversation so it can honor decisions
 * the parent already made, without inheriting the full transcript noise
 * (tool outputs, images, ...). The child session file starts as this pruned
 * copy; the child appends its own turns to it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync, readFileTail } from "../shared/utils.ts";

export interface ForkContextConfig {
	mode: "pruned";
	maxTurns?: number;
}

const DEFAULT_FORK_MAX_TURNS = 12;
export { DEFAULT_FORK_MAX_TURNS };

/** Initial window for tail-limited parent session reads (M12). */
const INITIAL_TAIL_BYTES = 256 * 1024;
/** Growth step: double the window until it holds enough turns (or the whole file). */
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * pi session files store messages in the version-3 wrapped format:
 *
 *   {"type":"message","id":...,"parentId":...,"timestamp":...,
 *    "message":{"role":"user","content":[...],"model":...}}
 *
 * Older/foreign files may contain plain messages. Both shapes are accepted.
 */
interface WrappedOrFlatMessage {
	role?: string;
	content?: unknown;
	errorMessage?: string;
	stopReason?: string;
}

function unwrapEntry(entry: WrappedOrFlatMessage): WrappedOrFlatMessage {
	if (entry && typeof entry === "object" && !("role" in entry)) {
		const inner = (entry as { message?: unknown }).message;
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			return inner as WrappedOrFlatMessage;
		}
	}
	return entry;
}

/**
 * Copy the parent session file into `targetPath`, keeping the last
 * `maxTurns` assistant turns and only text content. Returns false when the
 * parent session is unavailable/empty so callers can fall back to fresh.
 *
 * The read is bounded: only the tail of the parent session is loaded first
 * (the kept window is always at the end of the file); the window grows only
 * when the tail does not contain enough assistant turns, so the common case
 * is O(256KB) regardless of how large the parent session grew (M12).
 */
export function createPrunedForkSessionFile(
	parentSessionFile: string,
	targetPath: string,
	maxTurns: number = DEFAULT_FORK_MAX_TURNS,
): { created: boolean; error?: string } {
	let size = 0;
	try {
		size = fs.statSync(parentSessionFile).size;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
		return { created: false, error: code ? `Cannot read the parent session (${code}).` : "Cannot read the parent session." };
	}
	if (size <= 0) return { created: false, error: "The parent session is empty." };

	let entries: WrappedOrFlatMessage[] = [];
	let assistantCount = 0;
	let window = Math.min(size, INITIAL_TAIL_BYTES);
	for (;;) {
		const raw = readFileTail(parentSessionFile, window);
		const parsed = parseSessionLines(raw);
		entries = parsed.entries;
		assistantCount = parsed.assistantCount;
		if (assistantCount >= maxTurns || window >= size || window >= MAX_TAIL_BYTES) break;
		window = Math.min(size, window * 2);
	}

	// Keep the last maxTurns assistant messages and the user messages that
	// immediately precede the kept window (the question behind the first
	// kept answer is part of the context the child needs).
	let keepFrom = 0;
	let seenAssistants = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.role === "assistant") seenAssistants++;
		if (seenAssistants >= maxTurns) {
			keepFrom = i;
			break;
		}
	}
	while (keepFrom > 0 && entries[keepFrom - 1]!.role === "user") keepFrom--;
	const kept = entries.slice(keepFrom);
	if (kept.length === 0) return { created: false, error: "The parent session has no textual messages to fork." };

	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id: path.basename(targetPath, ".jsonl"),
		timestamp: new Date().toISOString(),
		cwd: process.cwd(),
	};
	const lines = [JSON.stringify(header), ...kept.map((entry) => JSON.stringify(entry))];
	// Atomic write: the child reads this file at startup; a torn write would
	// silently truncate the forked context.
	try {
		atomicWriteFileSync(targetPath, lines.join("\n") + "\n", { mode: 0o600 });
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
		return { created: false, error: code ? `Cannot write the fork session (${code}).` : "Cannot write the fork session." };
	}
	return { created: true };
}

function parseSessionLines(raw: string): { entries: WrappedOrFlatMessage[]; assistantCount: number } {
	const entries: WrappedOrFlatMessage[] = [];
	let assistantCount = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: WrappedOrFlatMessage;
		try {
			entry = JSON.parse(line) as WrappedOrFlatMessage;
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const msg = unwrapEntry(entry);
		// Session headers, model changes and other non-message entries carry
		// no role; skip them.
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = extractText(msg.content);
		if (!text.trim()) continue;
		if (msg.role === "assistant") assistantCount++;
		entries.push({ role: msg.role, content: [{ type: "text", text }] });
	}
	return { entries, assistantCount };
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } =>
			typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
		.map((part) => part.text ?? "")
		.join("\n").trim();
}

/** Decide whether an agent run uses a fork and produce the fork session file. */
export function resolveForkSessionFile(input: {
	context?: "fork" | "fresh";
	agentDefaultContext?: "fork" | "fresh";
	forkConfig?: ForkContextConfig;
	parentSessionFile: string | null;
	childSessionFile: string;
}): { forkSessionFile: string | null; error?: string } {
	const wantsFork = (input.context ?? input.agentDefaultContext) === "fork";
	if (!wantsFork) return { forkSessionFile: null };
	if (!input.parentSessionFile) {
		return { forkSessionFile: null, error: "Fork context requested but no parent session file is available." };
	}
	const created = createPrunedForkSessionFile(
		input.parentSessionFile,
		input.childSessionFile,
		input.forkConfig?.maxTurns,
	);
	if (!created.created) return { forkSessionFile: null, error: created.error };
	return { forkSessionFile: input.childSessionFile };
}