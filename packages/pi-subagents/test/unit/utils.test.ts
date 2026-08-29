import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	atomicWriteFileSync,
	defaultRunsDir,
	getFinalOutput,
	getSubagentSessionRoot,
	persistFullOutput,
	readFileTail,
	resolveRunsDir,
	sanitizeRunId,
	truncateOutput,
	truncationInfo,
} from "../../src/shared/utils.ts";

function textMsg(role: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { role, content: [{ type: "text", text }], ...extra };
}

test("getFinalOutput joins the last N assistant messages in order", () => {
	const messages = [
		{ role: "user", content: [] },
		textMsg("assistant", "First analysis."),
		{ role: "user", content: [{ type: "tool_result", content: "..." }] },
		textMsg("assistant", "Second pass."),
		textMsg("assistant", "Final conclusion."),
	];
	assert.equal(getFinalOutput(messages), "First analysis.\n\nSecond pass.\n\nFinal conclusion.");
});

test("getFinalOutput skips error messages and empty texts", () => {
	const messages = [
		textMsg("assistant", ""),
		textMsg("assistant", "good", { errorMessage: "boom" }),
		textMsg("assistant", "good", { stopReason: "error" }),
		textMsg("assistant", "  "),
		textMsg("assistant", "the report"),
	];
	assert.equal(getFinalOutput(messages), "the report");
});

test("getFinalOutput honors an explicit maxMessages bound", () => {
	const messages = [
		textMsg("assistant", "A"),
		textMsg("assistant", "B"),
		textMsg("assistant", "C"),
	];
	assert.equal(getFinalOutput(messages, 2), "B\n\nC");
	assert.equal(getFinalOutput(messages, 0), "");
});

test("getFinalOutput returns empty for no assistant text", () => {
	assert.equal(getFinalOutput([]), "");
	assert.equal(getFinalOutput([{ role: "user", content: [] }]), "");
});

test("truncateOutput keeps short text untouched", () => {
	assert.equal(truncateOutput("short", 12000), "short");
});

test("truncateOutput appends a plain marker without a path", () => {
	const out = truncateOutput("x".repeat(100), 10);
	assert.ok(out.endsWith("… [truncated]"));
	assert.equal(out.length, 10 + "\n… [truncated]".length);
});

test("truncateOutput marker carries the full-output path when given", () => {
	const out = truncateOutput("y".repeat(100), 10, "/tmp/runs/abc/output.txt");
	assert.ok(out.endsWith("… [truncated — full output: /tmp/runs/abc/output.txt]"));
});

test("truncationInfo parses the marker with and without a path", () => {
	assert.deepEqual(truncationInfo("plain text"), { truncated: false });
	assert.deepEqual(truncationInfo("body\n… [truncated]"), { truncated: true });
	assert.deepEqual(truncationInfo("body\n… [truncated — full output: /tmp/x.txt]"), {
		truncated: true,
		fullPath: "/tmp/x.txt",
	});
});

test("resolveRunsDir/defaultRunsDir stay consistent", () => {
	assert.equal(resolveRunsDir("/a/b"), path.join("/a/b", "subagents", "runs"));
	const saved = process.env.PI_SUBAGENT_RUNS_DIR;
	try {
		process.env.PI_SUBAGENT_RUNS_DIR = "/custom/runs";
		assert.equal(defaultRunsDir(), "/custom/runs");
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENT_RUNS_DIR;
		else process.env.PI_SUBAGENT_RUNS_DIR = saved;
	}
});

test("sanitizeRunId strips unsafe characters", () => {
	assert.equal(sanitizeRunId("call_abc123"), "call_abc123");
	assert.equal(sanitizeRunId("urn:uuid:1234-5678"), "urn_uuid_1234-5678");
});

test("persistFullOutput writes the full text and returns its path", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suba-persist-"));
	try {
		const full = "line1\nline2\n".repeat(5000); // > 12K
		const file = persistFullOutput(dir, "run:with/weird:id", full);
		assert.ok(file, "expected a persisted file path");
		assert.ok(file!.endsWith(path.join(dir, "run_with_weird_id", "output.txt")));
		assert.equal(fs.readFileSync(file!, "utf-8"), full);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("persistFullOutput returns null for empty text", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suba-persist-"));
	try {
		assert.equal(persistFullOutput(dir, "run", ""), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFileSync writes via temp+rename with no leftovers", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suba-atomic-"));
	try {
		const file = path.join(dir, "out.json");
		atomicWriteFileSync(file, '{"a":1}');
		assert.equal(fs.readFileSync(file, "utf-8"), '{"a":1}');
		// Overwrite works and never leaves temp files behind.
		atomicWriteFileSync(file, '{"b":2}');
		assert.equal(fs.readFileSync(file, "utf-8"), '{"b":2}');
		assert.deepEqual(fs.readdirSync(dir), ["out.json"], "no leftover temp files");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readFileTail returns the file tail and tolerates missing files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suba-tail-"));
	try {
		const file = path.join(dir, "big.txt");
		const body = "line1\nline2\nline3\n";
		fs.writeFileSync(file, body);
		assert.equal(readFileTail(file, 1000), body, "small file returns everything");
		assert.equal(readFileTail(file, 12), "line2\nline3\n");
		const partial = readFileTail(file, 5); // last 5 bytes: the tail of the last line
		assert.equal(partial, "ine3\n");
		assert.equal(readFileTail(path.join(dir, "missing"), 100), "");
		assert.equal(readFileTail(file, 0), "");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("getSubagentSessionRoot sweeps stale temp roots and creates a fresh one (L3)", () => {
	const stale = path.join(os.tmpdir(), `pi-subagent-session-stale-${Date.now()}`);
	fs.mkdirSync(stale, { recursive: true });
	fs.writeFileSync(path.join(stale, "session.jsonl"), "x\n");
	const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	fs.utimesSync(stale, past, past);
	try {
		const root = getSubagentSessionRoot(null);
		assert.ok(root.startsWith(path.join(os.tmpdir(), "pi-subagent-session-")), "fresh temp root created");
		assert.ok(!fs.existsSync(stale), "stale temp root swept");
		fs.rmSync(root, { recursive: true, force: true });
	} finally {
		fs.rmSync(stale, { recursive: true, force: true });
	}
});