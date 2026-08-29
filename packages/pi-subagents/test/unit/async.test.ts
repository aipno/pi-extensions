import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAsyncController } from "../../src/runs/async.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { emptyUsage } from "../../src/shared/types.ts";

const EVENTS = { emit() {} };

const FAKE_AGENT: AgentConfig = {
	name: "t",
	description: "test agent",
	systemPrompt: "You are a test agent.",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "builtin",
	filePath: "/tmp/t.md",
};

function tempRunsDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "suba-runs-test-"));
}

function makeResult(overrides: Partial<import("../../src/shared/types.ts").SingleResult> = {}): import("../../src/shared/types.ts").SingleResult {
	return {
		agent: "t",
		task: "",
		exitCode: 0,
		usage: emptyUsage(),
		messages: [],
		finalOutput: "done",
		timedOut: false,
		interrupted: false,
		durationMs: 1000,
		...overrides,
	};
}

function ageDir(dir: string, daysAgo: number): void {
	const then = new Date(Date.now() - daysAgo * 86_400_000);
	fs.utimesSync(dir, then, then);
}

// ---------------------------------------------------------------------------
// N1: retention cleanup must actually delete expired runs even after
// reconcileStaleRuns has rehydrated them into the job map.
// ---------------------------------------------------------------------------

test("cleanupOldRuns removes expired runs rehydrated by reconcile (N1)", () => {
	const runsDir = tempRunsDir();
	try {
		// Expired run with a readable result.json -> rehydrated as completed.
		const okDir = path.join(runsDir, "expired-ok");
		fs.mkdirSync(okDir, { recursive: true });
		const startedAt = Date.now() - 30 * 86_400_000;
		fs.writeFileSync(path.join(okDir, "started.json"), JSON.stringify({ runId: "expired-ok", agent: "t", startedAt }));
		fs.writeFileSync(path.join(okDir, "result.json"), JSON.stringify(makeResult()));
		ageDir(okDir, 30);

		// Expired run without result.json -> recovered as interrupted.
		const noResultDir = path.join(runsDir, "expired-nr");
		fs.mkdirSync(noResultDir, { recursive: true });
		fs.writeFileSync(path.join(noResultDir, "started.json"), JSON.stringify({ runId: "expired-nr", agent: "t", startedAt }));
		ageDir(noResultDir, 30);

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		controller.reconcileStaleRuns();
		// Both entries are now in the job map; retention must still clean them.
		controller.cleanupOldRuns();

		assert.ok(!fs.existsSync(okDir), "expired completed run must be removed");
		assert.ok(!fs.existsSync(noResultDir), "expired interrupted run must be removed");
		// A fresh run with a recent mtime survives.
		const freshDir = path.join(runsDir, "fresh");
		fs.mkdirSync(freshDir, { recursive: true });
		controller.cleanupOldRuns();
		assert.ok(fs.existsSync(freshDir), "recent run must be kept");
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// H1: unreadable/dangling entries in the runs dir must not crash reconcile.
// ---------------------------------------------------------------------------

test("reconcileStaleRuns tolerates dangling symlinks and plain files (H1)", () => {
	const runsDir = tempRunsDir();
	try {
		const dangling = path.join(runsDir, "dangling");
		try {
			fs.symlinkSync(path.join(runsDir, "does-not-exist"), dangling);
		} catch {
			// Symlinks unsupported (e.g. no privilege): skip that half.
		}
		fs.writeFileSync(path.join(runsDir, "plain.txt"), "not a run");
		const okDir = path.join(runsDir, "ok");
		fs.mkdirSync(okDir, { recursive: true });
		fs.writeFileSync(path.join(okDir, "started.json"), JSON.stringify({ runId: "ok", agent: "t", startedAt: Date.now() }));

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		assert.doesNotThrow(() => controller.reconcileStaleRuns());
		assert.doesNotThrow(() => controller.cleanupOldRuns());
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// M9: a corrupt result.json must not be rehydrated as a phantom completed run.
// ---------------------------------------------------------------------------

test("corrupt result.json is not rehydrated as a phantom completed run (M9)", () => {
	const runsDir = tempRunsDir();
	try {
		const dir = path.join(runsDir, "corrupt");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify({ runId: "corrupt", agent: "t", startedAt: Date.now() }));
		fs.writeFileSync(path.join(dir, "result.json"), "this is not json {{{");

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		controller.reconcileStaleRuns();

		const run = controller.listRuns().find((r) => r.runId === "corrupt");
		assert.ok(run, "run is listed");
		assert.notEqual(run!.status, "completed", "must not fabricate a completed status");
		assert.equal(controller.readResult("corrupt"), null);
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// M8: a finished transcript is recovered when the parent died before
// persisting result.json.
// ---------------------------------------------------------------------------

test("reconcile recovers a completed transcript without result.json (M8)", () => {
	const runsDir = tempRunsDir();
	try {
		const dir = path.join(runsDir, "recover");
		fs.mkdirSync(dir, { recursive: true });
		const startedAt = Date.now() - 60_000;
		// parentPid/pid set to dead values: parent is gone, no orphan to reap.
		fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify({ runId: "recover", agent: "t", startedAt, pid: 2_999_999, parentPid: 2_999_998 }));
		const lines = [
			JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "the task" }] } }),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Recovered report." }],
					usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 }, tokens: 30 },
					model: "provider/model",
				},
			}),
			JSON.stringify({ type: "agent_settled" }),
		];
		fs.writeFileSync(path.join(dir, "output.jsonl"), lines.join("\n") + "\n");

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		controller.reconcileStaleRuns();

		const result = controller.readResult("recover");
		assert.ok(result, "recovered result is readable");
		assert.ok(!result!.error, "settled transcript has no error");
		assert.equal(result!.finalOutput, "Recovered report.");
		assert.equal(result!.model, "provider/model");
		assert.ok(fs.existsSync(path.join(dir, "result.json")), "result.json persisted after recovery");
		const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8")) as { status: string };
		assert.equal(status.status, "completed");
		const run = controller.listRuns().find((r) => r.runId === "recover");
		assert.equal(run!.status, "completed");
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// M5: runs whose recorded parent is still alive are left completely alone.
// ---------------------------------------------------------------------------

