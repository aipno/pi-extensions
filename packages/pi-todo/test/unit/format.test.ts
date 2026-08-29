import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeRecordingTheme } from "../helpers.ts";
import type { Task } from "../../tool/types.ts";
import { formatOverlayTaskLine } from "../../view/format.ts";

const recordingTheme = makeRecordingTheme() as unknown as Theme;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: 1,
		subject: "quiet task",
		status: "pending",
		...overrides,
	};
}

test("formatOverlayTaskLine — keeps pending subjects primary while rendering IDs quietly", () => {
	assert.equal(formatOverlayTaskLine(task(), recordingTheme, true), "<dim>○</dim> <dim>#1</dim> <text>quiet task</text>");
});

test("formatOverlayTaskLine — emphasizes the current task while muting its supporting metadata", () => {
	assert.equal(
		formatOverlayTaskLine(
			task({ status: "in_progress", activeForm: "Working", blockedBy: [2, 3], owner: "worker" }),
			recordingTheme,
			true,
		),
		"<warning>◐</warning> <dim>#1</dim> <accent>quiet task</accent> <muted>@worker</muted> <muted>(Working)</muted> <muted>⛓ #2,#3</muted>",
	);
});

test("formatOverlayTaskLine — mutes and strikes completed subjects", () => {
	assert.equal(
		formatOverlayTaskLine(task({ status: "completed" }), recordingTheme, false),
		"<success>✓</success> <strike><muted>quiet task</muted></strike>",
	);
});

test("formatOverlayTaskLine — hides the id when showId is false", () => {
	assert.equal(formatOverlayTaskLine(task(), recordingTheme, false), "<dim>○</dim> <text>quiet task</text>");
});

test("formatOverlayTaskLine — strips escape sequences from subject and activeForm before theming", () => {
	assert.equal(
		formatOverlayTaskLine(
			task({ status: "in_progress", subject: "quiet\u001b[2Jtask", activeForm: "Work\u009bcing" }),
			recordingTheme,
			false,
		),
		"<warning>◐</warning> <accent>quiettask</accent> <muted>(Working)</muted>",
	);
});