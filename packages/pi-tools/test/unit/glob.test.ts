import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, globMatch, type GlobOptions } from "../../engine/glob.ts";

const match = (pattern: string, path: string, opts?: GlobOptions): boolean => globMatch(pattern, path, opts);

describe("engine/glob", () => {
	it("matches basename patterns at any depth", () => {
		assert.equal(match("*.ts", "a.ts"), true);
		assert.equal(match("*.ts", "src/deep/a.ts"), true);
		assert.equal(match("*.ts", "src/a.tsx"), false);
	});

	it("anchors path patterns to the root", () => {
		assert.equal(match("src/*.ts", "src/a.ts"), true);
		assert.equal(match("src/*.ts", "lib/a.ts"), false);
		assert.equal(match("src/*.ts", "src/deep/a.ts"), false);
	});

	it("handles ** star segments", () => {
		assert.equal(match("**/*.ts", "a.ts"), true);
		assert.equal(match("**/*.ts", "x/y/a.ts"), true);
		assert.equal(match("a/**/b", "a/b"), true);
		assert.equal(match("a/**/b", "a/x/y/b"), true);
		assert.equal(match("a/**/b", "axb"), false);
		assert.equal(match("a/**", "a/x"), true);
		assert.equal(match("a/**", "a/x/y"), true);
		assert.equal(match("a/**", "a"), false);
		assert.equal(match("**", "anything/at/all"), true);
	});

	it("supports ? and character classes", () => {
		assert.equal(match("a?.ts", "ab.ts"), true);
		assert.equal(match("a?.ts", "a/ts"), false);
		assert.equal(match("[ab]c.ts", "ac.ts"), true);
		assert.equal(match("[ab]c.ts", "bc.ts"), true);
		assert.equal(match("[ab]c.ts", "cc.ts"), false);
		assert.equal(match("[!a]c.ts", "bc.ts"), true);
		assert.equal(match("[!a]c.ts", "ac.ts"), false);
	});

	it("supports brace alternation", () => {
		assert.equal(match("{a,b}.js", "x/a.js"), true);
		assert.equal(match("{a,b}.js", "x/c.js"), false);
		assert.equal(match("**.{ts,tsx}", "src/a.tsx"), true);
		assert.equal(match("src/**/*.{test,spec}.ts", "src/a/b.spec.ts"), true);
		assert.equal(match("src/**/*.{test,spec}.ts", "src/a/b.main.ts"), false);
	});

	it("escapes regex metacharacters in literals", () => {
		assert.equal(match("a+b.ts", "a+b.ts"), true);
		assert.equal(match("a+b.ts", "aaab.ts"), false);
		assert.equal(match("(x).ts", "(x).ts"), true);
	});

	it("honors ignoreCase", () => {
		assert.equal(match("*.TS", "a.ts"), false);
		assert.equal(match("*.TS", "a.ts", { ignoreCase: true }), true);
	});

	it("compiles once to a RegExp", () => {
		const re = globToRegExp("**/*.ts");
		assert.equal(re.test("a.ts"), true);
		assert.equal(re.test("x/b.ts"), true);
		assert.equal(re.test("x/b.js"), false);
	});
});