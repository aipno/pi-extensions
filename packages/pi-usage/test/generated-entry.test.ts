import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createMockContext, createMockPi } from "./support.ts";

const packageRoot = dirname(fileURLToPath(import.meta.url)) + "/..";

async function loadBuilder(): Promise<{
	buildRuntime(options?: { outputDirectory?: string }): Promise<unknown>;
}> {
	const builderUrl = pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href;
	return (await import(`${builderUrl}?test=${crypto.randomUUID()}`)) as never;
}

async function emit(
	events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
	name: string,
	...args: unknown[]
) {
	for (const handler of events.get(name) ?? []) await handler(...args);
}

test("generated entry preserves registration and partial lifecycle cleanup", async () => {
	// The runtime builder only writes inside package-owned directories.
	const root = mkdtempSync(join(packageRoot, ".pi-usage-build-test-generated-entry-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const builder = await loadBuilder();
		const output = join(root, "dist");
		await builder.buildRuntime({ outputDirectory: output });
		const { default: extension } = await import(pathToFileURL(join(output, "index.ts")).href);
		const mock = createMockPi();
		await extension(mock.pi);
		assert.ok(mock.commands.has("usage"));
		assert.ok(mock.commands.has("fast"));
		assert.ok(mock.events.has("session_start"));
		assert.ok(mock.events.has("session_shutdown"));
		const context = createMockContext({ mode: "tui", cwd: root });
		await emit(mock.events, "session_shutdown", { reason: "quit" }, context.ctx);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { force: true, recursive: true });
	}
});