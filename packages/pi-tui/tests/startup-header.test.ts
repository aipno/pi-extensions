import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	center,
	collectPiCommandNames,
	formatCwd,
	formatModelLabel,
	formatThinkingLabel,
	LOGO_TOTAL_FRAMES,
	headerColumnWidths,
	padRight,
	piLogoFrame,
	PI_BUILTIN_SLASH_COMMAND_NAMES,
	pickSlashCommandTips,
	PiStartupHeader,
	type StartupHeaderContext,
} from "../extensions/feature/shell/startup-header.ts";

// 无 ANSI 的 mock 主题：宽度即可见宽度，便于断言布局；brand 单元格原样输出。
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const TUI_STUB = { requestRender() {} } as unknown as TUI;

function makeHeader(options: {
	commands?: readonly { name: string }[];
	cwd?: string;
	model?: { provider?: string; id?: string } | null;
	thinking?: string;
} = {}) {
	const pi = {
		getCommands: () => options.commands ?? [{ name: "model" }, { name: "compact" }, { name: "hotkeys" }],
		getThinkingLevel: () => options.thinking ?? "high",
	} as never;
	const ctx = {
		cwd: options.cwd ?? "/Users/panda/Workspace/mypi",
		model: "model" in options ? options.model : { provider: "anthropic", id: "claude-opus-4-5" },
		ui: { theme },
	} as unknown as StartupHeaderContext;
	return new PiStartupHeader(pi, ctx, TUI_STUB);
}

/** 从右栏提取某行的 tips 段（行内最后一个 `│` 分隔符之后的部分）。 */
function tipsSegment(line: string): string {
	const firstBorder = line.indexOf("│");
	const separator = line.indexOf("│", firstBorder + 1);
	return line.slice(separator + 1, line.lastIndexOf("│")).trim();
}

test("圆角盒子：顶/底边框 + 侧边竖线，右栏 tips 与左栏 logo 并排", () => {
	const header = makeHeader({});
	const lines = header.render(120);
	header.dispose();

	assert.equal(lines.length, 12); // 边框 2 + 内容 10
	const top = stripAnsi(lines[0]!);
	const bottom = stripAnsi(lines.at(-1)!);

	assert.ok(top.startsWith("╭") && top.endsWith("╮"), `顶边框: ${top}`);
	assert.ok(bottom.startsWith("╰") && bottom.endsWith("╯"), `底边框: ${bottom}`);
	assert.ok(top.includes(`Pi v${VERSION}`), "顶边框标题含版本号");
	assert.ok(stripAnsi(lines[1]!).startsWith("│"), "内容行有左侧边");
	assert.ok(stripAnsi(lines[1]!).endsWith("│"), "内容行有右侧边");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 120, `所有行不超宽: ${stripAnsi(line)}`);
	}
});

test("左栏：居中 slogan、模型/effort、cwd；右栏：Getting started + Commands + /tui-style", () => {
	const header = makeHeader({});
	const lines = header.render(120);
	header.dispose();

	const plain = lines.map(stripAnsi);
	assert.ok(
		plain.some((line) => line.includes("Let's build something great")),
		"slogan 存在",
	);
	assert.ok(
		plain.some((line) => line.includes("anthropic/claude-opus-4-5 · high effort")),
		"模型 · effort 行存在",
	);
	assert.ok(
		plain.some((line) => line.includes("/Users/panda/Workspace/mypi")),
		"cwd 行存在（原始路径）",
	);
	assert.ok(
		plain.some((line) => line.includes("Getting started")),
		"右栏 Getting started 存在",
	);
	assert.ok(plain.some((line) => line.includes("Ask Pi to build it")));
	assert.ok(plain.some((line) => line.includes("Commands")));
	assert.ok(plain.some((line) => line.includes("/tui-style")), "固定命令 /tui-style 在 tips 中");
	assert.ok(
		!plain.some((line) => line.includes("Pi can explain its own features")),
		"不再渲染原生 onboarding 文案",
	);
});

