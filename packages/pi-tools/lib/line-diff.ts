/**
 * Self-contained line diff for the edit tool.
 *
 * Implements the classic Myers O(ND) shortest-edit-script algorithm over
 * LF-split line arrays, then renders:
 * - a display-oriented diff with line numbers (pi `edit` details.diff shape)
 * - a standard unified patch (details.patch shape)
 *
 * No external diff dependency.
 */

export type DiffOp =
	| { type: "equal"; oldIndex: number; newIndex: number }
	| { type: "delete"; oldIndex: number; newIndex: number }
	| { type: "insert"; oldIndex: number; newIndex: number };

/** Guard: pathological inputs fall back to a full-replace diff. */
const MAX_TOTAL_LINES = 20_000;

/**
 * Compute the Myers edit script between two line arrays.
 * Returns ops in forward order; equal ops carry the matched indices.
 */
export function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
	const n = oldLines.length;
	const m = newLines.length;
	if (n + m > MAX_TOTAL_LINES) {
		// Full replace fallback: all old lines removed, all new lines added.
		const ops: DiffOp[] = [];
		for (let i = 0; i < n; i++) ops.push({ type: "delete", oldIndex: i, newIndex: -1 });
		for (let j = 0; j < m; j++) ops.push({ type: "insert", oldIndex: -1, newIndex: j });
		return ops;
	}

	const max = n + m;
	const v = new Int32Array(2 * max + 1);
	const offset = max;
	const trace: Int32Array[] = [];
	let endD = -1;

	outer: for (let d = 0; d <= max; d++) {
		trace.push(new Int32Array(v));
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
				x = v[offset + k + 1]; // down (insert)
			} else {
				x = v[offset + k - 1] + 1; // right (delete)
			}
			let y = x - k;
			while (x < n && y < m && oldLines[x] === newLines[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				endD = d;
				break outer;
			}
		}
	}

	// Backtrack to build the edit script in reverse.
	const ops: DiffOp[] = [];
	let x = n;
	let y = m;
	for (let d = endD; d > 0; d--) {
		const prevV = trace[d];
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && prevV[offset + k - 1] < prevV[offset + k + 1])) {
			prevK = k + 1; // was a down move (insert)
		} else {
			prevK = k - 1; // was a right move (delete)
		}
		const prevX = prevV[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ type: "equal", oldIndex: x - 1, newIndex: y - 1 });
			x--;
			y--;
		}
		if (prevK === k + 1) {
			ops.push({ type: "insert", oldIndex: -1, newIndex: y - 1 });
			y--;
		} else {
			ops.push({ type: "delete", oldIndex: x - 1, newIndex: -1 });
			x--;
		}
	}
	while (x > 0 && y > 0) {
		ops.push({ type: "equal", oldIndex: x - 1, newIndex: y - 1 });
		x--;
		y--;
	}
	ops.reverse();
	return ops;
}

/** Map from old-line index to its matching new-line index (-1 when removed). */
export function oldToNewIndexes(ops: DiffOp[], oldCount: number): Int32Array {
	const map = new Int32Array(oldCount).fill(-1);
	for (const op of ops) {
		if (op.type === "equal" && op.oldIndex >= 0) map[op.oldIndex] = op.newIndex;
	}
	return map;
}

/** Map from new-line index to its matching old-line index (-1 when added). */
export function newToOldIndexes(ops: DiffOp[], newCount: number): Int32Array {
	const map = new Int32Array(newCount).fill(-1);
	for (const op of ops) {
		if (op.type === "equal" && op.newIndex >= 0) map[op.newIndex] = op.oldIndex;
	}
	return map;
}

export interface DisplayDiffResult {
	/** The rendered diff text. */
	text: string;
	/** First changed line number in the new file (1-based), if any change. */
	firstChangedLine?: number;
}

/**
 * Render the pi-style display diff: `+{newLine} {line}` for additions,
 * `-{oldLine} {line}` for deletions, ` {line} {line}` for context with
 * `...` skip markers. Line numbers are padded to the widest line count.
 */
