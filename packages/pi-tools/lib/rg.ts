/**
 * ripgrep fast-path backend for the grep tool.
 *
 * Locates `rg` on PATH (never downloads it), spawns it with the same argument
 * set pi's built-in grep uses, and parses the `--json` event stream into the
 * same structured shape the pure-TS engine produces. When rg is unavailable,
 * the grep tool falls back to the TS engine.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as path from "node:path";
import { once } from "node:events";
import { access, stat } from "node:fs/promises";

export interface RgBackendOptions {
	/** Search root (absolute path). */
	root: string;
	/** True when `root` is a directory (false = single file). */
	rootIsDirectory: boolean;
	/** Pattern (already literal-escaped when `literal` is set). */
	pattern: string;
	/** Abort signal. */
	signal?: AbortSignal;
	/** Ignore case. */
	ignoreCase?: boolean;
	/** Literal (fixed-string) search. */
	literal?: boolean;
	/** Glob filter. */
	glob?: string;
	/** Global match limit (kills rg when reached, like pi). */
	limit?: number;
	/** Context lines (passed through to rg so its match set matches -C semantics). */
	context?: number;
}

interface RgMatchEvent {
	type: "match";
	data: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
		bytes?: string;
	};
}

export type RgMatch = {
	/** 1-based line number. */
	lineNumber: number;
	/** Raw line text (may contain trailing \n; caller normalizes). */
	lineText: string;
	/** Path reported by rg. */
	filePath: string;
};

export interface RgRunResult {
	matches: RgMatch[];
	/** True when the global limit killed rg mid-run. */
	limitReached: boolean;
}

let rgPathPromise: Promise<string | null> | undefined;

/** Locate `rg` on PATH (cached). Returns null when unavailable. */
export function findRg(): Promise<string | null> {
	rgPathPromise ??= (async () => {
		const paths = (process.env.PATH ?? "").split(path.delimiter);
		for (const dir of paths) {
			if (!dir) continue;
			for (const name of process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"]) {
				const candidate = path.join(dir, name);
				try {
					await access(candidate);
					await stat(candidate);
					return candidate;
				} catch {
					// keep scanning
				}
			}
		}
		return null;
	})();
	return rgPathPromise;
}

/**
 * Run rg with JSON output and collect match events. Resolves with the matches
 * (or an empty array when rg exits 1 = no matches). Throws on other failures.
 */
export async function runRg(options: RgBackendOptions): Promise<RgRunResult> {
	const rgPath = await findRg();
	if (!rgPath) throw new Error("rg not found on PATH");

	const { root, rootIsDirectory, pattern, signal, ignoreCase, literal, glob, limit, context } = options;
	const args = ["--json", "--line-number", "--color=never", "--hidden", "--no-messages", "--no-require-git"];
	if (ignoreCase) args.push("--ignore-case");
	if (literal) args.push("--fixed-strings");
	if (context && context > 0) args.push("--context", String(context));
	if (glob) args.push("--glob", glob);
	// Spawn with the search target as cwd so rg reports paths relative to it.
	const spawnCwd = rootIsDirectory ? root : path.dirname(root);
	const target = rootIsDirectory ? "." : path.basename(root);
	args.push("--", pattern, target);

	const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], cwd: spawnCwd });
	const rl = createInterface({ input: child.stdout });
	let stderr = "";
	let spawnError: Error | undefined;
	let matchCount = 0;
	const matches: RgMatch[] = [];
	let limitReached = false;
	let killedDueToLimit = false;
	let aborted = false;

	child.on("error", (err) => {
		spawnError = err;
	});

	const stopChild = (dueToLimit = false) => {
		if (!child.killed) {
			killedDueToLimit = dueToLimit;
			child.kill();
		}
	};
	const onAbort = () => {
		aborted = true;
		stopChild(false);
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	rl.on("line", (line) => {
		if (!line.trim()) return;
		if (limit !== undefined && matchCount >= limit) return;
		let event: RgMatchEvent;
		try {
			event = JSON.parse(line) as RgMatchEvent;
		} catch {
			return;
		}
		if (event.type !== "match") return;
		const filePath = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		const lineText = event.data?.lines?.text;
		if (!filePath || typeof lineNumber !== "number") return;
		matchCount++;
		matches.push({ lineNumber, lineText: lineText ?? "", filePath });
		if (limit !== undefined && matchCount >= limit) {
			limitReached = true;
			stopChild(true);
		}
	});

	try {
		const [code] = (await once(child, "close")) as [number | null];
		if (spawnError) throw spawnError;
		if (aborted) {
			throw new DOMException("Operation aborted", "AbortError");
		}
		if (!killedDueToLimit && code !== 0 && code !== 1) {
			const message = stderr.trim() || `ripgrep exited with code ${code}`;
			throw new Error(message);
		}
		return { matches, limitReached };
	} finally {
		rl.close();
		signal?.removeEventListener("abort", onAbort);
	}
}