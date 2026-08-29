/**
 * Resolve how to spawn the child `pi` process.
 *
 * Learned from nicobailon/pi-subagents src/runs/shared/pi-spawn.ts:
 *
 *   1. PI_SUBAGENT_PI_BINARY env override (explicit binary)
 *   2. The currently running executable when it is a standalone `pi` binary
 *   3. node + the pi CLI entry (`bin.pi` from the package.json that owns
 *      import.meta.resolve("@earendil-works/pi-coding-agent"))
 *   4. PATH fallback: `pi`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
				if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
			} catch {
				// Unreadable manifests are skipped; keep walking.
			}
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

function isRunnableNodeScript(filePath: string): boolean {
	if (!fs.existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function isStandalonePiExecutable(execPath: string): boolean {
	const executableName = execPath.split(/[\\/]/).pop();
	return /^pi(?:\.exe)?$/i.test(executableName ?? "");
}

export function resolvePiCliScript(): string | undefined {
	// Best shot: the CLI that started this process lives inside the pi package.
	try {
		const argv1 = process.argv[1];
		if (argv1 && isRunnableNodeScript(argv1)) {
			const canonical = fs.realpathSync(argv1);
			if (isRunnableNodeScript(canonical) && findPiPackageRootFromEntry(canonical)) {
				return canonical;
			}
		}
	} catch {
		// Keep resolving through the installed package.
	}

	// Fallback: resolve the installed package and read its bin entry.
	try {
		const packageRoot = findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
		if (!packageRoot) return undefined;
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = pkg.bin;
		const binPath = typeof binField === "string" ? binField : binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath || typeof binPath !== "string") return undefined;
		const candidate = path.resolve(packageRoot, binPath);
		if (isRunnableNodeScript(candidate)) return candidate;
	} catch {
		// Verified resolution is optional; PATH fallback below handles it.
	}
	return undefined;
}

export function getPiSpawnCommand(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
	const piBinary = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
	if (piBinary) return { command: piBinary, args };

	if (isStandalonePiExecutable(process.execPath)) {
		return { command: process.execPath, args };
	}

	const piCliPath = resolvePiCliScript();
	if (piCliPath) {
		return { command: process.execPath, args: [piCliPath, ...args] };
	}

	return { command: "pi", args };
}