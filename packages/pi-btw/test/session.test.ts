import assert from "node:assert/strict";
import { test } from "node:test";
import type { BtwThreadState } from "../session.ts";
import { createHarness } from "./harness.ts";
import { KEYS, fakeAssistantMessage, flushPromises } from "./helpers.ts";

const ctrlC = KEYS.ctrlC;

test("starts in the main menu without an initial question", () => {
	const harness = createHarness();
	const lines = harness.view.render(100);
	assert.ok(lines.join("\n").includes("Pi BTW"));
	assert.ok(lines.join("\n").includes("Start side thread"));
	assert.equal(harness.threadState, undefined);
});

test("menu Escape closes without creating a thread", () => {
	const harness = createHarness();
	harness.view.handleInput(KEYS.escape);
	assert.deepEqual(harness.closed, { kind: "closed" });
	assert.equal(harness.threadState, undefined);
});

test("menu Ctrl+C closes without creating a thread", () => {
	const harness = createHarness();
	harness.view.handleInput(ctrlC);
	assert.deepEqual(harness.closed, { kind: "closed" });
});

test("menu selection is remembered when returning from settings", () => {
	const harness = createHarness();
	harness.view.handleInput(KEYS.down); // -> Resume? no: second item depends on resume list
	harness.view.handleInput(KEYS.down); // -> Settings
	harness.view.handleInput(KEYS.enter);
	// settings screen
	let lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("Pi BTW Settings"));
	harness.view.handleInput(KEYS.escape);
	lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("Settings"), "returns to the menu");
});

test("Settings then Start begins a fresh thread in the composer", async () => {
	const harness = createHarness();
	harness.view.handleInput(KEYS.enter); // start
	assert.match(harness.view.render(100).join("\n"), /btw · side thread/);
	assert.ok(harness.threadState, "thread state created on start");
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("Ctrl+R bring to main") === false, "no bring hint on empty thread");
});

test("composer submit moves to answering and resolves back to composer with a turn", async () => {
	const harness = createHarness();
	harness.view.handleInput(KEYS.enter); // start
	const editor = harness.editors.at(-1);
	assert.ok(editor);
	editor.setText("what does this error mean?");
	editor.onSubmit?.("what does this error mean?");
	assert.equal(harness.completeTurnCalls.length, 1);
	assert.equal(harness.completeTurnCalls[0]?.question, "what does this error mean?");
	await flushPromises();
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("A: answer to: what does this error mean? (low)"));
	assert.equal(harness.threadState?.thread.turns.length, 1);
	assert.equal(harness.threadState?.title, "what does this error mean?");
	assert.equal(harness.threadState?.thread.turns[0]?.kind, "answered");
	assert.match(lines, /Ctrl\+R bring to main/);
});

test("empty composer submit shows a warning instead of answering", async () => {
	const harness = createHarness();
	harness.view.handleInput(KEYS.enter); // start
	const editor = harness.editors.at(-1);
	assert.ok(editor);
	editor.onSubmit?.("   ");
	assert.equal(harness.completeTurnCalls.length, 0);
	assert.ok(harness.view.render(100).join("\n").includes("Question cannot be empty"));
	editor.onSubmit?.("a real question");
	await flushPromises();
	assert.equal(harness.threadState?.thread.turns.length, 1);
});

test("Ctrl+C during answering aborts the request, notifies, and closes", async () => {
	const harness = createHarness({
		initialQuestion: "side question",
	});
	assert.equal(harness.completeTurnCalls.length, 1);
	const signal = harness.completeTurnCalls[0]?.signal;
	assert.ok(signal);
	harness.view.handleInput(ctrlC);
	assert.equal(signal.aborted, true);
	assert.deepEqual(harness.closed, { kind: "closed" });
	assert.deepEqual(harness.notifications, ["Cancelled"]);
});

test("a failed side request records an error turn and continues the queue", async () => {
	const harness = createHarness(); // menu first: the behavior must be set before the turn starts
	harness.completeTurnBehavior = async ({ signal }) => {
		if (signal.aborted) return { kind: "aborted" };
		return { kind: "error", message: "boom" };
	};
	harness.view.handleInput(KEYS.enter); // start
	const editor = harness.editors.at(-1);
	editor?.setText("first");
	editor?.onSubmit?.("first");
	await flushPromises();
	assert.equal(harness.threadState?.thread.turns.length, 1);
	assert.equal(harness.threadState?.thread.turns[0]?.kind, "error");
	// steering survives a failed answer: submit a follow-up
	harness.view.render(100); // materialize the answering/steering editor
	const steering = harness.editors.at(-1);
	steering?.setText("second");
	steering?.onSubmit?.("second");
	assert.equal(harness.completeTurnCalls.length, 2);
	await flushPromises();
	assert.equal(harness.threadState?.thread.turns.length, 2);
});

