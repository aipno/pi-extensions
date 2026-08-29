import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/pi-args.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const baseAgent: AgentConfig = {
	name: "t",
	description: "test agent",
	systemPrompt: "You are a test agent.",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "builtin",
	filePath: "/tmp/t.md",
};

function argsFor(overrides: Partial<AgentConfig> = {}, extra: { model?: string; thinking?: string | false } = {}): string[] {
	return buildPiArgs({
		agent: { ...baseAgent, ...overrides },
		task: "hello",
		runId: "run-1",
		tempDir: "/tmp/x",
		model: extra.model,
		thinking: extra.thinking,
	}).args;
}

test("thinking frontmatter alone produces --thinking without a model", () => {
	const args = argsFor({ thinking: "high" });
	assert.ok(args.includes("--thinking"), `args: ${args.join(" ")}`);
	assert.equal(args[args.indexOf("--thinking") + 1], "high");
	assert.ok(!args.includes("--model"), "no model pinned");
});

test("thinking: off produces --thinking off", () => {
	const args = argsFor({ thinking: false });
	assert.equal(args[args.indexOf("--thinking") + 1], "off");
});

test("model plus thinking rides the model suffix", () => {
	const args = argsFor({ model: "aipno/deepseek-v4-flash", thinking: "low" });
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "aipno/deepseek-v4-flash:low");
	assert.ok(!args.includes("--thinking"), "suffix carries the level");
});

test("explicit thinking override strips a conflicting model suffix", () => {
	// Agent model pins :high, run explicitly asks low -> suffix dropped,
	// --thinking low carries the override.
	const args = argsFor({ model: "aipno/deepseek-v4-flash:high" }, { thinking: "low" });
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "aipno/deepseek-v4-flash");
	assert.equal(args[args.indexOf("--thinking") + 1], "low");
});

test("same-level suffix keeps the model untouched", () => {
	const args = argsFor({ model: "aipno/deepseek-v4-flash:high" }, { thinking: "high" });
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "aipno/deepseek-v4-flash:high");
});

test("systemPromptMode append vs replace; skills/context flags", () => {
	const append = argsFor({ systemPromptMode: "append", inheritProjectContext: true, inheritSkills: true });
	assert.ok(append.includes("--append-system-prompt"));
	assert.ok(!append.includes("--no-context-files"));
	assert.ok(!append.includes("--no-skills"));

	const replace = argsFor({ inheritProjectContext: false, inheritSkills: false });
	assert.ok(replace.includes("--system-prompt"));
	assert.ok(replace.includes("--no-context-files"));
	assert.ok(replace.includes("--no-skills"));
});

test("tool allowlist and task delivery", () => {
	const args = argsFor({ tools: ["read", "grep"] });
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep");

	const longTask = buildPiArgs({
		agent: { ...baseAgent, inheritProjectContext: false, inheritSkills: false },
		task: "A".repeat(9000),
		runId: "run-2",
		tempDir: "/tmp/x",
	}).args;
	assert.ok(longTask.some((a) => a.startsWith("@")), "long tasks delivered via @file");
	assert.ok(!longTask.some((a) => a.startsWith("Task: A")), "no inline long task");
});

test("buildPiArgs never emits undefined env values (N3)", () => {
	const saved = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
	try {
		// Unset parent env: the key must be absent, not present-as-"undefined".
		delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
		const { env, tempDir } = buildPiArgs({ agent: baseAgent, task: "hi", runId: "run-1" });
		try {
			assert.ok(!("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT" in env), "unset key must be omitted");
			for (const value of Object.values(env)) {
				assert.notEqual(value, undefined, "no undefined env values may reach spawn");
			}
		} finally {
			cleanupTempDir(tempDir);
		}
		// Set parent env: the key is propagated verbatim.
		process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = "/pkg/root";
		const { env: env2, tempDir: tempDir2 } = buildPiArgs({ agent: baseAgent, task: "hi", runId: "run-1" });
		try {
			assert.equal(env2.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT, "/pkg/root");
		} finally {
			cleanupTempDir(tempDir2);
		}
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
		else process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = saved;
	}
});