test("slogan 在左栏内居中", () => {
	const header = makeHeader({});
	const lines = header.render(120);
	header.dispose();

	const plain = lines.map(stripAnsi);
	const slogan = plain.find((line) => line.includes("Let's build something great"))!;
	const leftColumn = slogan.slice(1, slogan.indexOf("│", 1));
	const leftPad = leftColumn.indexOf("Let's");
	const rightPad =
		visibleWidth(leftColumn) - leftPad - visibleWidth("Let's build something great");
	assert.ok(
		Math.abs(leftPad - rightPad) <= 1,
		`slogan 在左栏内居中 (left=${leftPad} right=${rightPad})`,
	);
	assert.ok(leftPad > 0, "slogan 前有留白");
});

test("tips 在多次 render 间保持稳定（构造时已固定）", () => {
	const header = makeHeader({});
	const a = header.render(120).map(stripAnsi);
	const b = header.render(120).map(stripAnsi);
	header.dispose();

	const slashTips = (plain: string[]) =>
		plain.filter((line) => line.includes("/tui-style") || tipsSegment(line).startsWith("/")).map(tipsSegment);
	const tipsA = slashTips(a);
	const tipsB = slashTips(b);
	assert.ok(tipsA.some((tip) => tip.startsWith("/tui-style")), "固定命令 /tui-style 在右栏");
	assert.deepEqual(tipsB, tipsA, "两次 render 的 tips 命令不变");
});

test("窄屏：隐藏 tips 栏，仅渲染 logo 半 + 盒子", () => {
	const header = makeHeader({});
	const lines = header.render(40);
	header.dispose();

	const plain = lines.map(stripAnsi);
	assert.equal(lines.length, 12);
	assert.ok(stripAnsi(lines[0]!).startsWith("╭"));
	assert.ok(stripAnsi(lines.at(-1)!).startsWith("╰"));
	assert.ok(!plain.some((line) => line.includes("Getting started")), "窄屏无 tips");
	assert.ok(!plain.some((line) => line.includes("/tui-style")));
	assert.ok(plain.some((line) => line.includes("Let's build something great")));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 40, `窄屏所有行不超宽: ${stripAnsi(line)}`);
	}
});

test("超窄屏：单行最小 header", () => {
	const header = makeHeader({});
	const lines = header.render(20);
	header.dispose();
	assert.deepEqual(lines.map(stripAnsi), [`Pi v${VERSION}`]);
});

test("默认模型与 off effort 的展示（cwd 使用真实 HOME 缩写）", () => {
	const cwd = `${process.env.HOME}/proj`;
	const header = makeHeader({ model: undefined, thinking: "off", cwd });
	const lines = header.render(120).map(stripAnsi);
	header.dispose();
	assert.ok(lines.some((line) => line.includes("Default model · off effort")));
	assert.ok(lines.some((line) => line.includes("~/proj")), "cwd 行使用 ~ 缩写");
});

test("piLogoFrame：动画帧之间不同，最终帧定格为 brand mark", () => {
	const paintBrand = (text: string) => `BRAND:${text}`;
	const frame0 = piLogoFrame(0, paintBrand);
	const final = piLogoFrame(LOGO_TOTAL_FRAMES - 1, paintBrand);
	assert.equal(frame0.length, 7);
	assert.ok(final.some((line) => line.includes("BRAND:███")), "定格帧使用 brand 色");
	assert.ok(!final.some((line) => line.includes("\x1b[31m")), "定格帧无红/青/绿动画色");
	assert.notDeepEqual(final, frame0, "起始帧与定格帧不同");
});

test("LOGO_TOTAL_FRAMES 与帧数组同步：动画完整走到 accent 定格帧才结束", () => {
	const paintBrand = (text: string) => `BRAND:${text}`;
	// 末帧必须是 phase 6 定格帧（accent 色、无滑入原色）。
	const last = piLogoFrame(LOGO_TOTAL_FRAMES - 1, paintBrand);
	assert.ok(last.some((line) => line.includes("BRAND:███")), "末帧为主题 accent 定格");
	assert.ok(
		!last.some(
			(line) =>
				line.includes("\x1b[31m") || line.includes("\x1b[32m") || line.includes("\x1b[36m"),
		),
		"末帧无滑入动画原色（红/绿/青）",
	);
	// 末帧之前还有动画帧：终止帧不是滑入完成即停的中间帧。
	assert.notDeepEqual(piLogoFrame(LOGO_TOTAL_FRAMES - 2, paintBrand), last);
});

