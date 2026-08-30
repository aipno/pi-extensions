import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { executeWrite, MAX_COMPARABLE_WRITE_BYTES } from "../../tools/write.ts";
import { executeFind } from "../../tools/find.ts";
import { executeLs } from "../../tools/ls.ts";
import { makeFixture } from "./helpers.ts";

describe("tools/write", () => {
	it("creates files with parent directories", async () => {
		const root = await makeFixture({});
		const r = await executeWrite({ path: "a/b/c.txt", content: "hello\n" }, root);
		assert.match(r.content[0].text, /Created a\/b\/c\.txt/);
		assert.equal(await readFile(join(root, "a/b/c.txt"), "utf8"), "hello\n");
	});

	it("overwrites existing files atomically", async () => {
		const root = await makeFixture({ "x.txt": "old\n" });
		const r = await executeWrite({ path: "x.txt", content: "new\n" }, root);
		assert.match(r.content[0].text, /Updated x\.txt/);
		assert.equal(await readFile(join(root, "x.txt"), "utf8"), "new\n");
		// No temp files left behind.
		const entries = await (await import("node:fs/promises")).readdir(root);
		assert.deepEqual(entries.sort(), ["x.txt"]);
	});

	it("strips leading @ and resolves relative paths", async () => {
		const root = await makeFixture({});
		await executeWrite({ path: "@y.txt", content: "z" }, root);
		assert.equal((await stat(join(root, "y.txt"))).isFile(), true);
	});

	it("writes unicode content byte-count correctly", async () => {
		const root = await makeFixture({});
		const r = await executeWrite({ path: "u.txt", content: "héllo 中文" }, root);
		assert.match(r.content[0].text, /\(13 bytes\)/);
	});

	it("records previous content in details for diff previews", async () => {
		const root = await makeFixture({ "x.txt": "old\n" });
		const r = await executeWrite({ path: "x.txt", content: "new\n" }, root);
		assert.equal(r.details?.fileExistedBeforeWrite, true);
		assert.equal(r.details?.previousContent, "old\n");
		assert.equal(r.details?.diffUnavailableReason, undefined);
	});

	it("marks new files as created (no previous content)", async () => {
		const root = await makeFixture({});
		const r = await executeWrite({ path: "fresh.txt", content: "hello" }, root);
		assert.equal(r.details?.fileExistedBeforeWrite, false);
		assert.equal(r.details?.previousContent, undefined);
	});

	it("refuses binary previous content with a reason", async () => {
		const root = await makeFixture({});
		await (await import("node:fs/promises")).writeFile(
			join(root, "bin.dat"),
			Buffer.from([0xff, 0xfe, 0x80]),
		);
		const r = await executeWrite({ path: "bin.dat", content: "text" }, root);
		assert.equal(r.details?.fileExistedBeforeWrite, true);
		assert.match(r.details?.diffUnavailableReason ?? "", /not comparable UTF-8/);
	});

	it("degrades previous content above the size bound", async () => {
		const root = await makeFixture({});
		await (await import("node:fs/promises")).writeFile(
			join(root, "big.txt"),
			"a".repeat(MAX_COMPARABLE_WRITE_BYTES + 1),
		);
		const r = await executeWrite({ path: "big.txt", content: "small" }, root);
		assert.match(r.details?.diffUnavailableReason ?? "", /exceeds/);
	});
});

describe("tools/find", () => {
	it("finds files by glob relative to the search dir", async () => {
		const root = await makeFixture({
			"src/a.ts": "",
			"src/sub/b.ts": "",
			"src/c.js": "",
			"lib/d.ts": "",
			"README.md": "",
		});
		const r = await executeFind({ pattern: "**/*.ts", path: "src" }, undefined, root);
		assert.deepEqual(r.content[0].text.split("\n").sort(), ["a.ts", "sub/b.ts"]);
	});

	it("matches basename patterns at any depth", async () => {
		const root = await makeFixture({ "a.spec.ts": "", "src/b.spec.ts": "", "src/c.ts": "" });
		const r = await executeFind({ pattern: "*.spec.ts" }, undefined, root);
		assert.deepEqual(r.content[0].text.split("\n").sort(), ["a.spec.ts", "src/b.spec.ts"]);
	});

	it("respects .gitignore", async () => {
		const root = await makeFixture({ ".gitignore": "dist/\n", "dist/build.js": "", "src/x.ts": "" });
		const r = await executeFind({ pattern: "**/*.js" }, undefined, root);
		assert.equal(r.content[0].text, "No files found matching pattern");
		const r2 = await executeFind({ pattern: "**/*.ts" }, undefined, root);
		assert.deepEqual(r2.content[0].text.split("\n"), ["src/x.ts"]);
	});

	it("respects limits with a notice", async () => {
		const root = await makeFixture({ "a1.ts": "", "a2.ts": "", "a3.ts": "" });
		const r = await executeFind({ pattern: "*.ts", limit: 2 }, undefined, root);
		assert.match(r.content[0].text, /\[2 results limit reached\]/);
	});

	it("reports no matches", async () => {
		const root = await makeFixture({ "a.ts": "" });
		const r = await executeFind({ pattern: "*.rs" }, undefined, root);
		assert.equal(r.content[0].text, "No files found matching pattern");
	});

	it("errors on missing paths", async () => {
		const root = await makeFixture({});
		await assert.rejects(() => executeFind({ pattern: "*.ts", path: "nope" }, undefined, root), /Path not found/);
	});
});

describe("tools/ls", () => {
	it("lists entries with directory markers, case-insensitive sort", async () => {
		const root = await makeFixture({});
		await mkdir(join(root, "Beta"));
		await mkdir(join(root, "alpha"));
		await (await import("node:fs/promises")).writeFile(join(root, "gamma.txt"), "");
		const r = await executeLs({ path: "." }, undefined, root);
		assert.deepEqual(r.content[0].text.split("\n"), ["alpha/", "Beta/", "gamma.txt"]);
	});

	it("says empty directory", async () => {
		const root = await makeFixture({});
		const r = await executeLs({ path: "." }, undefined, root);
		assert.equal(r.content[0].text, "(empty directory)");
	});

	it("enforces entry limits", async () => {
		const root = await makeFixture({});
		for (let i = 0; i < 5; i++) await (await import("node:fs/promises")).writeFile(join(root, `f${i}.txt`), "");
		const r = await executeLs({ path: ".", limit: 2 }, undefined, root);
		assert.match(r.content[0].text, /\[2 entries limit reached\. Use limit=4 for more\]/);
	});

	it("errors on missing paths and non-directories", async () => {
		const root = await makeFixture({ "f.txt": "" });
		await assert.rejects(() => executeLs({ path: "nope" }, undefined, root), /Path not found/);
		await assert.rejects(() => executeLs({ path: "f.txt" }, undefined, root), /Not a directory/);
	});
});