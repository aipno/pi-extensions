/**
 * terminal-capabilities 单测：COLORTERM/TERM 探测、显式覆盖、RGB→256/16 量化、
 * 动画冻结、NO_COLOR/dumb 降级。缓存须在每个用例前后 reset。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	animationFrameOrFrozen,
	detectColorSupport,
	isAnimationAllowed,
	resetTerminalCapabilityCache,
	rgbToAnsi16,
	rgbToAnsi256,
	rgbToBgAnsiForTerminal,
} from "../extensions/utils/terminal-capabilities.ts";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const previous: Record<string, string | undefined> = {};
	const keys = [...Object.keys(env), "COLORTERM", "TERM", "NO_COLOR", "PI_TUI_COLOR", "PI_TUI_ANIMATIONS", "TERM_PROGRAM", "TMUX", "CI"];
	for (const key of keys) {
		previous[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	resetTerminalCapabilityCache();
	try {
		fn();
	} finally {
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key]!;
		}
		resetTerminalCapabilityCache();
	}
}

test("detectColorSupport：COLORTERM truecolor → truecolor；TERM dumb → none", () => {
	withEnv({ COLORTERM: "truecolor", TERM: "xterm-256color" }, () => {
		assert.equal(detectColorSupport(), "truecolor");
	});
	withEnv({ TERM: "dumb" }, () => {
		assert.equal(detectColorSupport(), "none");
	});
	withEnv({ TERM: "xterm-256color" }, () => {
		assert.equal(detectColorSupport(), "256");
	});
});

test("detectColorSupport：NO_COLOR → none；显式 PI_TUI_COLOR 覆盖一切", () => {
	withEnv({ NO_COLOR: "1", COLORTERM: "truecolor" }, () => {
		assert.equal(detectColorSupport(), "none");
	});
	withEnv({ PI_TUI_COLOR: "16", COLORTERM: "truecolor" }, () => {
		assert.equal(detectColorSupport(), "16");
	});
});

test("rgbToAnsi256：主色与灰阶命中最近板色", () => {
	assert.equal(rgbToAnsi256(0, 0, 0), 0); // 纯黑 → 标准黑（与立方体 (0,0,0)=16 同色取更小码）
	assert.equal(rgbToAnsi256(255, 255, 255), 15); // 纯白 → 亮白
	assert.equal(rgbToAnsi256(0, 255, 0), 10); // 纯绿 → 亮绿
	assert.equal(rgbToAnsi256(128, 128, 128), rgbToAnsi256(127, 127, 127)); // 灰阶一致性
	// 深灰蓝 (10,20,30) 应落在灰阶区（232-255）而非彩色区。
	const dark = rgbToAnsi256(10, 20, 30);
	assert.ok(dark >= 232 || dark === 0, `深色命中灰阶/黑：${dark}`);
	const code = rgbToAnsi256(255, 0, 0);
	assert.ok([9, 196, 160, 124].includes(code), `红色系命中：${code}`);
});

test("rgbToAnsi16：主色映射到标准 16 色", () => {
	assert.equal(rgbToAnsi16(255, 0, 0), 9); // bright red
	assert.equal(rgbToAnsi16(0, 0, 255), 12); // bright blue
	assert.equal(rgbToAnsi16(255, 255, 255), 15);
	assert.equal(rgbToAnsi16(0, 0, 0), 0);
});

test("rgbToBgAnsiForTerminal：按能力发色，none 不发", () => {
	withEnv({ PI_TUI_COLOR: "truecolor" }, () => {
		assert.equal(rgbToBgAnsiForTerminal(10, 20, 30), "\x1b[48;2;10;20;30m");
	});
	withEnv({ PI_TUI_COLOR: "256" }, () => {
		assert.equal(rgbToBgAnsiForTerminal(10, 20, 30), `\x1b[48;5;${rgbToAnsi256(10, 20, 30)}m`);
	});
	withEnv({ PI_TUI_COLOR: "16" }, () => {
		assert.equal(rgbToBgAnsiForTerminal(0, 0, 0), "\x1b[48;5;0m");
	});
	withEnv({ PI_TUI_COLOR: "none" }, () => {
		assert.equal(rgbToBgAnsiForTerminal(10, 20, 30), "");
	});
});

test("isAnimationAllowed：dumb/NO_COLOR/CI 关动画；PI_TUI_ANIMATIONS=1 强制开", () => {
	withEnv({ TERM: "dumb" }, () => {
		assert.equal(isAnimationAllowed(), false);
	});
	withEnv({ NO_COLOR: "1" }, () => {
		assert.equal(isAnimationAllowed(), false);
	});
	withEnv({ CI: "1", TERM: "xterm-256color" }, () => {
		assert.equal(isAnimationAllowed(), false);
	});
	withEnv({ PI_TUI_ANIMATIONS: "1", TERM: "dumb" }, () => {
		assert.equal(isAnimationAllowed(), true);
	});
	withEnv({ TERM: "xterm-256color" }, () => {
		assert.equal(isAnimationAllowed(), true);
	});
});

test("animationFrameOrFrozen：动画禁用时冻结首帧", () => {
	const frames = ["a", "b", "c"] as const;
	withEnv({ TERM: "xterm-256color" }, () => {
		assert.equal(animationFrameOrFrozen(frames, 0, 80), "a");
		assert.equal(animationFrameOrFrozen(frames, 200, 80), "c"); // 200/80=2 → 第三帧
	});
	withEnv({ TERM: "dumb" }, () => {
		assert.equal(animationFrameOrFrozen(frames, 200, 80), "a"); // 冻结
	});
});