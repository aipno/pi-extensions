import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyConfigUpdates,
	loadConfig,
	parseConfigUpdates,
	readConfigFile,
	writeConfigFile,
	type SubagentConfig,
} from "../../src/extension/config.ts";

const ORIGINAL_CONFIG_ENV = process.env.PI_SUBAGENT_CONFIG;

function withTempConfigFile(run: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-config-test-"));
	try {
		process.env.PI_SUBAGENT_CONFIG = path.join(dir, "config.json");
		run(dir);
	} finally {
		delete process.env.PI_SUBAGENT_CONFIG;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// parseConfigUpdates
// ---------------------------------------------------------------------------

test("parseConfigUpdates accepts all flat keys", () => {
	const parsed = parseConfigUpdates(["asyncByDefault=false", "defaultTimeoutMs=300000", "maxSubagentDepth=4", "runsRetentionDays=3"]);
	assert.ok(!("error" in parsed), "should not error");
	assert.equal(parsed.updates.asyncByDefault, false);
	assert.equal(parsed.updates.defaultTimeoutMs, 300000);
	assert.equal(parsed.updates.maxSubagentDepth, 4);
	assert.equal(parsed.updates.runsRetentionDays, 3);
});

test("parseConfigUpdates accepts the nested forkContext.maxTurns key", () => {
	const parsed = parseConfigUpdates(["forkContext.maxTurns=8"]);
	assert.ok(!("error" in parsed), "should not error");
	assert.deepEqual(parsed.updates.forkContext, { mode: "pruned", maxTurns: 8 });
});

test("parseConfigUpdates accepts defaultModel references and inherit keywords", () => {
	const plain = parseConfigUpdates(["defaultModel=aipno/deepseek-v4-flash"]);
	assert.ok(!("error" in plain));
	assert.equal(plain.updates.defaultModel, "aipno/deepseek-v4-flash");
	const withThinking = parseConfigUpdates(["defaultModel=anthropic/claude-sonnet-4-5:high"]);
	assert.ok(!("error" in withThinking));
	assert.equal(withThinking.updates.defaultModel, "anthropic/claude-sonnet-4-5:high");
	// inherit/unset/parent clear the override (undefined = remove key).
	for (const keyword of ["inherit", "unset", "parent"]) {
		const parsed = parseConfigUpdates([`defaultModel=${keyword}`]);
		assert.ok(!("error" in parsed));
		assert.equal(parsed.updates.defaultModel, undefined);
		assert.ok("defaultModel" in parsed.updates);
	}
});

test("parseConfigUpdates rejects malformed defaultModel values", () => {
	for (const bad of ["no-slash", "/leading", "trailing/", "provider/model:unknown", "provider/model extra", "a b/c"]) {
		const parsed = parseConfigUpdates([`defaultModel=${bad}`]);
		assert.ok("error" in parsed, `"${bad}" should be rejected`);
	}
});

test("parseConfigUpdates rejects tokens without =", () => {
	const parsed = parseConfigUpdates(["asyncByDefault"]);
	assert.ok("error" in parsed);
	assert.match(parsed.error, /expected key=value/);
});

test("parseConfigUpdates rejects unknown keys", () => {
	const parsed = parseConfigUpdates(["bogusKey=1"]);
	assert.ok("error" in parsed);
	assert.match(parsed.error, /Unknown key "bogusKey"/);
});

test("parseConfigUpdates rejects invalid booleans and non-positive integers", () => {
	assert.ok("error" in parseConfigUpdates(["asyncByDefault=yes"]));
	assert.ok("error" in parseConfigUpdates(["defaultTimeoutMs=abc"]));
	assert.ok("error" in parseConfigUpdates(["maxSubagentDepth=0"]));
	assert.ok("error" in parseConfigUpdates(["runsRetentionDays=-2"]));
	assert.ok("error" in parseConfigUpdates(["forkContext.maxTurns=1.5"]));
});

// ---------------------------------------------------------------------------
// writeConfigFile / readConfigFile / loadConfig
// ---------------------------------------------------------------------------

test("writeConfigFile creates the file and readConfigFile round-trips", () => {
	withTempConfigFile((dir) => {
		const error = writeConfigFile({ asyncByDefault: false, forkContext: { mode: "pruned", maxTurns: 5 } });
		assert.equal(error, null);
		const file = readConfigFile();
		assert.equal(file.asyncByDefault, false);
		assert.deepEqual(file.forkContext, { mode: "pruned", maxTurns: 5 });
		assert.ok(fs.existsSync(path.join(dir, "config.json")));
	});
});

test("writeConfigFile merges with existing file contents instead of replacing", () => {
	withTempConfigFile(() => {
		assert.equal(writeConfigFile({ maxSubagentDepth: 4 }), null);
		assert.equal(writeConfigFile({ asyncByDefault: true }), null);
		const file = readConfigFile();
		assert.equal(file.maxSubagentDepth, 4);
		assert.equal(file.asyncByDefault, true);
	});
});

test("writeConfigFile keeps forkContext.mode pinned to pruned", () => {
	withTempConfigFile(() => {
		assert.equal(writeConfigFile({ forkContext: { mode: "pruned", maxTurns: 5 } }), null);
		assert.equal(writeConfigFile({ forkContext: { mode: "pruned", maxTurns: 9 } }), null);
		const file = readConfigFile();
		assert.deepEqual(file.forkContext, { mode: "pruned", maxTurns: 9 });
	});
});

test("loadConfig merges defaults with file values", () => {
	withTempConfigFile(() => {
		assert.equal(writeConfigFile({ runsRetentionDays: 3 }), null);
		const config = loadConfig();
		assert.equal(config.asyncByDefault, true); // default
		assert.equal(config.maxSubagentDepth, 8); // default
		assert.equal(config.runsRetentionDays, 3); // from file
		assert.equal(config.forkContext, undefined); // not set
	});
});

// ---------------------------------------------------------------------------
// applyConfigUpdates (hot reload of the in-memory config)
// ---------------------------------------------------------------------------

test("applyConfigUpdates persists and mutates the in-memory config", () => {
	withTempConfigFile(() => {
		const config: SubagentConfig = loadConfig();
		const error = applyConfigUpdates(config, {
			asyncByDefault: false,
			defaultTimeoutMs: 60000,
			defaultModel: "aipno/deepseek-v4-flash",
			forkContext: { mode: "pruned", maxTurns: 6 },
		});
		assert.equal(error, null);
		// Effective immediately on the shared object.
		assert.equal(config.asyncByDefault, false);
		assert.equal(config.defaultTimeoutMs, 60000);
		assert.equal(config.defaultModel, "aipno/deepseek-v4-flash");
		assert.deepEqual(config.forkContext, { mode: "pruned", maxTurns: 6 });
		// And persisted for the next session.
		const file = readConfigFile();
		assert.equal(file.asyncByDefault, false);
		assert.equal(file.defaultTimeoutMs, 60000);
		assert.equal(file.defaultModel, "aipno/deepseek-v4-flash");
		assert.deepEqual(file.forkContext, { mode: "pruned", maxTurns: 6 });
	});
});

test("undefined values remove keys from both file and in-memory config", () => {
	withTempConfigFile(() => {
		const config: SubagentConfig = loadConfig();
		assert.equal(applyConfigUpdates(config, { defaultTimeoutMs: 60000, defaultModel: "aipno/deepseek-v4-flash", forkContext: { mode: "pruned", maxTurns: 4 } }), null);
		// Unset: present with undefined removes the stored key.
		const error = applyConfigUpdates(config, { defaultTimeoutMs: undefined, defaultModel: undefined, forkContext: undefined });
		assert.equal(error, null);
		assert.equal(config.defaultTimeoutMs, undefined);
		assert.equal(config.defaultModel, undefined);
		assert.equal(config.forkContext, undefined);
		const file = readConfigFile();
		assert.ok(!("defaultTimeoutMs" in file), "defaultTimeoutMs should be removed from the file");
		assert.ok(!("defaultModel" in file), "defaultModel should be removed from the file");
		assert.ok(!("forkContext" in file), "forkContext should be removed from the file");
		// Reloading falls back to defaults.
		assert.equal(loadConfig().defaultModel, undefined);
	});
});

test("loadConfig falls back to defaults when the config path is not a regular file (L5)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cfgdir-"));
	try {
		process.env.PI_SUBAGENT_CONFIG = dir; // a directory, not a file
		// Must return defaults without blocking on the read.
		assert.equal(loadConfig().asyncByDefault, true);
		assert.equal(loadConfig().runsRetentionDays, 7);
		assert.deepEqual(readConfigFile(), {});
		const error = writeConfigFile({ asyncByDefault: false });
		assert.ok(error?.includes("not a regular file"), error ?? "expected an error");
	} finally {
		delete process.env.PI_SUBAGENT_CONFIG;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("writeConfigFile leaves no temp files behind (N4)", () => {
	withTempConfigFile((dir) => {
		assert.equal(writeConfigFile({ asyncByDefault: false }), null);
		assert.equal(writeConfigFile({ maxSubagentDepth: 4 }), null);
		assert.deepEqual(fs.readdirSync(dir), ["config.json"], "no leftover temp files");
		const file = readConfigFile();
		assert.equal(file.asyncByDefault, false);
		assert.equal(file.maxSubagentDepth, 4);
	});
});