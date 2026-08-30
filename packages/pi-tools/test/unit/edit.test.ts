import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executeEdit } from "../../tools/edit.ts";
import { makeFixture } from "./helpers.ts";

describe("tools/edit", () => {
	it("replaces a unique match", async () => {
		const root = await makeFixture({ "a.txt": "alfa\nbeta\ngamma\n" });
		const r = await executeEdit({ path: "a.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, root);
		assert.equal(r.content[0].text, "Successfully replaced 1 block(s) in a.txt.");
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "alfa\nBETA\ngamma\n");
		assert.match(r.details!.diff, /-2 beta\n\+2 BETA/);
	});

	it("applies multiple disjoint edits in one call", async () => {
		const root = await makeFixture({ "a.txt": "one\ntwo\nthree\n" });
		await executeEdit(
			{ path: "a.txt", edits: [{ oldText: "one", newText: "1" }, { oldText: "three", newText: "3" }] },
			root,
		);
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "1\ntwo\n3\n");
	});

	it("rejects non-unique oldText", async () => {
		const root = await makeFixture({ "a.txt": "x\nx\n" });
		await assert.rejects(
			() => executeEdit({ path: "a.txt", edits: [{ oldText: "x", newText: "y" }] }, root),
			/Found 2 occurrences of the text in a\.txt\. The text must be unique\./,
		);
	});

	it("rejects missing oldText with guidance", async () => {
		const root = await makeFixture({ "a.txt": "abc\n" });
		await assert.rejects(
			() => executeEdit({ path: "a.txt", edits: [{ oldText: "zzz", newText: "y" }] }, root),
			/Could not find the exact text in a\.txt\. The old text must match exactly/,
		);
	});

	it("rejects overlapping edits", async () => {
		const root = await makeFixture({ "a.txt": "abcdef\n" });
		await assert.rejects(
			() =>
				executeEdit(
					{ path: "a.txt", edits: [{ oldText: "abc", newText: "X" }, { oldText: "bcd", newText: "Y" }] },
					root,
				),
			/overlap in a\.txt/,
		);
	});

	it("rejects empty oldText", async () => {
		const root = await makeFixture({ "a.txt": "abc\n" });
		await assert.rejects(
			() => executeEdit({ path: "a.txt", edits: [{ oldText: "", newText: "y" }] }, root),
			/oldText must not be empty in a\.txt\./,
		);
	});

	it("reports no-op edits", async () => {
		const root = await makeFixture({ "a.txt": "abc\n" });
		await assert.rejects(
			() => executeEdit({ path: "a.txt", edits: [{ oldText: "abc", newText: "abc" }] }, root),
			/No changes made to a\.txt\./,
		);
	});

	it("falls back to fuzzy matching for trailing whitespace in oldText", async () => {
		// Exact match fails (the model's oldText carries trailing spaces);
		// fuzzy matching finds the line, and unchanged lines keep their bytes.
		const root = await makeFixture({ "a.txt": "abc\ndef\n" });
		const r = await executeEdit({ path: "a.txt", edits: [{ oldText: "abc ", newText: "xyz" }] }, root);
		assert.equal(r.content[0].text, "Successfully replaced 1 block(s) in a.txt.");
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "xyz\ndef\n");
	});

	it("normalizes smart punctuation via fuzzy matching", async () => {
		const root = await makeFixture({ "a.txt": "it\u2019s fine\nnext\n" });
		await executeEdit({ path: "a.txt", edits: [{ oldText: "it's fine", newText: "ok" }] }, root);
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "ok\nnext\n");
	});

	it("handles CRLF files and restores CRLF", async () => {
		const root = await makeFixture({ "a.txt": "one\r\ntwo\r\n" });
		await executeEdit({ path: "a.txt", edits: [{ oldText: "two", newText: "2" }] }, root);
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\r\n2\r\n");
	});

	it("preserves a leading BOM", async () => {
		const root = await makeFixture({ "a.txt": "\uFEFFone\ntwo\n" });
		await executeEdit({ path: "a.txt", edits: [{ oldText: "two", newText: "2" }] }, root);
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "\uFEFFone\n2\n");
	});

	it("multiline oldText works", async () => {
		const root = await makeFixture({ "a.txt": "a\nb\nc\n" });
		await executeEdit({ path: "a.txt", edits: [{ oldText: "a\nb", newText: "A\nB" }] }, root);
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "A\nB\nc\n");
	});

	it("produces a valid unified patch in details", async () => {
		const root = await makeFixture({ "a.txt": "one\ntwo\nthree\n" });
		const r = await executeEdit({ path: "a.txt", edits: [{ oldText: "two", newText: "2" }] }, root);
		assert.match(r.details!.patch, /^--- a\.txt\n\+\+\+ a\.txt\n@@ -1,3 \+1,3 @@/);
		assert.equal(r.details!.firstChangedLine, 2);
	});

	it("errors on missing files", async () => {
		const root = await makeFixture({});
		await assert.rejects(() => executeEdit({ path: "nope.txt", edits: [{ oldText: "x", newText: "y" }] }, root), /Path not found/);
	});
});