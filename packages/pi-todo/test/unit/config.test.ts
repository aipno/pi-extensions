import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetConfigCache,
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_MAX_WIDGET_LINES,
	getMaxWidgetLines,
	isValidCollapseKeySpec,
	loadConfig,
	resolveCollapseKey,
	validateGuidanceFields,
} from "../../config.ts";

// ---------------------------------------------------------------------------
// resolveCollapseKey / isValidCollapseKeySpec
// ---------------------------------------------------------------------------

test("resolves the default when unset or empty", () => {
	assert.equal(resolveCollapseKey({}), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey({ collapseKey: "" }), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey({ collapseKey: "   " }), DEFAULT_COLLAPSE_KEY);
	assert.equal(DEFAULT_COLLAPSE_KEY, "ctrl+shift+t");
});

test('resolves the "off" sentinel', () => {
	assert.equal(resolveCollapseKey({ collapseKey: "off" }), COLLAPSE_KEY_OFF);
	assert.equal(resolveCollapseKey({ collapseKey: "OFF" }), COLLAPSE_KEY_OFF);
});

test("accepts valid key specs and rejects invalid ones (falling back to the default)", () => {
	for (const valid of ["alt+o", "ctrl+]", "ctrl+}", "ctrl+shift+h", "ctrl+pagedown", "f10", "super+k"]) {
		assert.equal(resolveCollapseKey({ collapseKey: valid }), valid.toLowerCase(), `expected ${valid} accepted`);
	}
	for (const invalid of ["ctr+]", "ctrl++", "+ctrl+o", "ctrl+o+", "ctrl+shift+shift", "pageupx", "ctrl+o+?", "ctrl+  "]) {
		assert.equal(resolveCollapseKey({ collapseKey: invalid }), DEFAULT_COLLAPSE_KEY, `expected ${invalid} rejected`);
	}
});

test("isValidCollapseKeySpec mirrors pi-tui's KeyId grammar", () => {
	assert.ok(isValidCollapseKeySpec("ctrl+shift+t"));
	assert.ok(isValidCollapseKeySpec("alt+o"));
	assert.ok(!isValidCollapseKeySpec("ctr+]"));
	assert.ok(!isValidCollapseKeySpec("ctrl+shift+shift"));
	assert.ok(!isValidCollapseKeySpec("ctrl++"));
});

// ---------------------------------------------------------------------------
// getMaxWidgetLines
// ---------------------------------------------------------------------------

test("getMaxWidgetLines falls back to the default for missing/invalid values", () => {
	assert.equal(getMaxWidgetLines({}), DEFAULT_MAX_WIDGET_LINES);
	assert.equal(getMaxWidgetLines({ maxWidgetLines: 2 }), DEFAULT_MAX_WIDGET_LINES); // below the floor of 3
	assert.equal(getMaxWidgetLines({ maxWidgetLines: 0 }), DEFAULT_MAX_WIDGET_LINES);
	assert.equal(getMaxWidgetLines({ maxWidgetLines: "12" as unknown as number }), DEFAULT_MAX_WIDGET_LINES);
	assert.equal(DEFAULT_MAX_WIDGET_LINES, 12);
});

test("getMaxWidgetLines honors valid values (no ceiling)", () => {
	assert.equal(getMaxWidgetLines({ maxWidgetLines: 3 }), 3);
	assert.equal(getMaxWidgetLines({ maxWidgetLines: 8 }), 8);
	assert.equal(getMaxWidgetLines({ maxWidgetLines: 120 }), 120);
});

// ---------------------------------------------------------------------------
// validateGuidanceFields
// ---------------------------------------------------------------------------

test("keeps only valid guidance fields", () => {
	assert.deepEqual(validateGuidanceFields(undefined), {});
	assert.deepEqual(validateGuidanceFields(null), {});
	assert.deepEqual(validateGuidanceFields(42), {});
	assert.deepEqual(
		validateGuidanceFields({ promptSnippet: "s", promptGuidelines: ["a", "b"], junk: 1 }),
		{ promptSnippet: "s", promptGuidelines: ["a", "b"] },
	);
	assert.deepEqual(validateGuidanceFields({ promptSnippet: "", promptGuidelines: [] }), {});
	assert.deepEqual(validateGuidanceFields({ promptGuidelines: ["ok", ""] }), {});
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

test("loads config from the PI_TODO_CONFIG override", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-config-"));
	const file = path.join(dir, "custom.json");
	fs.writeFileSync(file, JSON.stringify({ collapseKey: "alt+o", maxWidgetLines: 8, guidance: { promptSnippet: "custom" } }));
	const prev = process.env.PI_TODO_CONFIG;
	process.env.PI_TODO_CONFIG = file;
	try {
		const cfg = loadConfig();
		assert.equal(cfg.collapseKey, "alt+o");
		assert.equal(cfg.maxWidgetLines, 8);
		assert.equal(cfg.guidance?.promptSnippet, "custom");
	} finally {
		if (prev === undefined) delete process.env.PI_TODO_CONFIG;
		else process.env.PI_TODO_CONFIG = prev;
	}
});

test("loadConfig defaults to {} on missing file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-config-"));
	const file = path.join(dir, "missing.json");
	const prev = process.env.PI_TODO_CONFIG;
	process.env.PI_TODO_CONFIG = file;
	try {
		assert.deepEqual(loadConfig(), {});
	} finally {
		if (prev === undefined) delete process.env.PI_TODO_CONFIG;
		else process.env.PI_TODO_CONFIG = prev;
	}
});

test("loadConfig reloads when the file mtime changes", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-config-"));
	const file = path.join(dir, "cached.json");
	fs.writeFileSync(file, JSON.stringify({ maxWidgetLines: 8 }));
	const prev = process.env.PI_TODO_CONFIG;
	process.env.PI_TODO_CONFIG = file;
	try {
		__resetConfigCache();
		assert.equal(loadConfig().maxWidgetLines, 8);
		fs.writeFileSync(file, JSON.stringify({ maxWidgetLines: 20 }));
		const later = new Date(Date.now() + 2000);
		fs.utimesSync(file, later, later);
		assert.equal(loadConfig().maxWidgetLines, 20);
	} finally {
		__resetConfigCache();
		if (prev === undefined) delete process.env.PI_TODO_CONFIG;
		else process.env.PI_TODO_CONFIG = prev;
	}
});

test("loadConfig defaults to {} on malformed JSON (with a warning)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-config-"));
	const file = path.join(dir, "bad.json");
	fs.writeFileSync(file, "{ not json");
	const prev = process.env.PI_TODO_CONFIG;
	process.env.PI_TODO_CONFIG = file;
	try {
		const originalWarn = console.warn;
		let warned = false;
		console.warn = () => {
			warned = true;
		};
		try {
			assert.deepEqual(loadConfig(), {});
			assert.ok(warned, "expected a warning for malformed JSON");
		} finally {
			console.warn = originalWarn;
		}
	} finally {
		if (prev === undefined) delete process.env.PI_TODO_CONFIG;
		else process.env.PI_TODO_CONFIG = prev;
	}
});