/**
 * edit tool — self-implemented exact-text replacement replacing pi's built-in
 * `edit`.
 *
 * Semantics mirror pi's built-in: LF normalization, exact match first with a
 * fuzzy fallback (trailing whitespace / smart punctuation tolerant), strict
 * uniqueness per oldText, overlap rejection across edits, reverse-order
 * application, BOM + original line-ending preservation, and the same error
 * strings. Details carry a display diff and a unified patch.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";

import { detectLineEnding, normalizeForFuzzyMatch, normalizeToLF, restoreLineEndings, splitForDiff, splitLinesWithEndings } from "../lib/eol.ts";
import { formatDisplayDiff, formatUnifiedPatch } from "../lib/line-diff.ts";
import { resolveToolPath } from "../lib/path-utils.ts";
import { renderToolCall, renderToolResult } from "./render.ts";

const editSchema = Type.Object({
	path: Type.String({ description: "Path of the file to edit (relative or absolute)" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ description: "Exact text to find and replace (must match exactly, including whitespace and newlines)" }),
			newText: Type.String({ description: "Replacement text" }),
		}),
		{ description: "One or more disjoint edits to apply to the same file" },
	),
});

type EditParams = Static<typeof editSchema>;

export interface EditToolDetails {
	/** Display-oriented diff of the changes made. */
	diff: string;
	/** Standard unified patch of the changes made. */
	patch: string;
	/** First changed line number in the new file. */
	firstChangedLine?: number;
}

const editDescription =
	"Make precise file edits with exact text replacement, including multiple disjoint edits in one call. Each edits[].oldText must match exactly (including all whitespace and newlines) and appear exactly once in the file. When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls.";

export function registerEditTool(pi: ExtensionAPI): void {
	const definition: ToolDefinition<typeof editSchema, EditToolDetails | undefined> = {
		name: "edit",
		label: "edit",
		description: editDescription,
		promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeEdit(params, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return renderEditCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme);
		},
	};
	pi.registerTool(definition);
}

export async function executeEdit(
	params: EditParams,
	cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: EditToolDetails | undefined }> {
	const absolutePath = resolveToolPath(params.path, cwd);

	return withFileMutationQueue(absolutePath, async () => {
		let rawContent: string;
		try {
			rawContent = await readFile(absolutePath, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") throw new Error(`Path not found: ${absolutePath}`);
			if (code === "EISDIR") throw new Error(`Is a directory: ${absolutePath}`);
			throw err;
		}

		// Strip BOM before matching (the model will not include it in oldText).
		let bom = "";
		let content = rawContent;
		if (content.startsWith("\uFEFF")) {
			bom = "\uFEFF";
			content = content.slice(1);
		}
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, params.edits, params.path);
		const finalContent = bom + restoreLineEndings(newContent, originalEnding);
		await writeFile(absolutePath, finalContent, "utf8");

		const diffResult = formatDisplayDiff(splitForDiff(baseContent), splitForDiff(newContent));
		const patch = formatUnifiedPatch(params.path, splitForDiff(baseContent), splitForDiff(newContent));
		return {
			content: [{ type: "text", text: `Successfully replaced ${params.edits.length} block(s) in ${params.path}.` }],
			details: { diff: diffResult.text, patch, firstChangedLine: diffResult.firstChangedLine },
		};
	});
}

// ---------------------------------------------------------------------------
// Matching & application (mirrors pi's edit-diff semantics)
// ---------------------------------------------------------------------------

interface MatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
}

interface Replacement {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/** Exact match first; falls back to fuzzy-normalized matching. */
function fuzzyFindText(content: string, oldText: string): MatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
	}
	return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`);
	}
	return new Error(`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

function splitLinesWithEndings_Local(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: Replacement): { startLine: number; endLine: number } {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;
	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine]!.end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}
	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i]!;
		const matchIndex = replacement.matchIndex - offset;
		result = result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original (pi semantics for fuzzy
 * matches, where the two contents differ in normalization).
 */
function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: Replacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}
	const groups: Array<{ startLine: number; endLine: number; replacements: Replacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}
	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");
		const groupStartOffset = baseLines[group.startLine]!.start;
		const groupEndOffset = baseLines[group.endLine - 1]!.end;
		result += applyReplacements(baseContent.slice(groupStartOffset, groupEndOffset), group.replacements, groupStartOffset);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");
	return result;
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 * All edits are matched against the same original content; replacements are
 * then applied in reverse order so offsets stay stable.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Array<{ oldText: string; newText: string }>,
	path: string,
): { baseContent: string; newContent: string } {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i]!.oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}
	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: Replacement[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i]!;
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}
		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}
		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1]!;
		const current = matchedEdits[i]!;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
		}
	}

	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);
	if (normalizedContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}
	return { baseContent: normalizedContent, newContent };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEditCall(args: EditParams, theme: Theme, context: { lastComponent?: unknown }): Component {
	const detail = `${theme.fg("toolOutput", args.path)}${theme.fg("muted", ` (${args.edits.length} edit${args.edits.length === 1 ? "" : "s"})`)}`;
	return renderToolCall("edit", "", detail, theme);
}