test("queued steering questions are answered in order after the active turn", async () => {
	const harness = createHarness({ initialQuestion: "first" });
	harness.view.render(100); // materialize the answering view and its steering editor
	const steering = harness.editors.at(-1);
	steering?.setText("second");
	steering?.onSubmit?.("second");
	steering?.setText("third");
	steering?.onSubmit?.("third");
	await flushPromises();
	assert.equal(harness.completeTurnCalls.length, 3);
	assert.deepEqual(harness.completeTurnCalls.map((c) => c.question), ["first", "second", "third"]);
	assert.equal(harness.threadState?.thread.turns.length, 3);
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("A: answer to: third"));
});

test("steering questions render in the answering view", async () => {
	const harness = createHarness({ initialQuestion: "first" });
	harness.view.render(100); // materialize the steering editor
	const steering = harness.editors.at(-1);
	steering?.setText("second");
	steering?.onSubmit?.("second");
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("Steering: second"));
	await flushPromises();
});

test("thinking cycle changes the active level and persists for fixed settings", async () => {
	const harness = createHarness({
		settings: { thinkingLevel: "low", rememberThinkingLevelChanges: true },
		initialQuestion: "q",
	});
	harness.keybindings.cycleData = ["cycle"];
	harness.view.handleInput("cycle");
	assert.equal(harness.completeTurnCalls[0]?.level, "low"); // active turn keeps its level
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("thinking medium"), lines.slice(0, 200));
	assert.deepEqual(harness.settingsSaves, [{ thinkingLevel: "medium" }]);
	assert.equal(harness.threadState?.thinkingLevel, "medium");
});

test("thinking cycle stays local when same-as-main thinking is active", async () => {
	const harness = createHarness({
		settings: {},
		initialQuestion: "q",
	});
	harness.keybindings.cycleData = ["cycle"];
	harness.view.handleInput("cycle");
	assert.equal(harness.settingsSaves.length, 0);
});

test("thinking cycle persistence failure warns without losing the local change", async () => {
	const harness = createHarness({
		settings: { thinkingLevel: "low" },
		initialQuestion: "q",
	});
	harness.saveSettingsError = new Error("disk full");
	harness.keybindings.cycleData = ["cycle"];
	harness.view.handleInput("cycle");
	await flushPromises();
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("could not be remembered"), lines.slice(0, 300));
});

test("composer Ctrl+C closes the session without notification", () => {
	const harness = createHarness();
	harness.view.handleInput(KEYS.enter); // start
	harness.view.handleInput(ctrlC);
	assert.deepEqual(harness.closed, { kind: "closed" });
	assert.deepEqual(harness.notifications, []);
});

test("throwaway thread without turns or title is not resumable", async () => {
	const harness = createHarness({ resumeThreads: [] });
	harness.view.handleInput(KEYS.enter); // start
	const lines = harness.view.render(100).join("\n");
	assert.ok(!lines.includes("Resume side thread"), "resume item hidden when empty");
});

test("resume list appears when threads exist and resumes a stored thread", async () => {
	const stored: BtwThreadState = {
		id: "btw-1",
		title: "stored thread",
		thread: {
			conversationContext: "ctx",
			turns: [
				{
					kind: "answered",
					question: "old question",
					answer: "old answer",
					response: fakeAssistantMessage("old answer"),
				},
			],
		},
		thinkingLevel: "high",
		createdAt: 1,
		updatedAt: 2,
	};
	const harness = createHarness({
		resumeThreads: [{ id: "btw-1", title: "stored thread", questionCount: 1 }],
		resumeThread: stored,
	});
	const menu = harness.view.render(100).join("\n");
	assert.ok(menu.includes("Resume side thread"));
	harness.view.handleInput(KEYS.down); // resume
	harness.view.handleInput(KEYS.enter); // -> resume list
	harness.view.handleInput(KEYS.enter); // -> pick the stored thread
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("Q: old question"));
	assert.ok(lines.includes("A: old answer"));
	assert.equal(
		harness.view.finalThreadState,
		stored,
		"resumed thread state is used",
	);
	assert.ok(lines.includes("thinking high"), "resumed level shown");
});

