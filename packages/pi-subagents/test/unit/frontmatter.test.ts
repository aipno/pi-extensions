import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, parseFrontmatterList } from "../../src/agents/frontmatter.ts";

test("parses flat frontmatter keys and body", () => {
	const { frontmatter, body } = parseFrontmatter(`---
name: scout
description: Fast recon
thinking: low
---
You are a scout.
`);
	assert.equal(frontmatter.name, "scout");
	assert.equal(frontmatter.description, "Fast recon");
	assert.equal(frontmatter.thinking, "low");
	assert.ok(body.includes("You are a scout."));
});

test("parses comma and block-list values", () => {
	const { frontmatter } = parseFrontmatter(`---
name: a
tools: read, grep, bash
aliases:
  - dev
  - coder
---
x
`);
	assert.deepEqual(parseFrontmatterList(frontmatter.tools), ["read", "grep", "bash"]);
	assert.deepEqual(parseFrontmatterList(frontmatter.aliases), ["dev", "coder"]);
});

test("parses folded and literal block scalars", () => {
	const { frontmatter } = parseFrontmatter(`---
name: a
summary: >
  one line that
  folds
code: |
  line1
  line2
---
x
`);
	assert.equal(frontmatter.summary, "one line that folds");
	assert.equal(frontmatter.code, "line1\nline2");
});

test("returns raw markdown when no frontmatter is present", () => {
	const { frontmatter, body } = parseFrontmatter("# Just a doc\n\nNo frontmatter here.");
	assert.deepEqual(frontmatter, {});
	assert.ok(body.includes("No frontmatter"));
});

test("ignores quoted scalars and keeps their inner text", () => {
	const { frontmatter } = parseFrontmatter(`---
name: "quoted name"
description: 'single quoted'
---
x
`);
	assert.equal(frontmatter.name, "quoted name");
	assert.equal(frontmatter.description, "single quoted");
});

test("body with standalone --- lines is preserved intact (L9)", () => {
	const content = "---\nname: docs\n---\n\nIntro\n\n---\n\nMore\n";
	const { frontmatter, body } = parseFrontmatter(content);
	assert.equal(frontmatter.name, "docs");
	assert.equal(body, "Intro\n\n---\n\nMore");
});

test("a --- line inside a block scalar does not close the frontmatter (L9)", () => {
	const content = "---\nname: agent\ndescription: |\n  first line\n  ---\n  second line\n---\nbody text\n";
	const { frontmatter, body } = parseFrontmatter(content);
	assert.equal(frontmatter.name, "agent");
	assert.ok(frontmatter.description.includes("---"), "block scalar keeps its content");
	assert.ok(frontmatter.description.includes("first line"));
	assert.ok(frontmatter.description.includes("second line"));
	assert.equal(body, "body text");
});