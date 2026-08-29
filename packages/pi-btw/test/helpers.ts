/**
 * Minimal pi-runtime test doubles for pi-btw, standing in for live TUI/theme/
 * keybindings/editor objects. Everything here is structural — cast to the real
 * pi types at the call site.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { BtwKeybindings, BtwSessionTui, BtwTextEditor } from "../session.ts";

/**
 * Theme that returns text unchanged so assertions see plain strings.
 * Duck-typed against pi's Theme class (cast at the call site); extending the
 * real class would require a full color table we do not need here.
 */
export class PlainTheme {
	name = "plain";
	fg(_color: string, text: string): string {
		return text;
	}
	bg(_color: string, text: string): string {
		return text;
	}
	bold(text: string): string {
		return text;
	}
	italic(text: string): string {
		return text;
	}
	underline(text: string): string {
		return text;
	}
	inverse(text: string): string {
		return text;
	}
	strikethrough(text: string): string {
		return text;
	}
}


export class FakeTui implements BtwSessionTui {
	terminal = { rows: 24 };
	renders = 0;

	requestRender(): void {
		this.renders += 1;
	}
}

export class FakeKeybindings implements BtwKeybindings {
	/** Data strings that should match app.thinking.cycle (empty = no match). */
	cycleData: string[] = [];

	matches(data: string, keybinding: string): boolean {
		return keybinding === "app.thinking.cycle" && this.cycleData.includes(data);
	}

	getKeys(keybinding: string): string[] {
		return keybinding === "app.thinking.cycle" ? ["shift+tab"] : [];
	}
}

export class FakeEditor implements BtwTextEditor {
	focused = false;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => void;
	disposed = false;
	inputLog: string[] = [];
	private textValue = "";

	constructor(initial = "") {
		this.textValue = initial;
	}

	get text(): string {
		return this.textValue;
	}

	getText(): string {
		return this.textValue;
	}

	setText(text: string): void {
		this.textValue = text;
		this.onChange?.(text);
	}

	render(width: number): string[] {
		const lines = this.textValue === "" ? [""] : this.textValue.split("\n");
		return lines.map((line) => line.slice(0, Math.max(1, width)));
	}

	handleInput(data: string): void {
		this.inputLog.push(data);
		if (data === "\r") this.onSubmit?.(this.textValue);
	}

	dispose(): void {
		this.disposed = true;
	}
}

/** Plain line renderer for transcripts; keeps assertions free of markdown noise. */
export function plainTranscript(
	turns: readonly { kind: string; question: string; answer?: string }[],
	width: number,
	pendingQuestion?: string,
): string[] {
	const lines: string[] = [];
	for (const turn of turns) {
		lines.push(`Q: ${turn.question}`);
		if (turn.kind === "error") lines.push(`E: ${turn.answer ?? ""}`);
		else lines.push(`A: ${turn.answer ?? ""}`);
	}
	if (pendingQuestion) lines.push(`Q: ${pendingQuestion}`);
	return lines.map((line) => line.slice(0, Math.max(1, width)));
}

/** Minimal AssistantMessage with a single text block, for tests. */
export function fakeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	} as unknown as AssistantMessage;
}

/** Standard raw terminal sequences for keyboard tests. */
export const KEYS = {
	enter: "\r",
	escape: "\u001b",
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	space: " ",
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
	ctrlC: "\u0003",
	ctrlR: "\u0012",
	ctrlShiftF: "\u0006",
};

export function flushPromises(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export function renderText(component: Component, width = 100): string {
	return component.render(350)[0] ?? "";
}