test("resuming a vanished thread warns inside the resume menu", () => {
	const harness = createHarness({
		resumeThreads: [{ id: "btw-gone", title: "gone", questionCount: 1 }],
	});
	harness.view.handleInput(KEYS.down); // resume
	harness.view.handleInput(KEYS.enter); // -> resume list
	harness.view.handleInput(KEYS.enter); // -> pick the vanished thread
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("no longer available"));
});

test("pageUp/pageDown scroll the transcript without losing manual position", async () => {
	const harness = createHarness({ rows: 12, initialQuestion: "q1" });
	harness.view.render(100); // materialize the answering/steering editor
	// queue q2/q3 while q1 answers; after the flush the queue drains in order
	const steering = harness.editors.at(-1);
	steering?.setText("q2");
	steering?.onSubmit?.("q2");
	steering?.setText("q3");
	steering?.onSubmit?.("q3");
	await flushPromises();
	assert.equal(harness.threadState?.thread.turns.length, 3);
	// submit q4 from the composer editor (the most recently created editor)
	const composer = harness.editors.at(-1);
	composer?.setText("q4");
	composer?.onSubmit?.("q4");
	await flushPromises();
	assert.equal(harness.threadState?.thread.turns.length, 4);
	// back in composer; scroll up and confirm the offset moved
	harness.view.handleInput(KEYS.pageUp);
	const afterUp = harness.view.render(100).join("\n");
	assert.ok(afterUp.includes("Q: q1"), "older content visible after scrolling up");
	harness.view.handleInput(KEYS.pageDown);
	const afterDown = harness.view.render(100).join("\n");
	assert.ok(afterDown.includes("Q: q4"), "follows back to the end");
});


// ---------------------------------------------------------------------------
// Bring to main
// ---------------------------------------------------------------------------

test("replace confirm then replace actually loads the block and closes", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	harness.editorText = "keep me";
	await flushPromises();
	harness.view.handleInput(KEYS.ctrlR);
	harness.view.handleInput(KEYS.enter); // latest
	harness.view.handleInput(KEYS.enter); // bring -> delivery menu
	harness.view.handleInput(KEYS.down); // replace
	harness.view.handleInput(KEYS.enter); // -> confirm menu
	harness.view.handleInput(KEYS.down); // ⚠ Replace current draft
	harness.view.handleInput(KEYS.enter);
	assert.ok(harness.editorText.includes("<btw_context>"));
	assert.ok(!harness.editorText.includes("keep me"));
	assert.equal(harness.closed?.kind, "broughtToMain");
});
test("Ctrl+R without answered turns does nothing", () => {
	const harness = createHarness();
	harness.view.handleInput(KEYS.enter); // start
	const before = harness.view.render(100).join("\n");
	harness.view.handleInput(KEYS.ctrlR);
	const after = harness.view.render(100).join("\n");
	assert.equal(before, after);
});

test("bring-to-main loads the latest Q&A into an empty main editor and closes", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	await flushPromises();
	harness.view.handleInput(KEYS.ctrlR);
	let lines = harness.view.render(120).join("\n");
	assert.ok(lines.includes("Bring what back to the main thread?"));
	harness.view.handleInput(KEYS.enter); // latest
	lines = harness.view.render(120).join("\n");
	assert.ok(lines.includes("Preview"));
	assert.ok(lines.includes("<btw_context>"));
	harness.view.handleInput(KEYS.enter); // bring
	assert.ok(harness.editorText.includes("<btw_context>"));
	assert.ok(harness.editorText.includes("q1"));
	assert.ok(harness.editorText.includes("answer to: q1"));
	assert.equal(harness.closed?.kind, "broughtToMain");
	assert.ok(harness.notifications.some((n) => n.includes("Brought")));
});

