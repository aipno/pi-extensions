import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	formatKeySpecForDisplay,
	loadConfig,
	resolveCollapseKey,
	validateGuidanceFields,
} from "../../config.ts";

// ---------------------------------------------------------------------------
// formatKeySpecForDisplay
// ---------------------------------------------------------------------------

test("formats modifier+key specs for display", () => {
	assert.equal(formatKeySpecForDisplay("ctrl+]"), "Ctrl+]");
	assert.equal(formatKeySpecForDisplay("alt+o"), "Alt+O");
	assert.equal(formatKeySpecForDisplay("f9"), "F9");
	assert.equal(formatKeySpecForDisplay("ctrl+pagedown"), "Ctrl+PageDown");
	assert.equal(formatKeySpecForDisplay("ctrl+shift+h"), "Ctrl+Shift+H");
	assert.equal(formatKeySpecForDisplay("esc"), "Esc");
});

// ---------------------------------------------------------------------------
// resolveCollapseKey
// ---------------------------------------------------------------------------

test("resolves the default when unset or empty", () => {
	assert.equal(resolveCollapseKey({}), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey({ collapseKey: "" }), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey({ collapseKey: "   " }), DEFAULT_COLLAPSE_KEY);
	assert.equal(DEFAULT_COLLAPSE_KEY, "ctrl+]");
});

test('resolves the "off" sentinel', () => {
	assert.equal(resolveCollapseKey({ collapseKey: "off" }), COLLAPSE_KEY_OFF);
	assert.equal(resolveCollapseKey({ collapseKey: "OFF" }), COLLAPSE_KEY_OFF);
});

test("accepts valid specs and rejects invalid ones (falling back to the default)", () => {
	for (const valid of ["alt+o", "ctrl+]", "ctrl+}", "ctrl+shift+h", "ctrl+pagedown", "f10", "super+k"]) {
		assert.equal(resolveCollapseKey({ collapseKey: valid }), valid.toLowerCase(), `expected ${valid} accepted`);
	}
	for (const invalid of ["ctr+]", "ctrl++", "+ctrl+o", "ctrl+o+", "ctrl+shift+shift", "pageupx", "ctrl+o+?", "ctrl+  "]) {
		assert.equal(resolveCollapseKey({ collapseKey: invalid }), DEFAULT_COLLAPSE_KEY, `expected ${invalid} rejected`);
	}
});

// ---------------------------------------------------------------------------
// validateGuidanceFields
// ---------------------------------------------------------------------------

test("keeps only valid guidance fields", () => {
	assert.deepEqual(validateGuidanceFields(undefined), {});
	assert.deepEqual(validateGuidanceFields(null), {});
	assert.deepEqual(validateGuidanceFields(42), {});
	assert.deepEqual(
		validateGuidanceFields({ description: "d", promptSnippet: "s", promptGuidelines: ["a", "b"], junk: 1 }),
		{ description: "d", promptSnippet: "s", promptGuidelines: ["a", "b"] },
	);
	assert.deepEqual(validateGuidanceFields({ description: "", promptSnippet: "  ", promptGuidelines: [] }), { promptSnippet: "  " });
	assert.deepEqual(validateGuidanceFields({ promptGuidelines: ["ok", ""] }), {});
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

test("loads config from the PI_ASK_USER_QUESTION_CONFIG override", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auq-config-"));
	const file = path.join(dir, "custom.json");
	fs.writeFileSync(file, JSON.stringify({ collapseKey: "alt+o", guidance: { description: "custom" } }));
	const prev = process.env.PI_ASK_USER_QUESTION_CONFIG;
	process.env.PI_ASK_USER_QUESTION_CONFIG = file;
	try {
		const cfg = loadConfig();
		assert.equal(cfg.collapseKey, "alt+o");
		assert.equal(cfg.guidance?.description, "custom");
	} finally {
		if (prev === undefined) delete process.env.PI_ASK_USER_QUESTION_CONFIG;
		else process.env.PI_ASK_USER_QUESTION_CONFIG = prev;
	}
});

test("loadConfig defaults to {} on missing file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auq-config-"));
	const file = path.join(dir, "missing.json");
	const prev = process.env.PI_ASK_USER_QUESTION_CONFIG;
	process.env.PI_ASK_USER_QUESTION_CONFIG = file;
	try {
		assert.deepEqual(loadConfig(), {});
	} finally {
		if (prev === undefined) delete process.env.PI_ASK_USER_QUESTION_CONFIG;
		else process.env.PI_ASK_USER_QUESTION_CONFIG = prev;
	}
});

test("loadConfig defaults to {} on malformed JSON (with a warning)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auq-config-"));
	const file = path.join(dir, "bad.json");
	fs.writeFileSync(file, "{ not json");
	const prev = process.env.PI_ASK_USER_QUESTION_CONFIG;
	process.env.PI_ASK_USER_QUESTION_CONFIG = file;
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
		if (prev === undefined) delete process.env.PI_ASK_USER_QUESTION_CONFIG;
		else process.env.PI_ASK_USER_QUESTION_CONFIG = prev;
	}
});