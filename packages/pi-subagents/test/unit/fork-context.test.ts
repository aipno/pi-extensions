import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPrunedForkSessionFile, resolveForkSessionFile } from "../../src/runs/fork-context.ts";

/**
 * Real pi v3 session files wrap messages:
 *   {"type":"message","id":...,"parentId":...,"timestamp":...,
 *    "message":{"role":"user","content":[...]}}
 */
function wrapped(role: string, content: unknown, id = Math.random().toString(36).slice(2)): string {
	return JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role, content } });
}

function writeParentSession(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const entries = [
		{ type: "session", version: 3, id: "parent", cwd: "/tmp" },
		{ type: "model_change", id: "m1", parentId: null, timestamp: new Date().toISOString(), provider: "aipno", modelId: "deepseek-v4-flash" },
		wrapped("user", [{ type: "text", text: "We decided SQLite + WAL." }]),
		wrapped("assistant", [{ type: "text", text: "Agreed." }]),
		wrapped("user", [{ type: "text", text: "Keep it simple." }]),
		wrapped("assistant", [{ type: "text", text: "Simplest correct change." }]),
		wrapped("user", [{ type: "text", text: "How should storage init look?" }]),
		wrapped("assistant", [{ type: "toolCall", content: [{ type: "toolCall", id: "c1" }] }]),
		wrapped("user", [{ type: "toolResult", content: [{ type: "text", text: "huge tool output" }] }]),
		wrapped("assistant", [{ type: "text", text: "Storage init in src/db.ts." }]),
	];
	fs.writeFileSync(file, entries.join("\n") + "\n");
}

test("pruned fork unwraps v3 session entries and keeps the last N assistant turns, text only", () => {
	const parent = path.join(os.tmpdir(), `suba-fork-parent-${Date.now()}.jsonl`);
	const target = path.join(os.tmpdir(), `suba-fork-${Date.now()}`, "session.jsonl");
	writeParentSession(parent);

	const { created } = createPrunedForkSessionFile(parent, target, 1);
	assert.equal(created, true);

	const lines = fs.readFileSync(target, "utf-8").split("\n").filter(Boolean);
	assert.ok(lines[0]!.includes('"type":"session"'), "session header written");
	const messages = lines.slice(1).map((l) => JSON.parse(l) as { role?: string; content?: unknown });
	assert.equal(messages.length, 2, "one assistant turn + its preceding user message");
	assert.equal(messages[0]!.role, "user");
	assert.equal(messages[1]!.role, "assistant");
	assert.ok(JSON.stringify(messages).includes("Storage init in src/db.ts"));
	assert.ok(!JSON.stringify(messages).includes("huge tool output"), "tool outputs pruned");
	assert.ok(!JSON.stringify(messages).includes("toolCall"), "tool calls pruned");
});

test("pruned fork accepts legacy flat message entries", () => {
	const parent = path.join(os.tmpdir(), `suba-flat-parent-${Date.now()}.jsonl`);
	const target = path.join(os.tmpdir(), `suba-flat-${Date.now()}`, "session.jsonl");
	fs.writeFileSync(parent, [
		JSON.stringify({ type: "session", version: 3, id: "p" }),
		JSON.stringify({ role: "user", content: [{ type: "text", text: "legacy question" }] }),
		JSON.stringify({ role: "assistant", content: [{ type: "text", text: "legacy answer" }] }),
	].join("\n"));
	const { created } = createPrunedForkSessionFile(parent, target, 3);
	assert.equal(created, true);
	const raw = fs.readFileSync(target, "utf-8");
	assert.ok(raw.includes("legacy answer"));
});

test("missing or empty parent session produces a concise error without the path", () => {
	const missing = path.join(os.tmpdir(), `suba-missing-${Date.now()}.jsonl`);
	const target = path.join(os.tmpdir(), `suba-missing-target-${Date.now()}.jsonl`);
	const { created, error } = createPrunedForkSessionFile(missing, target, 3);
	assert.equal(created, false);
	assert.ok(error?.includes("Cannot read the parent session"));
	assert.ok(!error?.includes(os.tmpdir()), "error must not leak the absolute session path");
});

test("resolveForkSessionFile honors context override over agent default", () => {
	const parent = path.join(os.tmpdir(), `suba-resolve-${Date.now()}.jsonl`);
	const target = path.join(os.tmpdir(), `suba-resolve-out-${Date.now()}`, "session.jsonl");
	writeParentSession(parent);

	const fork = resolveForkSessionFile({
		context: "fresh", // explicit user override: no fork even though agent defaults to fork
		agentDefaultContext: "fork",
		parentSessionFile: parent,
		childSessionFile: target,
	});
	assert.equal(fork.forkSessionFile, null);

	const fork2 = resolveForkSessionFile({
		context: "fork",
		agentDefaultContext: "fresh",
		parentSessionFile: parent,
		childSessionFile: target,
	});
	assert.equal(fork2.forkSessionFile, target);
	assert.ok(fs.existsSync(target));
});

test("pruned fork reads only a tail window of a huge parent session (M12)", () => {
	const parent = path.join(os.tmpdir(), `suba-big-parent-${Date.now()}.jsonl`);
	const target = path.join(os.tmpdir(), `suba-big-fork-${Date.now()}`, "session.jsonl");
	const lines: string[] = [];
	// ~3MB of filler (well beyond one 256KB tail window).
	for (let i = 0; i < 20_000; i++) {
		lines.push(JSON.stringify({ role: "user", content: [{ type: "text", text: `filler question ${i}` }] }));
		lines.push(JSON.stringify({ role: "assistant", content: [{ type: "text", text: `filler reply ${i}` }] }));
	}
	lines.push(JSON.stringify({ role: "user", content: [{ type: "text", text: "final question" }] }));
	lines.push(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "final answer" }] }));
	fs.mkdirSync(path.dirname(parent), { recursive: true });
	fs.writeFileSync(parent, lines.join("\n") + "\n");
	try {
		const { created } = createPrunedForkSessionFile(parent, target, 2);
		assert.equal(created, true, "fork must succeed from the tail window");
		const kept = fs.readFileSync(target, "utf-8");
		assert.ok(kept.includes("final answer"), "the last assistant turn is kept");
		assert.ok(kept.includes("final question"), "its preceding user message is kept");
		assert.ok(!kept.includes("filler question 0"), "the deep past is not forked");
		assert.ok(!kept.includes("filler reply 0"), "the deep past is not forked");
	} finally {
		fs.rmSync(parent, { force: true });
		fs.rmSync(path.dirname(target), { recursive: true, force: true });
	}
});