test("preview Escape returns to the scope menu, and Cancel returns to composer", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	await flushPromises();
	harness.view.handleInput(KEYS.ctrlR);
	harness.view.handleInput(KEYS.enter); // latest
	harness.view.handleInput(KEYS.escape);
	assert.ok(harness.view.render(120).join("\n").includes("Bring what back"));
	harness.view.handleInput(KEYS.down); // entire
	harness.view.handleInput(KEYS.down); // cancel
	harness.view.handleInput(KEYS.enter);
	assert.match(harness.view.render(120).join("\n"), /btw · side thread/);
	assert.equal(harness.closed, undefined, "thread still open");
});

test("entire-thread scope includes every answered turn but not error turns", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	harness.view.render(100);
	await flushPromises();
	const steering = harness.editors.at(-1);
	steering?.setText("q2");
	steering?.onSubmit?.("q2");
	await flushPromises();
	assert.equal(harness.threadState?.thread.turns.length, 2);
	// inject an error turn directly (simulates a failed answer that kept the thread alive)
	harness.threadState?.thread.turns.push({ kind: "error", question: "q-fail", answer: "boom" });
	harness.view.handleInput(KEYS.ctrlR);
	const scopeLines = harness.view.render(160).join("\n");
	assert.ok(scopeLines.includes("Entire side thread"), "scope list shows the size");
	assert.ok(scopeLines.includes("2 Q&A"), "scope counts only answered turns");
	harness.view.handleInput(KEYS.down); // from a question onward…
	harness.view.handleInput(KEYS.down); // entire side thread
	harness.view.handleInput(KEYS.enter); // -> preview
	const lines = harness.view.render(160).join("\n");
	assert.ok(lines.includes("<btw_context>"), "preview shows the context block");
	harness.view.handleInput(KEYS.enter); // bring
	assert.ok(harness.editorText.includes("q1"));
	assert.ok(harness.editorText.includes("q2"));
	assert.ok(!harness.editorText.includes("q-fail"), "error turns stay out of the context block");
});

test("from-a-question scope starts the block at the selected question", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	harness.view.render(100);
	const steering = harness.editors.at(-1);
	steering?.setText("q2");
	steering?.onSubmit?.("q2");
	await flushPromises();
	// q2 finished; submit q3 from the composer editor (last created editor)
	const composer = harness.editors.at(-1);
	composer?.setText("q3");
	composer?.onSubmit?.("q3");
	await flushPromises();
	assert.equal(harness.threadState?.thread.turns.length, 3);
	harness.view.handleInput(KEYS.ctrlR);
	harness.view.handleInput(KEYS.down); // from
	harness.view.handleInput(KEYS.enter);
	const lines = harness.view.render(160).join("\n");
	assert.ok(lines.includes("Start from which question?"));
	assert.ok(lines.includes("2. q2"));
	harness.view.handleInput(KEYS.down); // q2
	harness.view.handleInput(KEYS.enter);
	harness.view.handleInput(KEYS.enter); // bring
	assert.ok(!harness.editorText.includes("q1"), "earlier turns excluded");
	assert.ok(harness.editorText.includes("q2"));
	assert.ok(harness.editorText.includes("q3"));
});

test("existing main draft asks before loading; append keeps both", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	harness.editorText = "existing draft";
	await flushPromises();
	harness.view.handleInput(KEYS.ctrlR);
	harness.view.handleInput(KEYS.enter); // latest
	harness.view.handleInput(KEYS.enter); // bring
	let lines = harness.view.render(160).join("\n");
	assert.ok(lines.includes("The main editor already has a draft"));
	harness.view.handleInput(KEYS.enter); // append
	assert.ok(harness.editorText.startsWith("existing draft\n\n"));
	assert.ok(harness.editorText.includes("<btw_context>"));
	assert.equal(harness.closed?.kind, "broughtToMain");
	lines = harness.view.render(160).join("\n");
	assert.ok(lines.length > 0, "render after close is safe");
});

