import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents, resolveAgentName } from "../../src/agents/agents.ts";

function makeTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
}

test("discovers builtin agents with parsed frontmatter", () => {
	const report = discoverAgents(os.tmpdir(), path.join(os.tmpdir(), "unused-agent-dir"));
	const names = report.agents.map((a) => a.name);
	for (const expected of ["scout", "worker", "reviewer", "oracle", "researcher", "delegate"]) {
		assert.ok(names.includes(expected), `missing builtin ${expected}`);
	}
	const worker = report.agents.find((a) => a.name === "worker");
	assert.equal(worker?.source, "builtin");
	assert.ok(worker?.aliases?.includes("coder"));
	assert.equal(worker?.defaultContext, "fork");
	assert.ok(worker?.systemPrompt.includes("implementation"));
});

test("user agents override builtins; project overrides user", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "suba-agents-"));
	const agentDir = path.join(root, "agent");
	makeTree(agentDir, {
		"subagents/scout.md": `---
name: scout
description: user scout
---
User scout body.
`,
	});
	const projectDir = path.join(root, "proj");
	makeTree(projectDir, {
		".pi/subagents/scout.md": `---
name: scout
description: project scout wins
---
Project scout body.
`,
		".pi/subagents/nested/team.md": `---
name: team
description: nested project agent
---
Team body.
`,
	});

	const report = discoverAgents(projectDir, agentDir);
	const scout = report.agents.find((a) => a.name === "scout");
	assert.equal(scout?.source, "project");
	assert.equal(scout?.description, "project scout wins");
	assert.ok(scout?.systemPrompt.includes("Project scout body"));
	assert.ok(report.agents.some((a) => a.name === "team"), "nested dir agent discovered");
});

test("resolves aliases and suggests fuzzy candidates for unknown names", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "suba-alias-"));
	const agentDir = path.join(root, "agent");
	const report = discoverAgents(root, agentDir);

	const { agent } = resolveAgentName("coder", report.agents);
	assert.equal(agent?.name, "worker");

	const unknown = resolveAgentName("scoutt", report.agents);
	assert.equal(unknown.agent, undefined);
	assert.ok(unknown.candidates.includes("scout"), `expected scout in ${unknown.candidates}`);
});

test("discoverAgents caches per cwd+agentDir within the TTL (L1)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "suba-cache-"));
	const agentDir = path.join(root, "agent");
	try {
		const a = discoverAgents(root, agentDir);
		const b = discoverAgents(root, agentDir);
		assert.equal(a, b, "second call within the TTL must hit the cache");
		const other = discoverAgents(path.join(root, "other"), agentDir);
		assert.notEqual(a, other, "a different cwd misses the cache");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("resolveAgentName tolerates maliciously long names without blowing up (L2)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "suba-long-"));
	const agentDir = path.join(root, "agent");
	try {
		const report = discoverAgents(root, agentDir);
		const longName = "x".repeat(100_000);
		const res = resolveAgentName(longName, report.agents);
		assert.equal(res.agent, undefined);
		assert.deepEqual(res.candidates, [], "length guard must skip edit-distance work");
		// A name whose length is close to an agent's still matches fuzzily.
		const near = resolveAgentName("scoutt", report.agents);
		assert.ok(near.candidates.includes("scout"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});