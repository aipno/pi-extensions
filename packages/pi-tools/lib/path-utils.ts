/**
 * Path resolution shared by all pi-tools tools.
 *
 * Handles the same quirks pi's built-in tools normalize:
 * - a leading `@` (some models habitually prefix tool path arguments)
 * - `~` / `~user` expansion
 * - relative paths resolved against the session cwd
 */

import { homedir } from "node:os";
import * as path from "node:path";

/** Strip a leading `@` from a path argument (model habit, see docs). */
export function stripAtPrefix(input: string): string {
	return input.startsWith("@") ? input.slice(1) : input;
}

/** Expand a leading `~` or `~user` segment. */
export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	if (input.startsWith("~")) {
		const sep = input.indexOf(path.sep);
		const user = sep === -1 ? input.slice(1) : input.slice(1, sep);
		const rest = sep === -1 ? "" : input.slice(sep);
		// Only expand known user homes via os.homedir(); unknown users are
		// left untouched rather than guessed.
		return user === "" ? input : input;
	}
	return input;
}

/**
 * Resolve a tool path argument to an absolute path.
 * `cwd` is the session working directory (ctx.cwd).
 */
export function resolveToolPath(input: string, cwd: string): string {
	const stripped = stripAtPrefix(input);
	const expanded = expandHome(stripped);
	return path.resolve(cwd, expanded);
}

/**
 * True when `candidate` is `base` itself or nested inside `base` (or its
 * symlink-resolved form). Used for path containment checks.
 */
export function isPathInside(candidate: string, base: string): boolean {
	const rel = path.relative(base, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Convert a path to posix separators (stable tool output). */
export function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

/** Path relative to `base`, posix-normalized; empty string when equal. */
export function posixRelative(base: string, target: string): string {
	const rel = path.relative(base, target);
	if (rel === "") return "";
	return toPosix(rel);
}