import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BTW_SETTINGS_FILE,
	DEFAULT_REMEMBER_THINKING_LEVEL_CHANGES,
	btwSettingsPath,
	effectiveRememberThinkingLevelChanges,
	normalizeBtwSettings,
	parseBtwModelReference,
	readBtwSettings,
	updateBtwSettings,
} from "../settings.ts";

async function withTempSettings(run: (settingsPath: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-btw-settings-test-"));
	try {
		const settingsPath = join(directory, "nested", BTW_SETTINGS_FILE);
		await mkdir(join(directory, "nested"), { recursive: true });
		await run(settingsPath);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("btw settings default remembering on without materializing a missing file", async () => {
	await withTempSettings(async (settingsPath) => {
		assert.equal(DEFAULT_REMEMBER_THINKING_LEVEL_CHANGES, true);
		assert.deepEqual(await readBtwSettings(settingsPath), { kind: "missing" });
		assert.equal(effectiveRememberThinkingLevelChanges({}), true);
		await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
	});
});

test("update creates the file and persists known fields", async () => {
	await withTempSettings(async (settingsPath) => {
		const saved = await updateBtwSettings(
			{ thinkingLevel: "low", rememberThinkingLevelChanges: false },
			{ settingsPath },
		);
		assert.deepEqual(saved, { thinkingLevel: "low", rememberThinkingLevelChanges: false });
		assert.deepEqual(await readBtwSettings(settingsPath), {
			kind: "loaded",
			settings: { thinkingLevel: "low", rememberThinkingLevelChanges: false },
		});
	});
});

test("update preserves model and unknown fields while merging known keys", async () => {
	await withTempSettings(async (settingsPath) => {
		await writeFile(
			settingsPath,
			JSON.stringify({ model: "openrouter/anthropic/claude-sonnet", custom: 42 }),
			"utf8",
		);
		const saved = await updateBtwSettings(
			{ thinkingLevel: "high" },
			{ settingsPath },
		);
		assert.equal(saved.model, "openrouter/anthropic/claude-sonnet");
		const document = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.equal(document["model"], "openrouter/anthropic/claude-sonnet");
		assert.equal(document["custom"], 42);
		assert.equal(document["thinkingLevel"], "high");
	});
});

test("clearing thinkingLevel removes the key and keeps the rest", async () => {
	await withTempSettings(async (settingsPath) => {
		await updateBtwSettings({ thinkingLevel: "medium" }, { settingsPath });
		await updateBtwSettings({ thinkingLevel: undefined }, { settingsPath });
		const result = await readBtwSettings(settingsPath);
		assert.equal(result.kind, "loaded");
		if (result.kind === "loaded") {
			assert.equal(result.settings.thinkingLevel, undefined);
		}
	});
});

test("invalid JSON reports invalid without rewriting the file", async () => {
	await withTempSettings(async (settingsPath) => {
		await writeFile(settingsPath, "{not json", "utf8");
		const result = await readBtwSettings(settingsPath);
		assert.equal(result.kind, "invalid");
		if (result.kind === "invalid") assert.match(result.reason, /invalid JSON/);
		await assert.rejects(
			updateBtwSettings({ thinkingLevel: "low" }, { settingsPath }),
			/invalid JSON/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), "{not json");
	});
});

test("invalid shapes are rejected: bad thinkingLevel, non-string model, no boolean flag", async () => {
	for (const document of [
		{ thinkingLevel: "ultra" },
		{ model: 42 },
		{ model: "no-slash-here" },
		{ rememberThinkingLevelChanges: "yes" },
		{ thinkingLevel: 5 },
	]) {
		assert.equal(normalizeBtwSettings(document), undefined, JSON.stringify(document));
	}
	assert.deepEqual(normalizeBtwSettings(null), undefined);
	assert.deepEqual(normalizeBtwSettings([]), undefined);
	assert.deepEqual(normalizeBtwSettings("string"), undefined);
});

test("unknown fields are ignored by normalization but do not invalidate", () => {
	assert.deepEqual(normalizeBtwSettings({ model: "provider/model", other: "x" }), {
		model: "provider/model",
	});
});

test("a file that is not UTF-8 is rejected as invalid", async () => {
	await withTempSettings(async (settingsPath) => {
		await writeFile(settingsPath, Buffer.from([0xff, 0xfe, 0x00, 0x22]));
		const result = await readBtwSettings(settingsPath);
		assert.equal(result.kind, "invalid");
	});
});

test("oversized settings files are rejected", async () => {
	await withTempSettings(async (settingsPath) => {
		await writeFile(settingsPath, JSON.stringify({ filler: "x".repeat(70 * 1024) }), "utf8");
		const result = await readBtwSettings(settingsPath);
		assert.equal(result.kind, "invalid");
		if (result.kind === "invalid") assert.match(result.reason, /exceeds/);
	});
});

test("concurrent updates to the same path are serialized and both apply", async () => {
	await withTempSettings(async (settingsPath) => {
		const writes = await Promise.all([
			updateBtwSettings({ thinkingLevel: "low" }, { settingsPath }),
			updateBtwSettings({ rememberThinkingLevelChanges: false }, { settingsPath }),
		]);
		assert.equal(writes.length, 2);
		const result = await readBtwSettings(settingsPath);
		assert.equal(result.kind, "loaded");
		if (result.kind === "loaded") {
			assert.deepEqual(result.settings, {
				thinkingLevel: "low",
				rememberThinkingLevelChanges: false,
			});
		}
	});
});

test("abort signal cancels an update and leaves the file untouched", async () => {
	await withTempSettings(async (settingsPath) => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			updateBtwSettings({ thinkingLevel: "low" }, { settingsPath, signal: controller.signal }),
			(e: unknown) => e instanceof Error && e.name === "AbortError",
		);
		assert.deepEqual(await readBtwSettings(settingsPath), { kind: "missing" });
	});
});

test("parseBtwModelReference splits only on the first slash", () => {
	assert.deepEqual(parseBtwModelReference("openrouter/anthropic/claude-sonnet"), {
		provider: "openrouter",
		modelId: "anthropic/claude-sonnet",
	});
	assert.deepEqual(parseBtwModelReference("a/b"), { provider: "a", modelId: "b" });
	assert.equal(parseBtwModelReference("/b"), undefined);
	assert.equal(parseBtwModelReference("a/"), undefined);
	assert.equal(parseBtwModelReference("noslash"), undefined);
	assert.equal(parseBtwModelReference("a b/c"), undefined);
});

test("btwSettingsPath points into the agent directory", () => {
	assert.ok(btwSettingsPath().endsWith(`pi-btw.json`));
	assert.match(btwSettingsPath(), /[\\/]pi-btw\.json$/);
	purgeCache();
	function purgeCache() {
		// getAgentDir caches per process; nothing to purge here — assertion only.
		void 0;
	}
});