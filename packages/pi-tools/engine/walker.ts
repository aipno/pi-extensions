/**
 * Recursive directory walker with gitignore/.ignore support, symlink
 * protection and bounded concurrency.
 *
 * Semantics mirror ripgrep's traversal defaults:
 * - `.git` is never searched
 * - discovered symlinks are not followed (a symlink root argument is)
 * - `.gitignore` and `.ignore` files are honored, nested scopes override
 *   outer scopes, negation (`!`) re-includes
 * - hidden files ARE searched (rg `--hidden` behavior, matching pi's grep)
 */

import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { type IgnoreDecision, IgnoreMatcher, parseIgnoreFile } from "./gitignore.ts";
import { type GlobOptions, globToRegExp } from "./glob.ts";

export interface WalkOptions {
	/** Absolute path of the traversal root. */
	root: string;
	/** Abort signal (cancels traversal between files). */
	signal?: AbortSignal;
	/** Maximum concurrent file handles. */
	concurrency?: number;
	/** Optional glob filter on posix-relative paths (rg `--glob` semantics). */
	glob?: string;
	/** Glob options (ignoreCase). */
	globOptions?: GlobOptions;
	/** Maximum file size in bytes to report via onFile (files over this are skipped). Default 4 MiB. */
	maxFileBytes?: number;
	/** When true, `.gitignore`/`.ignore` files are ignored themselves. Default false. */
	noIgnore?: boolean;
	/** Called for every candidate file (skipped binary/large files still notify). */
	onFile: (file: CandidateFile) => Promise<void> | void;
	/** Called when a file is skipped (binary or oversized); optional diagnostics. */
	onSkip?: (file: CandidateFile, reason: "binary" | "too-large" | "glob") => void;
}

export interface CandidateFile {
	/** Absolute path. */
	absolutePath: string;
	/** Posix path relative to the traversal root. */
	relPath: string;
	/** File size in bytes. */
	size: number;
}

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

interface RuleScope {
	/** Posix path of the scope's base dir relative to the root ("" = root). */
	baseRel: string;
	matcher: IgnoreMatcher;
}

interface PendingDir {
	absolutePath: string;
	relPath: string;
	scopes: RuleScope[];
}

/**
 * Walk `root` and report candidates. Resolves when traversal completes or the
 * signal aborts (throws an AbortError).
 */
export async function walkFiles(options: WalkOptions): Promise<void> {
	const {
		root,
		signal,
		concurrency = DEFAULT_CONCURRENCY,
		glob,
		globOptions,
		maxFileBytes = DEFAULT_MAX_FILE_BYTES,
		noIgnore = false,
		onFile,
		onSkip,
	} = options;

	const globRe = glob ? globToRegExp(glob, globOptions) : undefined;

	// POSIX-normalized relative path from the root.
	const relOf = (abs: string): string => {
		const rel = path.relative(root, abs);
		return rel.split(path.sep).join("/");
	};

	const loadScopesForDir = async (absDir: string, relDir: string, parentScopes: RuleScope[]): Promise<RuleScope[]> => {
		const scopes = [...parentScopes];
		if (noIgnore) return scopes;
		for (const name of [".gitignore", ".ignore"]) {
			try {
				const stats = await stat(path.join(absDir, name));
				if (stats.size > 256 * 1024) continue;
				const content = await readFile(path.join(absDir, name));
				const patterns = parseIgnoreFile(content.toString("utf8"));
				if (patterns.length > 0) {
					scopes.push({ baseRel: relDir, matcher: new IgnoreMatcher(patterns) });
				}
			} catch {
				// No ignore file or unreadable: proceed without it.
			}
		}
		return scopes;
	};

	const decide = (relPath: string, isDir: boolean, scopes: RuleScope[]): IgnoreDecision => {
		let decision: IgnoreDecision = "none";
		for (const scope of scopes) {
			const relBase = scope.baseRel === "" ? relPath : relPath.slice(scope.baseRel.length + 1);
			if (relBase === "") continue; // the scope's own directory
			const d = scope.matcher.ignored(relBase, isDir);
			if (d !== "none") decision = d;
		}
		return decision;
	};

	const queue: PendingDir[] = [
		{
			absolutePath: root,
			relPath: "",
			scopes: noIgnore ? [] : await loadScopesForDir(root, "", []),
		},
	];

	const abortError = () => new DOMException("Operation aborted", "AbortError");
	if (signal?.aborted) throw abortError();

	const run = async (): Promise<void> => {
		const workers = Array.from(
			{ length: Math.max(1, concurrency) },
			() => workerLoop(),
		);
		await Promise.all(workers);
	};

	const workerLoop = async (): Promise<void> => {
		for (;;) {
			if (signal?.aborted) throw abortError();
			const dir = queue.shift();
			if (!dir) return;
			await processDir(dir);
			if (signal?.aborted) throw abortError();
		}
	};

	const processDir = async (dir: PendingDir): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir.absolutePath, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip silently (rg reports, but tools don't need it)
		}
		// Sub-scopes for this directory's children.
		const childScopes = await loadScopesForDir(dir.absolutePath, dir.relPath, dir.scopes);
		const files: Array<{ abs: string; rel: string }> = [];
		const dirs: Array<{ abs: string; rel: string }> = [];
		for (const entry of entries) {
			const isDir = entry.isDirectory();
			const isSymlink = entry.isSymbolicLink();
			const abs = path.join(dir.absolutePath, entry.name);
			const rel = dir.relPath === "" ? entry.name : `${dir.relPath}/${entry.name}`;
			// Never descend into .git.
			if (isDir && entry.name === ".git") continue;
			// Discovered symlinks are not followed (ripgrep default).
			if (isSymlink) continue;
			if (isDir) {
				const decision = decide(rel, true, childScopes);
				if (decision === "ignored") continue;
				dirs.push({ abs, rel });
			} else {
				const decision = decide(rel, false, childScopes);
				if (decision === "ignored") continue;
				if (globRe && !globRe.test(rel)) {
					onSkip?.({ absolutePath: abs, relPath: rel, size: 0 }, "glob");
					continue;
				}
				files.push({ abs, rel });
			}
		}
		// Deterministic order: names sorted, directories queued depth-first-after
		// files are emitted per directory (files first, then recurse).
		files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
		dirs.sort((a, b) => (a.rel < b.rel ? -1 : 1));

		for (const file of files) {
			if (signal?.aborted) throw abortError();
			try {
				const fileStat = await stat(file.abs);
				if (fileStat.size > maxFileBytes) {
					onSkip?.({ absolutePath: file.abs, relPath: file.rel, size: fileStat.size }, "too-large");
					continue;
				}
				await onFile({ absolutePath: file.abs, relPath: file.rel, size: fileStat.size });
			} catch {
				// File vanished or unreadable: skip.
			}
		}
		for (const sub of dirs) {
			if (signal?.aborted) throw abortError();
			queue.push({ absolutePath: sub.abs, relPath: sub.rel, scopes: childScopes });
		}
	};

	await run();
}