test("reconcile leaves runs of a live parent untouched (M5)", () => {
	const runsDir = tempRunsDir();
	try {
		const dir = path.join(runsDir, "live");
		fs.mkdirSync(dir, { recursive: true });
		const startedAt = Date.now();
		fs.writeFileSync(
			path.join(dir, "started.json"),
			JSON.stringify({ runId: "live", agent: "t", startedAt, pid: process.pid, parentPid: process.pid }),
		);
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ status: "running", startedAt }));

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		controller.reconcileStaleRuns();

		assert.ok(!controller.listRuns().some((r) => r.runId === "live"), "run of a live parent must not be listed");
		const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8")) as { status: string };
		assert.equal(status.status, "running", "status file must stay untouched");
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// M1/M11: a launch whose spawn fails still persists a terminal status.json
// (status must not stay "running" forever).
// ---------------------------------------------------------------------------

test("launch that fails to spawn persists a terminal status (M1/M11)", async () => {
	const runsDir = tempRunsDir();
	const savedBinary = process.env.PI_SUBAGENT_PI_BINARY;
	process.env.PI_SUBAGENT_PI_BINARY = "/nonexistent/pi-binary";
	try {
		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		const job = controller.launch({ agent: FAKE_AGENT, task: "hello" });
		assert.equal(job.status, "running", "spawn errors surface on the error event");
		await new Promise((resolve) => setTimeout(resolve, 200));

		const status = JSON.parse(fs.readFileSync(path.join(runsDir, job.runId, "status.json"), "utf-8")) as { status: string };
		assert.equal(status.status, "failed", "status.json must carry the terminal state");
		const run = controller.listRuns().find((r) => r.runId === job.runId);
		assert.equal(run!.status, "failed");
	} finally {
		if (savedBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = savedBinary;
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// M11: an unrunnable runs dir must not break the controller or launch.
// ---------------------------------------------------------------------------

test("an unrunnable runs dir fails the job instead of the controller (M11)", () => {
	const blocker = path.join(os.tmpdir(), `suba-not-a-dir-${Date.now()}`);
	fs.writeFileSync(blocker, "I am a file, not a directory");
	try {
		// mkdirSync(runsDir) against a regular file throws; the controller must
		// swallow it at registration time.
		const controller = createAsyncController({ runsDir: blocker, retentionDays: 7, events: EVENTS });
		// launch must fail the job rather than throwing into the tool call.
		const job = controller.launch({ agent: FAKE_AGENT, task: "hello" });
		assert.equal(job.status, "failed");
		assert.ok(job.error?.includes("Failed to initialize run directory"), job.error);
	} finally {
		fs.rmSync(blocker, { force: true });
	}
});

// ---------------------------------------------------------------------------
// N2: readResult must sanitize runIds before touching the filesystem.
// ---------------------------------------------------------------------------

test("readResult sanitizes runIds before filesystem access (N2)", () => {
	const runsDir = tempRunsDir();
	try {
		const dir = path.join(runsDir, "call_1");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(makeResult()));

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		assert.ok(controller.readResult("call/1"), "unsafe runId resolves through its sanitized path");
		assert.equal(controller.readResult("../"), null, "traversal cannot escape");
		assert.equal(controller.readResult("../../etc/passwd"), null);
		assert.equal(controller.readResult("..%2F..%2Fetc"), null);
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// M4: replay only reads the tail of a huge transcript.
// ---------------------------------------------------------------------------

test("reconcile replays only the tail of a huge transcript (M4)", () => {
	const runsDir = tempRunsDir();
	try {
		const dir = path.join(runsDir, "huge");
		fs.mkdirSync(dir, { recursive: true });
		const startedAt = Date.now() - 60_000;
		fs.writeFileSync(path.join(dir, "started.json"), JSON.stringify({ runId: "huge", agent: "t", startedAt }));
		const filler = JSON.stringify({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "x".repeat(1024) }] },
		});
		const finalMsg = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "THE TAIL REPORT" }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, tokens: 2 },
			},
		});
		// ~11MB of filler so only the 8MB replay tail is read.
		const data = `${Array.from({ length: 10_000 }, () => filler).join("\n")}\n${finalMsg}\n${JSON.stringify({ type: "agent_settled" })}\n`;
		fs.writeFileSync(path.join(dir, "output.jsonl"), data);

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		controller.reconcileStaleRuns();

		const result = controller.readResult("huge");
		assert.ok(result, "recovered result is readable");
		assert.equal(result!.finalOutput, "THE TAIL REPORT");
		assert.ok(result!.messages.length < 10_000, `only the tail is replayed (got ${result!.messages.length})`);
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Rehydration of finalized runs with readable result.json keeps working.
// ---------------------------------------------------------------------------

test("reconcile rehydrates finalized runs with readable result.json", () => {
	const runsDir = tempRunsDir();
	try {
		const okDir = path.join(runsDir, "done");
		fs.mkdirSync(okDir, { recursive: true });
		const startedAt = Date.now() - 5_000;
		fs.writeFileSync(path.join(okDir, "started.json"), JSON.stringify({ runId: "done", agent: "t", startedAt }));
		fs.writeFileSync(path.join(okDir, "result.json"), JSON.stringify(makeResult({ finalOutput: "report text" })));

		const failDir = path.join(runsDir, "failed-run");
		fs.mkdirSync(failDir, { recursive: true });
		fs.writeFileSync(path.join(failDir, "started.json"), JSON.stringify({ runId: "failed-run", agent: "t", startedAt }));
		fs.writeFileSync(path.join(failDir, "result.json"), JSON.stringify(makeResult({ exitCode: 1, error: "boom" })));

		const controller = createAsyncController({ runsDir, retentionDays: 7, events: EVENTS });
		controller.reconcileStaleRuns();

		const done = controller.listRuns().find((r) => r.runId === "done");
		assert.equal(done!.status, "completed");
		assert.equal(controller.readResult("done")?.finalOutput, "report text");
		const failed = controller.listRuns().find((r) => r.runId === "failed-run");
		assert.equal(failed!.status, "failed");
		assert.equal(controller.readResult("failed-run")?.error, "boom");
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});