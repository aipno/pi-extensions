import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { executeRead } from "../../tools/read.ts";
import { makeFixture, makeTar, makeZip, writeBuffer } from "./helpers.ts";

const text = (result: Awaited<ReturnType<typeof executeRead>>): string =>
	result.content.map((c) => ("text" in c ? c.text : "")).join("\n");

describe("tools/read", () => {
	it("reads a text file with offset/limit", async () => {
		const root = await makeFixture({ "a.txt": "l1\nl2\nl3\nl4\n" });
		const r = await executeRead({ path: "a.txt", offset: 2, limit: 2 }, undefined, root);
		// Limit notices match pi: "2 more lines in file" style suffix.
		assert.equal(text(r), "l2\nl3\n\n[2 more lines in file. Use offset=4 to continue.]");
	});

	it("reports offset beyond EOF", async () => {
		const root = await makeFixture({ "a.txt": "l1\n" });
		await assert.rejects(() => executeRead({ path: "a.txt", offset: 10 }, undefined, root), /Offset 10 is beyond end of file \(2 lines total\)/);
	});

	it("emits continuation notices for user limits", async () => {
		const root = await makeFixture({ "a.txt": "l1\nl2\nl3\nl4\n" });
		const r = await executeRead({ path: "a.txt", limit: 2 }, undefined, root);
		assert.match(text(r), /\[3 more lines in file\. Use offset=3 to continue\.\]/);
	});

	it("thinks binary files are binary", async () => {
		const root = await makeFixture({});
		await writeBuffer(root, "b.bin", Buffer.from([0x00, 0x01, 0xff]));
		const r = await executeRead({ path: "b.bin" }, undefined, root);
		assert.match(text(r), /Binary file detected/);
	});

	it("returns image attachments for png magic", async () => {
		const root = await makeFixture({});
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("data")]);
		await writeBuffer(root, "img.png", png);
		const r = await executeRead({ path: "img.png" }, undefined, root);
		const image = r.content.find((c) => c.type === "image");
		assert.ok(image && image.type === "image");
		assert.equal(image.mimeType, "image/png");
	});

	it("errors on directories with a hint", async () => {
		const root = await makeFixture({});
		await mkdir(join(root, "dir"));
		await assert.rejects(() => executeRead({ path: "dir" }, undefined, root), /Is a directory/);
	});

	it("errors on missing paths", async () => {
		const root = await makeFixture({});
		await assert.rejects(() => executeRead({ path: "nope.txt" }, undefined, root), /Path not found/);
	});

	it("previews sqlite databases", async (t) => {
		let sqlite: typeof import("node:sqlite");
		try {
			sqlite = await import("node:sqlite");
		} catch {
			t.skip("node:sqlite unavailable");
			return;
		}
		const root = await makeFixture({});
		const dbPath = join(root, "data.db");
		const db = new sqlite.DatabaseSync(dbPath);
		db.exec("CREATE TABLE users (id INTEGER, name TEXT); INSERT INTO users VALUES (1, 'alice'), (2, 'bob');");
		db.close();
		const r = await executeRead({ path: "data.db" }, undefined, root);
		const output = text(r);
		assert.match(output, /Table: users \(2 rows\)/);
		assert.match(output, /id \| name/);
		assert.match(output, /1 \| alice/);
	});

	it("lists zip entries and reads members via ::", async () => {
		const root = await makeFixture({});
		const zip = makeZip([
			{ name: "docs/", data: "" },
			{ name: "docs/readme.txt", data: "hello from zip\nline2\n" },
			{ name: "main.ts", data: "export const x = 1;\n" },
		]);
		await writeBuffer(root, "archive.zip", zip);

		const listing = await executeRead({ path: "archive.zip" }, undefined, root);
		const output = text(listing);
		assert.match(output, /3 entries/);
		assert.match(output, /docs\/$/m);

		const member = await executeRead({ path: "archive.zip::docs/readme.txt" }, undefined, root);
		assert.equal(text(member), "hello from zip\nline2\n");

		const dirList = await executeRead({ path: "archive.zip::docs/" }, undefined, root);
		assert.match(text(dirList), /readme\.txt/);

		await assert.rejects(() => executeRead({ path: "archive.zip::missing.txt" }, undefined, root), /Archive member not found/);
	});

	it("lists tar.gz entries and reads members", async () => {
		const root = await makeFixture({});
		const tar = makeTar([
			{ name: "pkg/", isDir: true },
			{ name: "pkg/index.js", data: "module.exports = 1;\n" },
		]);
		await writeBuffer(root, "pkg.tar.gz", tar);
		const listing = await executeRead({ path: "pkg.tar.gz" }, undefined, root);
		assert.match(text(listing), /pkg\/index\.js/);
		const member = await executeRead({ path: "pkg.tar.gz::pkg/index.js" }, undefined, root);
		assert.equal(text(member), "module.exports = 1;\n");
	});

	it("resolves @-prefixed and absolute paths", async () => {
		const root = await makeFixture({ "a.txt": "hi\n" });
		const r1 = await executeRead({ path: "@a.txt" }, undefined, root);
		assert.equal(text(r1), "hi\n");
		const r2 = await executeRead({ path: join(root, "a.txt") }, undefined, root);
		assert.equal(text(r2), "hi\n");
	});

	it("honors default truncation with continuation guidance", async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") + "\n";
		const root = await makeFixture({ "big.txt": lines });
		const r = await executeRead({ path: "big.txt" }, undefined, root);
		const output = text(r);
		assert.match(output, /\[Showing lines 1-\d+ of 3001\. Use offset=\d+ to continue\.\]/);
	});
});