describe("headerColumnWidths", () => {
	test("宽终端：logo 半占大部分宽度，tips 是窄侧栏", () => {
		const layout = headerColumnWidths(100);
		assert.equal(layout.useTips, true);
		assert.ok(layout.leftWidth > layout.rightWidth);
		assert.ok(layout.rightWidth <= 28);
		assert.equal(layout.leftWidth + layout.rightWidth + 3, 100);
	});

	test("中宽：仍开启 tips 且 logo 半更宽", () => {
		const layout = headerColumnWidths(74);
		assert.equal(layout.useTips, true);
		assert.ok(layout.leftWidth > layout.rightWidth);
		assert.ok(layout.leftWidth >= 45);
		assert.ok(layout.rightWidth <= 28);
	});

	test("过窄：tips 隐藏，logo 半独占全部内宽", () => {
		const layout = headerColumnWidths(40);
		assert.equal(layout.useTips, false);
		assert.equal(layout.leftWidth, 40);
		assert.equal(layout.rightWidth, 0);
	});

	test("临界宽度：logo + 侧栏最小值可容纳时开启 tips", () => {
		// min left 28 + gap 3 + min tips 16 = 47
		const layout = headerColumnWidths(47);
		assert.equal(layout.useTips, true);
		assert.ok(layout.leftWidth >= 28);
		assert.ok(layout.rightWidth >= 16);
	});
});

describe("pickSlashCommandTips", () => {
	test("固定命令在前，随后是随机命令", () => {
		const tips = pickSlashCommandTips(["model", "compact", "new", "reload"], {
			fixed: ["use-default-tui"],
			count: 3,
			random: () => 0,
		});
		assert.equal(tips[0], "/use-default-tui");
		assert.equal(tips.length, 4);
		assert.ok(tips.every((t) => t.startsWith("/")));
	});

	test("默认固定 /tui-style，且从随机池中排除固定项", () => {
		const tips = pickSlashCommandTips(["tui-style", "model", "compact", "hotkeys"], {
			count: 3,
			random: () => 0,
		});
		assert.equal(tips[0], "/tui-style");
		assert.equal(tips.length, 4);
		assert.deepEqual(new Set(tips.slice(1)), new Set(["/model", "/compact", "/hotkeys"]));
	});

	test("小命令池不填充空位", () => {
		const tips = pickSlashCommandTips(["model"], {
			fixed: ["use-default-tui"],
			count: 3,
		});
		assert.deepEqual(tips, ["/use-default-tui", "/model"]);
	});
});

describe("collectPiCommandNames", () => {
	test("合并内置命令与会话命令", () => {
		const names = collectPiCommandNames([{ name: "use-default-tui" }, { name: "my-cmd" }]);
		assert.ok(names.includes("model"));
		assert.ok(names.includes(PI_BUILTIN_SLASH_COMMAND_NAMES[0]!));
		assert.ok(names.includes("my-cmd"));
		assert.ok(names.includes("use-default-tui"));
	});
});

describe("format 工具", () => {
	test("formatCwd 将 HOME 前缀缩写为 ~", () => {
		assert.equal(formatCwd("/Users/me/Workspace/mypi", "/Users/me"), "~/Workspace/mypi");
		assert.equal(formatCwd("/tmp/project", "/Users/me"), "/tmp/project");
	});

	test("formatModelLabel 优先 provider/id", () => {
		assert.equal(formatModelLabel({ provider: "anthropic", id: "claude-opus-4-5" }), "anthropic/claude-opus-4-5");
		assert.equal(formatModelLabel({ id: "gpt-5.5" }), "gpt-5.5");
		assert.equal(formatModelLabel(undefined), "Default model");
	});

	test("formatThinkingLabel 保留 off", () => {
		assert.equal(formatThinkingLabel("off"), "off");
		assert.equal(formatThinkingLabel("high"), "high");
	});
});

describe("对齐工具", () => {
	test("center 只加左留白，padRight 补齐到目标宽", () => {
		assert.equal(visibleWidth(center("abc", 10)), 6); // 3 左留白 + 3 文本
		assert.equal(center("abc", 10).startsWith(" ".repeat(3)), true);
		assert.equal(visibleWidth(padRight("abc", 8)), 8);
		assert.equal(visibleWidth(padRight("abcdefgh", 4)), 4);
		assert.ok(stripAnsi(padRight("abcdefgh", 4, "…")).endsWith("…"));
	});
});