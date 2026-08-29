/**
 * key-hint 单测：键位从 keybindings manager 取、未绑定回退 fallback、
 * macOS alt→option（按平台断言）、空绑定 + 无 fallback → 空串。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	bindingKeys,
	formatKeyText,
	keyHint,
	keyHintPlain,
} from "../extensions/utils/key-hint.ts";

const plainTheme = {
	fg(color: string, text: string): string {
		return `[${color}:${text}]`;
	},
};

test("bindingKeys：已内置绑定的 keybinding 直接取（tui.select.confirm=enter 等）", () => {
	const confirm = bindingKeys("tui.select.confirm", "fallback");
	assert.ok(confirm.length > 0);
	assert.equal(confirm, "enter");
	// cancel 默认 escape/ctrl+c → join 为 "escape/ctrl+c" 形态。
	const cancel = bindingKeys("tui.select.cancel", "");
	assert.ok(cancel.includes("escape") || cancel.includes("ctrl+c"), cancel);
});

test("bindingKeys：宿主 app.* 定义未注册时回退 fallback，无 fallback 返回空串", () => {
	// app.* 由 pi-coding-agent 注册；扩展进程早期/测试环境可能尚未注册 → 必须回退。
	assert.equal(bindingKeys("app.session.new"), "");
	assert.equal(bindingKeys("app.session.new", "ctrl+n"), "ctrl+n");
});

test("formatKeyText：macOS alt→option，其它平台原样", () => {
	if (process.platform === "darwin") {
		assert.equal(formatKeyText("alt+y"), "option+y");
	} else {
		assert.equal(formatKeyText("alt+y"), "alt+y");
	}
	assert.equal(formatKeyText("ctrl+o"), "ctrl+o");
	assert.equal(formatKeyText("ctrl+o/enter"), "ctrl+o/enter");
});

test("keyHint：dim(键) + muted(说明)；键位空时只剩说明", () => {
	// tui.* 内置绑定可解析；app.tools.expand 在测试环境未注册 → 需要 fallback。
	const hint = keyHint(plainTheme, "app.tools.expand", "to show more", "ctrl+o");
	assert.match(hint, /\[dim:ctrl\+o\] \[muted:to show more\]/);
	// 无绑定且无 fallback → 只有说明（无 dim 段）。
	const bare = keyHint(plainTheme, "app.session.new", "new session");
	assert.equal(bare, "[muted:new session]");
});

test("keyHintPlain：无着色版本", () => {
	assert.equal(keyHintPlain("app.session.new", "new session", "ctrl+n"), "ctrl+n new session");
	assert.equal(keyHintPlain("app.session.new", "new session"), "new session");
});