export function formatDisplayDiff(
	oldLines: string[],
	newLines: string[],
	contextLines = 4,
): DisplayDiffResult {
	const ops = diffLines(oldLines, newLines);
	const width = String(Math.max(oldLines.length, newLines.length)).length;
	const out: string[] = [];
	let oldNum = 1;
	let newNum = 1;
	let firstChangedLine: number | undefined;
	let lastWasChange = false;

	const pushContext = (count: number) => {
		for (let i = 0; i < count; i++) {
			const idx = oldNum - 1;
			out.push(` ${String(oldNum).padStart(width, " ")} ${oldLines[idx] ?? ""}`);
			oldNum++;
			newNum++;
		}
	};

	const pushSkip = (count: number) => {
		if (count <= 0) return;
		out.push(` ${"".padStart(width, " ")} ...`);
		oldNum += count;
		newNum += count;
	};

	let i = 0;
	while (i < ops.length) {
		const op = ops[i];
		if (op.type === "equal") {
			// Gather the context run length.
			let run = 0;
			while (i + run < ops.length && ops[i + run].type === "equal") run++;
			const nextIsChange = i + run < ops.length;
			const prevIsChange = lastWasChange;
			if (prevIsChange && nextIsChange) {
				if (run <= contextLines * 2) {
					pushContext(run);
				} else {
					pushContext(contextLines);
					pushSkip(run - contextLines * 2);
					pushContext(contextLines);
				}
			} else if (prevIsChange) {
				const shown = Math.min(run, contextLines);
				pushContext(shown);
				if (run - shown > 0) pushSkip(run - shown);
			} else if (nextIsChange) {
				const shown = Math.min(run, contextLines);
				pushSkip(run - shown);
				pushContext(shown);
			} else {
				pushSkip(run);
			}
			i += run;
			continue;
		}
		// Change run.
		const isAdd = op.type === "insert";
		if (firstChangedLine === undefined) firstChangedLine = newNum;
		if (isAdd) {
			out.push(`+${String(newNum).padStart(width, " ")} ${newLines[op.newIndex] ?? ""}`);
			newNum++;
		} else {
			out.push(`-${String(oldNum).padStart(width, " ")} ${oldLines[op.oldIndex] ?? ""}`);
			oldNum++;
		}
		lastWasChange = true;
		i++;
	}
	return { text: out.join("\n"), firstChangedLine };
}

/**
 * Render a standard unified patch (diff -u style) with `--- file` / `+++ file`
 * headers and `@@ -a,b +c,d @@` hunks.
 */
