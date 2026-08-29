import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTerminalText } from "../../tool/sanitize.ts";

test("sanitizeTerminalText — drops complete ANSI/C1 escape sequences without printable remnants", () => {
	assert.equal(sanitizeTerminalText("safe\u001b[31mred\u001b[0m\u009b2J"), "safered");
});

test("sanitizeTerminalText — drops OSC sequences including their payload", () => {
	assert.equal(sanitizeTerminalText("a\u001b]0;evil title\u0007b\u001b]8;;http://x\u001b\\c"), "abc");
});

test("sanitizeTerminalText — keeps task fields on one terminal line", () => {
	assert.equal(sanitizeTerminalText("one\ntwo\tthree\r"), "one two three ");
	assert.equal(sanitizeTerminalText("a\u2028b\u2029c"), "a b c");
});

test("sanitizeTerminalText — removes bare control characters and bidi overrides", () => {
	assert.equal(sanitizeTerminalText("a\u0007b\u007fc\u202egfedcba\u202c"), "abcgfedcba");
});

test("sanitizeTerminalText — leaves plain text untouched", () => {
	assert.equal(sanitizeTerminalText("plain task name with  spaces"), "plain task name with  spaces");
});