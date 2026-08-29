/**
 * footer-segments 单测：segment 注册表 + preset + 分隔符 + TPS duration 口径。
 * - TPS 三档优先级：message.duration → 同消息起止 → 相邻完成间隔（2026-08-29 决议）
 * - preset：default 全量、minimal 裁剪；扩展段 registerFooterSegment 不受 preset 裁剪
 * - 分隔符：pipe/slash/dot/none
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	computeUsageTotals,
	FOOTER_PRESETS,
	formatTps,
	registerFooterSegment,
	renderFooterLines,
	resetFooterSegments,
	resolveFooterSeparator,
	type FooterSegment,
	type FooterSnapshot,
} from "../extensions/feature/footer-segments.ts";

const plainTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
};

const cost = (total: number) => ({ total, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function baseSnapshot(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
	return {
		cwd: "/home/u/work/proj",
		gitBranch: "main",
		entries: [],
		contextUsage: { percent: 45.2, contextWindow: 200_000 },
		model: { id: "deepseek-v4-flash", reasoning: true },
		thinkingLevel: "high",
		mcpEnabledCount: 0,
		extensionStatuses: new Map(),
		...overrides,
	};
}

test("renderFooterLines：default preset 与旧设计稿一致（两行 + 分隔）", () => {
	const lines = renderFooterLines(
		baseSnapshot({
			entries: [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 1000, output: 456, cacheRead: 12000, cacheWrite: 2500, cost: cost(0.012) },
					},
				},
			],
			mcpEnabledCount: 6,
		}),
		plainTheme,
		120,
	);
	assert.equal(lines.length, 2);
	assert.ok(lines[0]!.startsWith("deepseek-v4-flash · high | "), lines[0]);
	assert.equal(
		lines[1],
		"proj | main | 🔌 MCP: 6 servers enabled | CH77.4% | $0.012",
		lines[1],
	);
});

test("renderFooterLines：minimal preset 隐藏 git/mcp/ch/tps 段", () => {
	const lines = renderFooterLines(
		baseSnapshot({
			gitBranch: "main",
			entries: [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 1000, output: 456, cacheRead: 12000, cacheWrite: 0, cost: cost(0.012) },
					},
				},
			],
			mcpEnabledCount: 6,
		}),
		plainTheme,
		120,
		{ preset: "minimal" },
	);
	assert.equal(lines[1], "proj | $0.012", `minimal 只剩 cwd+cost：${lines[1]}`);
});

test("renderFooterLines：分隔符可换肤（slash/dot/none）", () => {
	const snapshot = baseSnapshot({ gitBranch: "main" });
	assert.ok(
		renderFooterLines(snapshot, plainTheme, 120, { separator: "slash" })[1]!.includes("proj / main"),
	);
	assert.ok(
		renderFooterLines(snapshot, plainTheme, 120, { separator: "dot" })[1]!.includes("proj · main"),
	);
	assert.ok(
		renderFooterLines(snapshot, plainTheme, 120, { separator: "none" })[1]!.includes("proj  main"),
	);
	assert.equal(resolveFooterSeparator("dot"), " · ");
	assert.equal(resolveFooterSeparator(undefined), " | ");
});

test("renderFooterLines：不可见段整段消失且不产生双分隔符", () => {
	const lines = renderFooterLines(
		baseSnapshot({ gitBranch: null, mcpEnabledCount: 0 }),
		plainTheme,
		120,
	);
	assert.equal(lines[1], "proj", lines[1]);
});

test("computeUsageTotals：TPS ①provider duration 优先（2026-08-29 口径决议）", () => {
	// duration=1000ms/100tok → 100tok/s；同消息起止给出的 2s 值(50)不应被使用。
	const withDuration = computeUsageTotals([
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: 1_731_664_800_000,
				duration: 1000,
				usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
				stopReason: "stop",
			},
			timestamp: "2024-11-15T10:00:02.000Z",
		},
	]);
	assert.equal(withDuration.tps, 100);
});

test("computeUsageTotals：TPS ②无 duration → 同消息起止；③再退相邻间隔", () => {
	// ②：同消息 message.timestamp → entry.timestamp 差 1s。
	const byRange = computeUsageTotals([
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: 1_731_664_800_000,
				usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
			},
			timestamp: "2024-11-15T10:00:01.000Z",
		},
	]);
	assert.equal(byRange.tps, 100);

	// ③：缺 message.timestamp 与 duration → 相邻完成间隔 300/(3s-1s)=150。
	const byGap = computeUsageTotals([
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 500, output: 300, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
			},
			timestamp: "2024-11-15T09:00:01.000Z",
		},
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 500, output: 300, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
			},
			timestamp: "2024-11-15T09:00:03.000Z",
		},
	]);
	assert.equal(byGap.tps, 150);
});

test("registerFooterSegment：扩展段追加到 line2 尾部，preset 裁剪不掉，可注销", () => {
	resetFooterSegments();
	const unregister = registerFooterSegment({
		id: "my-ext",
		line: 2,
		render: (snapshot, theme) => (snapshot.gitBranch ? theme.fg("dim", "EXT") : null),
	});
	const snapshot = baseSnapshot({ gitBranch: "main" });
	const withSegment = renderFooterLines(snapshot, plainTheme, 120, { preset: "minimal" });
	assert.ok(withSegment[1]!.endsWith("| EXT"), `扩展段不受 preset 裁剪：${withSegment[1]}`);
	unregister();
	const after = renderFooterLines(snapshot, plainTheme, 120, { preset: "minimal" });
	assert.ok(!after[1]!.includes("EXT"), "注销后消失");
	resetFooterSegments();
});

test("renderFooterLines：段渲染抛错不拖垮整条状态栏", () => {
	resetFooterSegments();
	const unregister = registerFooterSegment({
		id: "boom",
		line: 2,
		render() {
			throw new Error("boom");
		},
	});
	const lines = renderFooterLines(baseSnapshot({ gitBranch: "main" }), plainTheme, 120);
	assert.ok(lines[1]!.startsWith("proj | main"), lines[1]);
	unregister();
	resetFooterSegments();
});

test("FOOTER_PRESETS：default/minimal 内容自洽（id 均存在于内置段）", () => {
	const builtinIds = new Set(["model", "context", "cwd", "git", "mcp", "ch", "tps", "cost"]);
	for (const preset of Object.values(FOOTER_PRESETS)) {
		for (const id of [...preset.line1, ...preset.line2]) {
			assert.ok(builtinIds.has(id), `未知段 id: ${id}`);
		}
	}
});