export function formatUnifiedPatch(
	filePath: string,
	oldLines: string[],
	newLines: string[],
	contextLines = 4,
): string {
	if (oldLines.length === 0 && newLines.length === 0) return "";

	const ops = diffLines(oldLines, newLines);
	const oldToNew = oldToNewIndexes(ops, oldLines.length);
	const newToOld = newToOldIndexes(ops, newLines.length);

	// Insertion point (old index) of each added new line: the number of
	// matched old lines that precede it.
	const insertionOfAdded = new Map<number, number>(); // new index -> old insertion point
	for (let j = 0; j < newLines.length; j++) {
		if (newToOld[j] !== -1) continue;
		let insert = 0;
		for (let i = 0; i < oldLines.length; i++) {
			if (oldToNew[i] !== -1 && oldToNew[i] < j) insert = i + 1;
		}
		insertionOfAdded.set(j, insert);
	}

	if (oldLines.length === 0 && insertionOfAdded.size === 0) return "";

	// Old positions that are "changed": removed lines plus anchors at the
	// insertion point of every added line (region boundaries).
	const changedOld = new Set<number>();
	for (let i = 0; i < oldLines.length; i++) {
		if (oldToNew[i] === -1) changedOld.add(i);
	}
	if (oldLines.length === 0) {
		changedOld.add(0); // synthetic anchor: everything is added
	} else {
		for (const ins of insertionOfAdded.values()) {
			changedOld.add(Math.min(ins, oldLines.length - 1));
		}
	}
	if (changedOld.size === 0) return "";

	// Consecutive runs of changed old positions.
	const sorted = [...changedOld].sort((a, b) => a - b);
	const regions: Array<[number, number]> = [];
	let rs = sorted[0];
	let re = sorted[0];
	for (let k = 1; k < sorted.length; k++) {
		if (sorted[k] === re + 1) {
			re = sorted[k];
			continue;
		}
		regions.push([rs, re]);
		rs = sorted[k];
		re = sorted[k];
	}
	regions.push([rs, re]);

	// Expand each region with context and merge overlapping/adjacent hunks.
	const hunks: Array<{ oldStart: number; oldEnd: number }> = [];
	for (const [s, e] of regions) {
		const hs = Math.max(0, s - contextLines);
		const he = oldLines.length === 0 ? 0 : Math.min(oldLines.length - 1, e + contextLines);
		const prev = hunks[hunks.length - 1];
		if (prev && hs - prev.oldEnd - 1 <= 2 * contextLines) {
			prev.oldEnd = he;
		} else {
			hunks.push({ oldStart: hs, oldEnd: he });
		}
	}

	// Associate added new lines with the hunk covering their insertion point
	// (insertion at oldEnd applies to the hunk ending there).
	const hunkOfInsertion = (ins: number): number => {
		for (let h = 0; h < hunks.length; h++) {
			const { oldStart, oldEnd } = hunks[h];
			if (ins >= oldStart && ins <= oldEnd + 1) return h;
		}
		return hunks.length - 1;
	};

	const out: string[] = [`--- ${filePath}`, `+++ ${filePath}`];

	// Raw new-file ranges per hunk.
	const newRanges: Array<{ newStart: number; newEnd: number }> = [];
	for (let h = 0; h < hunks.length; h++) {
		const { oldStart, oldEnd } = hunks[h];
		let newStart = Infinity;
		let newEnd = -1;
		for (let i = oldStart; i <= oldEnd; i++) {
			const ni = oldToNew[i];
			if (ni === -1) continue;
			if (ni < newStart) newStart = ni;
			if (ni > newEnd) newEnd = ni;
		}
		if (newEnd === -1) {
			// Pure insertion hunk: anchor at the first added line's position.
			let cursor = 0;
			for (let i = 0; i < oldStart; i++) {
				const ni = oldToNew[i];
				if (ni !== -1) cursor = ni + 1;
			}
			newStart = newEnd = cursor;
		}
		// Added new lines whose insertion point belongs to this hunk.
		for (const [j, ins] of insertionOfAdded) {
			if (hunkOfInsertion(ins) === h) {
				if (j < newStart) newStart = j;
				if (j > newEnd) newEnd = j;
			}
		}
		newRanges.push({ newStart, newEnd });
	}
	// Tile fix-up: hunks must partition the new file with no gaps. Gaps of
	// added lines between two hunks are claimed by the left hunk (its
	// newEnd extends to the right hunk's start minus one).
	for (let h = 1; h < hunks.length; h++) {
		if (newRanges[h - 1].newEnd + 1 < newRanges[h].newStart) {
			newRanges[h - 1].newEnd = newRanges[h].newStart - 1;
		}
	}

	for (let h = 0; h < hunks.length; h++) {
		const { oldStart, oldEnd } = hunks[h];
		const { newStart, newEnd } = newRanges[h];
		const oldCount = oldLines.length === 0 ? 0 : oldEnd - oldStart + 1;
		const newCount = newEnd - newStart + 1;

		const lines: string[] = [];
		if (oldLines.length === 0) {
			for (let j = newStart; j <= newEnd; j++) {
				if (newToOld[j] === -1) lines.push(`+${newLines[j]}`);
			}
		} else {
			let curNew = newStart;
			for (let i = oldStart; i <= oldEnd; i++) {
				const ni = oldToNew[i];
				if (ni === -1) {
					lines.push(`-${oldLines[i]}`);
				} else {
					// Emit added new lines before this matched line.
					while (curNew < ni) {
						if (newToOld[curNew] === -1) lines.push(`+${newLines[curNew]}`);
						curNew++;
					}
					lines.push(` ${oldLines[i]}`);
					curNew = ni + 1;
				}
			}
			while (curNew <= newEnd) {
				if (newToOld[curNew] === -1) lines.push(`+${newLines[curNew]}`);
				curNew++;
			}
		}
		out.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`);
		out.push(...lines);
	}
	return out.join("\n");
}