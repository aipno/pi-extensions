import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, searchFiles, searchInText } from "../../engine/search.ts";
import { makeFixture, writeBuffer } from "./helpers.ts";

describe("engine/search (pure TS)", () => {
	it("applies smart-case by default", () => {
		assert.equal(buildMatcher("hello").flags.includes("i"), true);
		assert.equal(buildMatcher("Hello").flags.includes("i"), false);
		assert.equal(buildMatcher("hello", { ignoreCase: true }).flags.includes("i"), true);
		assert.equal(buildMatcher("hello", { noSmartCase: true }).flags.includes("i"), false);
	});

	it("escapes literal patterns", () => {
		const m = buildMatcher("a+b", { literal: true });
		assert.equal(m.test("a+b"), true);
		assert.equal(m.test("aaab"), false);
	});

	it("matches lines and reports 1-based numbers", () => {
		const { lines, matchCount } = searchInText("foo\nbar\nbaz foo\n", buildMatcher("foo"));
		assert.equal(matchCount, 2);
		assert.deepEqual(
			lines.map((l) => [l.lineNumber, l.isMatch]),
			[[1, true], [3, true]],
		);
	});

	it("includes context lines around matches", () => {
		const { lines } = searchInText("a\nb\nfoo\nc\nd\n", buildMatcher("foo"), 1);
		assert.deepEqual(
			lines.map((l) => [l.lineNumber, l.isMatch]),
			[[2, false], [3, true], [4, false]],
		);
	});

	it("searches a tree honoring .gitignore, .git skip and binary skip", async () => {
		const root = await makeFixture({
			".gitignore": "ignored.txt\nnode_modules/\n",
			"keep.txt": "needle here\n",
			"ignored.txt": "needle\n",
			"sub/also.txt": "needle\n",
			"sub/node_modules/x.txt": "needle\n",
			"bin.dat": "needle\x00needle\n",
		});
		const result = await searchFiles("needle", { root, pattern: {}, limit: 10 });
		const rels = result.files.map((f) => f.relPath).sort();
		assert.deepEqual(rels, ["keep.txt", "sub/also.txt"]);
	});

	it("respects glob filters", async () => {
		const root = await makeFixture({
			"a.ts": "needle\n",
			"a.js": "needle\n",
			"sub/b.ts": "needle\n",
		});
		const result = await searchFiles("needle", { root, pattern: {}, limit: 10, glob: "**/*.ts" });
		assert.deepEqual(result.files.map((f) => f.relPath).sort(), ["a.ts", "sub/b.ts"]);
	});

	it("stops at the global match limit", async () => {
		const root = await makeFixture({
			"a.txt": "needle\nneedle\nneedle\n",
			"b.txt": "needle\n",
		});
		const result = await searchFiles("needle", { root, pattern: {}, limit: 2 });
		assert.equal(result.totalMatches, 2);
		assert.equal(result.limitReached, true);
	});

	it("count mode returns per-file counts", async () => {
		const root = await makeFixture({
			"a.txt": "needle\nneedle\n",
			"b.txt": "needle\n",
			"c.txt": "nothing\n",
		});
		const result = await searchFiles("needle", { root, pattern: {}, limit: 10, mode: "count" });
		const counts = Object.fromEntries(result.files.map((f) => [f.relPath, f.matchCount]));
		assert.deepEqual(counts, { "a.txt": 2, "b.txt": 1 });
	});

	it("filesWithMatches mode returns paths", async () => {
		const root = await makeFixture({
			"a.txt": "needle\n",
			"b.txt": "other\n",
		});
		const result = await searchFiles("needle", { root, pattern: {}, limit: 10, mode: "filesWithMatches" });
		assert.deepEqual(result.files.map((f) => f.relPath), ["a.txt"]);
	});

	it("skips files over the byte cap", async () => {
		const root = await makeFixture({ "big.txt": "needle\n" });
		const result = await searchFiles("needle", { root, pattern: {}, limit: 10, maxFileBytes: 4 });
		assert.equal(result.files.length, 0);
	});

	it("handles CRLF files", async () => {
		const root = await makeFixture({ "win.txt": "needle\r\nother\r\n" });
		const result = await searchFiles("needle", { root, pattern: {}, limit: 10 });
		assert.equal(result.files[0]?.lines[0]?.text, "needle");
	});

	it("aborts via signal", async () => {
		const root = await makeFixture({ "a.txt": "needle\n", "b.txt": "needle\n", "c.txt": "needle\n" });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(() => searchFiles("needle", { root, pattern: {}, signal: controller.signal }), (err: unknown) => {
			return err instanceof DOMException && err.name === "AbortError";
		});
	});

	it("binary fixtures are skipped", async () => {
		const root = await makeFixture({});
		const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
		await writeBuffer(root, "bin.bin", buf);
		const result = await searchFiles("x", { root, pattern: {}, limit: 10 });
		assert.equal(result.files.length, 0);
	});
});