test("replace requires a second confirmation and warns when the editor changed", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	harness.editorText = "keep me";
	await flushPromises();
	harness.view.handleInput(KEYS.ctrlR);
	harness.view.handleInput(KEYS.enter); // latest
	harness.view.handleInput(KEYS.enter); // bring -> delivery menu
	harness.view.handleInput(KEYS.down); // replace
	harness.view.handleInput(KEYS.enter); // -> confirm menu
	let lines = harness.view.render(160).join("\n");
	assert.ok(lines.includes("Replace the current 7-character editor draft?"));
	harness.view.handleInput(KEYS.enter); // first item = Back
	lines = harness.view.render(160).join("\n");
	assert.ok(lines.includes("The main editor already has a draft"), "back to the delivery menu");
	assert.equal(harness.editorText, "keep me", "nothing was replaced yet");
	assert.equal(typeof harness.closed, "undefined", "session still open after Back");
	// selection is remembered at replace; confirm again and actually replace
	void lines;
	harness.view.handleInput(KEYS.enter); // -> confirm menu again
	harness.view.handleInput(KEYS.down); // ⚠ Replace current draft
	harness.view.handleInput(KEYS.enter);
	assert.ok(harness.editorText.includes("<btw_context>"), "replace confirmed loads the block");
	assert.equal(harness.closed?.kind, "broughtToMain");
});

test("a concurrent editor change during replace confirmation is not overwritten", async () => {
	const harness = createHarness({ initialQuestion: "q1" });
	harness.editorText = "keep me";
	await flushPromises();
	harness.view.handleInput(KEYS.ctrlR);
	harness.view.handleInput(KEYS.enter); // latest
	harness.view.handleInput(KEYS.enter); // bring -> delivery
	harness.view.handleInput(KEYS.down); // replace
	harness.view.handleInput(KEYS.enter); // -> confirm
	harness.editorText = "someone else typed"; // concurrent change
	harness.view.handleInput(KEYS.down); // ⚠ replace
	harness.view.handleInput(KEYS.enter);
	const lines = harness.view.render(160).join("\n");
	assert.ok(lines.includes("The main editor changed during confirmation"));
	assert.equal(harness.editorText, "someone else typed");
	assert.equal(harness.closed, undefined);
});

test("settings screen cycles thinking level and remember flags via saveSettings", async () => {
	const harness = createHarness({
		settings: { thinkingLevel: "low", rememberThinkingLevelChanges: true },
	});
	harness.view.handleInput(KEYS.down);
	harness.view.handleInput(KEYS.down); // Settings
	harness.view.handleInput(KEYS.enter);
	let lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("Pi BTW Settings"));
	assert.ok(lines.includes("Thinking level"));
	assert.ok(lines.includes("low"), "fixed level value displayed");
	harness.view.handleInput(KEYS.right); // cycle thinking level
	await flushPromises();
	assert.deepEqual(harness.settingsSaves, [{ thinkingLevel: "medium" }]);
	lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("medium"));
	harness.view.handleInput(KEYS.down); // remember row
	harness.view.handleInput(KEYS.left); // toggle On -> Off
	await flushPromises();
	assert.deepEqual(harness.settingsSaves.at(-1), { rememberThinkingLevelChanges: false });
	harness.view.handleInput(KEYS.escape);
	lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("Thinking: medium · Remember changes: Off"));
});

test("failing settings save keeps the previous value and shows the error", async () => {
	const harness = createHarness({ settings: { thinkingLevel: "low" } });
	harness.saveSettingsError = new Error("permission denied");
	harness.view.handleInput(KEYS.down);
	harness.view.handleInput(KEYS.down);
	harness.view.handleInput(KEYS.enter);
	harness.view.handleInput(KEYS.right);
	await flushPromises();
	const lines = harness.view.render(100).join("\n");
	assert.ok(lines.includes("were not saved"));
	assert.ok(lines.includes("permission denied"));
});

test("dispose aborts the active turn without double-closing", async () => {
	const harness = createHarness({ initialQuestion: "q" });
	const signal = harness.completeTurnCalls[0]?.signal;
	harness.view.dispose();
	assert.equal(signal?.aborted, true);
	harness.view.dispose(); // second dispose is a no-op
	await flushPromises();
	assert.equal(harness.completeTurnCalls.length, 1);
});

test("window resize renders full terminal rows with stable header/footer", async () => {
	const harness = createHarness({ rows: 30 });
	harness.view.handleInput(KEYS.enter); // start
	const lines = harness.view.render(80);
	assert.equal(lines.length, 30);
	assert.ok(lines[0]?.includes("─ btw ·"), "header first: " + lines[0]);
	// The composer layout is header, transcript (empty), footer, editor box.
	const headerIndex = lines.findIndex((line) => line.includes("─ btw ·"));
	const footerIndex = lines.findIndex((line) => line.includes("Ctrl+C exit"));
	assert.ok(headerIndex >= 0 && footerIndex > headerIndex, "footer after header");
});