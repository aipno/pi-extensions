/**
 * Bringing side-thread context back to the main editor: scope selection,
 * segment building, summaries, and the final editable context block.
 */

import type { SideThreadTurn } from "./side-thread.ts";

export interface BtwBringToMainSegment {
	role: "user" | "assistant";
	text: string;
}

export interface BtwBringToMainSummary {
	lines: number;
	messages: number;
	tokens: number;
}

export type BtwQuickBringToMainScope =
	| { kind: "latest" }
	| { kind: "from"; answeredTurnIndex: number }
	| { kind: "entire" };

export function getAnsweredTurns(
	turns: readonly SideThreadTurn[],
): Array<Extract<SideThreadTurn, { kind: "answered" }>> {
	return turns.filter(
		(turn): turn is Extract<SideThreadTurn, { kind: "answered" }> => turn.kind === "answered",
	);
}

export function buildQuickBringToMainSegments(
	turns: readonly SideThreadTurn[],
	scope: BtwQuickBringToMainScope,
): BtwBringToMainSegment[] {
	const answered = getAnsweredTurns(turns);
	const selected =
		scope.kind === "latest"
			? answered.slice(-1)
			: scope.kind === "from"
				? answered.slice(Math.max(0, scope.answeredTurnIndex))
				: answered;
	return selected.flatMap((turn) => [
		{ role: "user" as const, text: turn.question },
		{ role: "assistant" as const, text: turn.answer },
	]);
}

export function estimateBringToMainTokens(
	segments: readonly BtwBringToMainSegment[],
): number {
	return Math.ceil(
		Buffer.byteLength(segments.map((segment) => segment.text).join("\n"), "utf8") / 4,
	);
}

export function summarizeBringToMain(
	segments: readonly BtwBringToMainSegment[],
): BtwBringToMainSummary {
	return {
		lines: segments.reduce((count, segment) => count + segment.text.split("\n").length, 0),
		messages: segments.length,
		tokens: estimateBringToMainTokens(segments),
	};
}

/**
 * The exact editable block loaded into the main editor. The <btw_context> tags
 * are part of the contract the side model would recognize, so user content is
 * escaped to keep the block well formed.
 */
export function formatBtwBringToMain(segments: readonly BtwBringToMainSegment[]): string {
	const body = segments
		.map(
			(segment) =>
				`${segment.role === "user" ? "User" : "Assistant"}:\n${escapeBringToMainText(segment.text)}`,
		)
		.join("\n\n");
	return [
		"The following context was brought back from a /btw side discussion.",
		"Treat it as discussion context, not as work already completed.",
		"",
		"<btw_context>",
		body,
		"</btw_context>",
	].join("\n");
}

function escapeBringToMainText(text: string): string {
	return [...text]
		.map((character) => {
			if (character === "\n") return character;
			if (character === "\t") return "    ";
			const code = character.charCodeAt(0);
			if (code <= 31 || (code >= 127 && code <= 159)) {
				return `\\x${code.toString(16).padStart(2, "0")}`;
			}
			return character;
		})
		.join("")
		.replace(/<btw_context(?=[ \t\r\n>])/g, "&lt;btw_context")
		.replace(/<\/btw_context[ \t\r\n]*>/g, (terminator) =>
			terminator.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
		);
}