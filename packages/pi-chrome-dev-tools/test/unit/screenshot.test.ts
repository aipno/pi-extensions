import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	hasParentPathSegment,
	isPathInsideRoot,
	resolveScreenshotPath,
	saveScreenshot,
	selectAllowedRoot,
} from "../../src/screenshot.ts";

let root: string;
let cwd: string;
let temp: string;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pi-cdt-screenshot-"));
	cwd = path.join(root, "project");
	temp = path.join(root, "temp");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(temp, { recursive: true });
	// Make the OS temp dir the fixture only for default-path assertions.
	process.env.TMPDIR = temp;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.TMPDIR;
});

const PNG_BASE64 = "iVBORw0KGgo=";

test("undefined savePath resolves to a unique file inside the temp directory", () => {
	const resolved = resolveScreenshotPath(undefined, cwd);
	assert.equal(resolved.isDefault, true);
	assert.match(resolved.path, /pi-chrome-dev-tools-screenshot-[0-9a-f-]+\.png$/u);
	assert.equal(isPathInsideRoot(resolved.path, temp), true);
});

test("relative savePath resolves from the current working directory", () => {
	const resolved = resolveScreenshotPath("artifacts/home.png", cwd);
	assert.equal(resolved.isDefault, false);
	assert.equal(isPathInsideRoot(resolved.path, cwd), true);
	assert.equal(resolved.path, path.resolve(cwd, "artifacts/home.png"));
});

test("a single leading @ is stripped to match Pi file-mention paths", () => {
	const resolved = resolveScreenshotPath("@shot.png", cwd);
	assert.equal(resolved.path, path.resolve(cwd, "shot.png"));
});

test("absolute paths are accepted only inside the cwd or temp roots", () => {
	const insideCwd = resolveScreenshotPath(path.join(cwd, "inside.png"), cwd);
	assert.equal(insideCwd.path, path.join(cwd, "inside.png"));

	const insideTemp = resolveScreenshotPath(path.join(temp, "inside.png"), cwd);
	assert.equal(insideTemp.path, path.join(temp, "inside.png"));

	assert.throws(
		() => resolveScreenshotPath(path.join(root, "outside.png"), cwd),
		/must be relative to the current working directory/u,
	);
});

test("rejects empty, NUL, and parent-segment savePaths", () => {
	assert.throws(() => resolveScreenshotPath("", cwd), /must not be empty/u);
	assert.throws(() => resolveScreenshotPath("  ", cwd), /must not be empty/u);
	assert.throws(() => resolveScreenshotPath("a\0b.png", cwd), /NUL/u);
	assert.throws(() => resolveScreenshotPath("../escape.png", cwd), /'\.\.'/u);
	assert.throws(() => resolveScreenshotPath("a/../../escape.png", cwd), /'\.\.'/u);
});

test("path safety helpers behave predictably", () => {
	assert.equal(hasParentPathSegment("a/b.png"), false);
	assert.equal(hasParentPathSegment("a/../b.png"), true);
	assert.equal(hasParentPathSegment(".."), true);
	assert.equal(hasParentPathSegment("..a"), false);

	assert.equal(isPathInsideRoot("/a/b/c.png", "/a/b"), true);
	assert.equal(isPathInsideRoot("/a/b.png", "/a/b"), false);
	assert.equal(isPathInsideRoot("/a/b/cpng", "/a/b/c"), false);
	assert.equal(isPathInsideRoot("/a/b/c/d.png", "/a/b/c"), true);

	const shallow = path.join(root, "shallow");
	const deep = path.join(root, "shallow", "deep");
	assert.equal(selectAllowedRoot(deep, [shallow, deep]), deep);
	assert.equal(selectAllowedRoot(deep, [deep, shallow]), deep);
	assert.equal(selectAllowedRoot(path.join(shallow, "x.png"), [shallow, deep]), shallow);
	assert.equal(selectAllowedRoot(path.join(root, "other", "x.png"), [shallow]), undefined);
});

test("saveScreenshot writes the PNG bytes and reports the saved path", async () => {
	const savePath = path.join(cwd, "shots", "page.png");
	const result = await saveScreenshot(PNG_BASE64, savePath, cwd, undefined);

	assert.equal(result.savedPath, savePath);
	assert.equal(result.bytes, 8);
	assert.equal(result.isDefaultPath, false);
	assert.deepEqual(new Uint8Array(readFileSync(savePath)), new Uint8Array(Buffer.from(PNG_BASE64, "base64")));
});

test("saveScreenshot replaces an existing regular file", async () => {
	const savePath = path.join(cwd, "old.png");
	writeFileSync(savePath, "stale");

	const result = await saveScreenshot(PNG_BASE64, savePath, cwd, undefined);

	assert.equal(result.bytes, 8);
	assert.deepEqual(
		new Uint8Array(readFileSync(savePath)),
		new Uint8Array(Buffer.from(PNG_BASE64, "base64")),
	);
	assert.deepEqual(readdirSync(cwd).filter((name) => name.endsWith(".tmp")), []);
});

test("saveScreenshot refuses a directory target and parent symlinks", async () => {
	const directoryTarget = path.join(cwd, "dir.png");
	mkdirSync(directoryTarget);
	await assert.rejects(saveScreenshot(PNG_BASE64, directoryTarget, cwd, undefined), /directory/u);

	if (process.platform !== "win32") {
		const linkedRoot = path.join(root, "linked-root");
		mkdirSync(linkedRoot);
		const link = path.join(cwd, "linked-dir");
		symlinkSync(linkedRoot, link, "dir");
		await assert.rejects(
			saveScreenshot(PNG_BASE64, path.join(link, "escape.png"), cwd, undefined),
			/symbolic links/u,
		);
	}
});

test("saveScreenshot rejects a symbolic-link target", async (t) => {
	if (process.platform === "win32") {
		t.skip("symlinks may require privileges on Windows");
		return;
	}
	const outsideTarget = path.join(root, "outside.png");
	writeFileSync(outsideTarget, "outside");
	const link = path.join(cwd, "linked.png");
	symlinkSync(outsideTarget, link);

	await assert.rejects(saveScreenshot(PNG_BASE64, link, cwd, undefined), /symbolic link/u);
});

test("saveScreenshot does not create the default file when a savePath is provided", async () => {
	await saveScreenshot(PNG_BASE64, "ok.png", cwd, undefined);
	assert.equal(
		readdirSync(temp).filter((name) => name.startsWith("pi-chrome-dev-tools-screenshot-")).length,
		0,
	);
	assert.equal(existsSync(path.join(cwd, "ok.png")), true);
});