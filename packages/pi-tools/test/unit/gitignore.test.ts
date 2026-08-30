import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IgnoreMatcher, parseIgnoreFile, parseIgnoreLine } from "../../engine/gitignore.ts";

const matcher = (content: string): IgnoreMatcher => new IgnoreMatcher(parseIgnoreFile(content));

describe("engine/gitignore", () => {
	it("ignores comments and blank lines", () => {
		assert.equal(parseIgnoreLine(""), null);
		assert.equal(parseIgnoreLine("# comment"), null);
		assert.equal(parseIgnoreLine("   "), null);
	});

	it("matches basename patterns anywhere below the base", () => {
		const m = matcher("*.log\n");
		assert.equal(m.ignored("x.log", false), "ignored");
		assert.equal(m.ignored("a/b/c.log", false), "ignored");
		assert.equal(m.ignored("a/b/c.txt", false), "none");
	});

	it("applies negations (last match wins)", () => {
		const m = matcher("*.log\n!keep.log\n");
		assert.equal(m.ignored("x.log", false), "ignored");
		assert.equal(m.ignored("keep.log", false), "allowed");
		assert.equal(m.ignored("other.txt", false), "none");
	});

	it("treats trailing slash as directory-only", () => {
		const m = matcher("build/\n");
		assert.equal(m.ignored("build", true), "ignored");
		assert.equal(m.ignored("build", false), "none");
		assert.equal(m.ignored("a/build", true), "ignored");
	});

	it("anchors slash patterns to the ignore file dir", () => {
		const m = matcher("/top.txt\n");
		assert.equal(m.ignored("top.txt", false), "ignored");
		assert.equal(m.ignored("a/top.txt", false), "none");
		const m2 = matcher("a/b.txt\n");
		assert.equal(m2.ignored("a/b.txt", false), "ignored");
		assert.equal(m2.ignored("x/a/b.txt", false), "none");
	});

	it("supports glob meta in patterns", () => {
		const m = matcher("**/tmp/*\n");
		assert.equal(m.ignored("tmp/x", false), "ignored");
		assert.equal(m.ignored("a/tmp/y", false), "ignored");
		const m2 = matcher("doc/**\n");
		assert.equal(m2.ignored("doc/x/y.md", false), "ignored");
	});

	it("supports escaped hash and bang", () => {
		const m = matcher("\\#file\n\\!file\n");
		assert.equal(m.ignored("#file", false), "ignored");
		assert.equal(m.ignored("!file", false), "ignored");
	});

	it("strips trailing spaces but honors escaped ones", () => {
		const m = matcher("trail   \nkeep\\ \n");
		assert.equal(m.ignored("trail", false), "ignored");
		assert.equal(m.ignored("keep ", false), "ignored");
	});
});