import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatStatusLabel, I18N_NAMESPACE, t } from "../../state/i18n-bridge.ts";

// The i18n dependency is folded into this port: the bridge has no live locale
// provider, so `t(key, fallback)` is an identity passthrough and status labels
// resolve to the canonical English literals — matching the reference package's
// behavior when its optional `@juicesharp/rpiv-i18n` peer is absent.

test("namespace constant is the canonical package name", () => {
	assert.equal(I18N_NAMESPACE, "pi-todo");
});

test("`t` falls back to the inline English literal for any key", () => {
	assert.equal(t("nonexistent.key", "fallback literal"), "fallback literal");
	assert.equal(t("overlay.heading", "Todos"), "Todos");
});

test("`t` prefers locales/en.json over the inline fallback", () => {
	assert.equal(t("overlay.heading", "WRONG"), "Todos");
	assert.equal(t("status.in_progress", "WRONG"), "in progress");
});

test("formatStatusLabel returns the canonical English literal for every status", () => {
	assert.equal(formatStatusLabel("pending"), "pending");
	assert.equal(formatStatusLabel("in_progress"), "in progress");
	assert.equal(formatStatusLabel("completed"), "completed");
	assert.equal(formatStatusLabel("deleted"), "deleted");
});

test("every localized key used at render time is documented in locales/en.json", () => {
	const locale = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../locales/en.json"), "utf-8")) as Record<
		string,
		string
	>;
	// Status labels.
	for (const status of ["pending", "in_progress", "completed", "deleted"]) {
		assert.ok(`status.${status}` in locale, `expected locales/en.json to document status.${status}`);
	}
	// Overlay chrome keys.
	for (const key of ["overlay.heading", "overlay.more", "overlay.expandHint", "overlay.collapsed"]) {
		assert.ok(key in locale, `expected locales/en.json to document ${key}`);
	}
	// Command keys.
	for (const key of [
		"command.requires_interactive",
		"command.no_todos",
		"command.section.pending",
		"command.section.in_progress",
		"command.section.completed",
	]) {
		assert.ok(key in locale, `expected locales/en.json to document ${key}`);
	}
});