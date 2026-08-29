/**
 * 自定义 footer 测试（user.md 设计稿）：
 * - formatTokens / formatPercent / renderContextBar
 * - countEnabledMcpServers / defaultMcpConfigPaths：mcp.json 服务数统计
 * - computeUsageTotals：assistant / toolResult / branch_summary / compaction 累加与 cache hit rate
 * - renderFooterLines：两行布局（模型·思考 | 进度条；cwd目录名 | 分支 | MCP | CH | TPS | 成本）+ status 行
 * - applyFooter：on → 注册渲染器（含 branch 监听与 dispose）；off → setFooter(undefined)
 * - normalizeConfig / DEFAULT_CONFIG 的 enableCustomFooter 解析
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	applyFooter,
	computeUsageTotals,
	countEnabledMcpServers,
	defaultMcpConfigPaths,
	estimateStreamOutputTokens,
	formatPercent,
	formatTps,
	formatTokens,
	installCustomFooter,
	liveTpsRefreshSettings,
	renderContextBar,
	renderFooterLines,
	type FooterSnapshot,
} from "../extensions/feature/footer.ts";
import { config, DEFAULT_CONFIG, normalizeConfig } from "../extensions/config/config.ts";

// 测试用主题：fg 原样返回，输出为纯文本便于断言。
const plainTheme = {
	fg(color: string, text: string): string {
		return text;
	},
};

function assistant(
	usage: Record<string, unknown>,
	extra: Record<string, unknown> = {},
	entryExtra: Record<string, unknown> = {},
) {
	return {
		type: "message",
		message: { role: "assistant", usage, ...extra },
		...entryExtra,
	};
}

function toolResult(usage: Record<string, unknown>) {
	return { type: "message", message: { role: "toolResult", usage } };
}

function withUsage(entryType: string, usage: Record<string, unknown>) {
	return { type: entryType, usage };
}

const cost = (total: number) => ({ total, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

test("formatTokens：1k / 12k / 2.5k / 1.2M / 原样", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(12345), "12k");
	assert.equal(formatTokens(200000), "200k");
	assert.equal(formatTokens(1234567), "1.2M");
	assert.equal(formatTokens(12345678), "12M");
});

test("formatPercent：0 → 0（无 .0 尾巴）、45.2 / 100 保留", () => {
	assert.equal(formatPercent(0), "0");
	assert.equal(formatPercent(45.2), "45.2");
	assert.equal(formatPercent(100), "100");
	assert.equal(formatPercent(97.25), "97.3");
});

test("renderContextBar：百分比 → 10 格块字符进度条", () => {
	assert.equal(renderContextBar(0), "░░░░░░░░░░");
	assert.equal(renderContextBar(45.2), "█████░░░░░");
	assert.equal(renderContextBar(100), "██████████");
	assert.equal(renderContextBar(null), "░░░░░░░░░░");
	assert.equal(renderContextBar(undefined), "░░░░░░░░░░");
});

test("countEnabledMcpServers：统计未 disabled 的服务，跳过损坏文件", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tui-footer-"));
	const good = join(dir, "good.json");
	const bad = join(dir, "bad.json");
	const missing = join(dir, "missing.json");
	writeFileSync(
		good,
		JSON.stringify({
			mcpServers: {
				alpha: { command: "node" },
				beta: { command: "node", disabled: true },
				gamma: { command: "node", disabled: false },
				"": { command: "node" }, // 空名不计
			},
		}),
	);
	writeFileSync(bad, "not json {");
	assert.equal(countEnabledMcpServers([good]), 2);
	assert.equal(countEnabledMcpServers([good, bad]), 2, "损坏文件按 0 计，不抛错");
	assert.equal(countEnabledMcpServers([missing]), 0);
	assert.equal(countEnabledMcpServers([]), 0);
});

test("defaultMcpConfigPaths：社区约定的四个候选路径", () => {
	const cwd = "/work/proj";
	const home = "/home/u";
	const paths = defaultMcpConfigPaths(cwd, home).map((p) => p.split(sep).join("/"));
	assert.deepEqual(paths, [
		"/home/u/.pi/agent/mcp.json",
		"/home/u/.claude/mcp.json",
		"/work/proj/.mcp.json",
		"/work/proj/mcp.json",
	]);
});

test("formatTps：取整 + tok/s；≥1k 时 k 缩写", () => {
	assert.equal(formatTps(0), "0tok/s");
	assert.equal(formatTps(47), "47tok/s");
	assert.equal(formatTps(47.6), "48tok/s");
	assert.equal(formatTps(1234), "1.2k tok/s");
	assert.equal(formatTps(12345), "12k tok/s");
	assert.equal(formatTps(-5), "0tok/s");
});

test("estimateStreamOutputTokens：provider usage 优先，否则按内容字符/4 估算", () => {
	// provider 累计 usage 优先于内容估算。
	assert.equal(
		estimateStreamOutputTokens({
			usage: { output: 88 },
			content: [{ type: "text", text: "x".repeat(400) }],
		}),
		88,
	);
	// 无 usage → text 字符 /4。
	assert.equal(
		estimateStreamOutputTokens({ content: [{ type: "text", text: "x".repeat(40) }] }),
		10,
	);
	// thinking 块计入。
	assert.equal(
		estimateStreamOutputTokens({ content: [{ type: "thinking", thinking: "y".repeat(40) }] }),
		10,
	);
	// toolCall 参数计入。
	const argsJson = JSON.stringify({ path: "/a" });
	assert.equal(
		estimateStreamOutputTokens({
		content: [{ type: "toolCall", name: "read", arguments: { path: "/a" } }],
	}),
		Math.ceil(argsJson.length / 4),
	);
	// 空内容 / 非数组 / 无内容 → 0。
	assert.equal(estimateStreamOutputTokens({ content: [] }), 0);
	assert.equal(estimateStreamOutputTokens({ content: "nope" }), 0);
	assert.equal(estimateStreamOutputTokens({}), 0);
});

test("computeUsageTotals：累加 assistant / toolResult / 摘要，含 cache hit rate", () => {
	const totals = computeUsageTotals([
		assistant({
			input: 1000,
			output: 500,
			cacheRead: 300,
			cacheWrite: 700,
			cost: cost(0.1),
		}),
		assistant({
			input: 2000,
			output: 400,
			cacheRead: 1600,
			cacheWrite: 400,
			cost: cost(0.2),
		}),
		toolResult({ input: 300, output: 0, cacheRead: 0, cacheWrite: 0, cost: cost(0.05) }),
		withUsage("branch_summary", {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: cost(0.01),
		}),
		withUsage("compaction", {
			input: 200,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			cost: cost(0.02),
		}),
		// aborted/error 消息不参与 cache hit rate 计算，但 usage 仍累计（对齐官方口径）。
		assistant(
			{ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
			{ stopReason: "aborted" },
		),
		null,
	]);
	assert.equal(totals.input, 1000 + 2000 + 300 + 100 + 200 + 10);
	assert.equal(totals.output, 500 + 400 + 0 + 50 + 100);
	assert.equal(totals.cacheRead, 300 + 1600);
	assert.equal(totals.cacheWrite, 700 + 400);
	assert.equal(totals.cost, 0.1 + 0.2 + 0.05 + 0.01 + 0.02);
	// 最近一条有效 assistant 消息的 hit rate：1600/(2000+1600+400)=40%
	assert.equal(totals.cacheHitRate, 40);
	// 无时间戳 → 无法计算 TPS，保持 undefined（不显示该段）。
	assert.equal(totals.tps, undefined);
});

test("computeUsageTotals：TPS 取同消息起止耗时，回退相邻完成间隔", () => {
	const msg = (start: number, end: string, output: number, stopReason?: string) =>
		assistant(
			{ input: 500, output, cacheRead: 100, cacheWrite: 0, cost: cost(0) },
			stopReason ? { timestamp: start, stopReason } : { timestamp: start },
			{ timestamp: end },
		);
	// 同消息起止：msg1 500ms/500tok、msg2 1000ms/120tok → 最近一条 120tok/s。
	const same = computeUsageTotals([
		msg(1_731_664_800_000, "2024-11-15T10:00:00.500Z", 500),
		msg(1_731_664_801_000, "2024-11-15T10:00:02.000Z", 120),
	]);
	assert.equal(same.tps, 120);

	// 缺 message.timestamp → 回退相邻两条消息的完成间隔：300/(3s-1s)=150。
	const fallback = computeUsageTotals([
		assistant(
			{ input: 500, output: 300, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
			{},
			{ timestamp: "2024-11-15T09:00:01.000Z" },
		),
		assistant(
			{ input: 500, output: 300, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
			{},
			{ timestamp: "2024-11-15T09:00:03.000Z" },
		),
	]);
	assert.equal(fallback.tps, 150);

	// aborted 消息不参与 TPS（即使 output 巨大）。
	const aborted = computeUsageTotals([
		msg(1_731_664_800_000, "2024-11-15T10:00:01.000Z", 999),
		msg(1_731_664_801_000, "2024-11-15T10:00:02.000Z", 888, "aborted"),
	]);
	assert.equal(aborted.tps, 999);

	// 单条消息但有起止时间 → 可算（100tok ÷ 1s）。
	assert.equal(
		computeUsageTotals([msg(1_731_664_800_000, "2024-11-15T10:00:01.000Z", 100)]).tps,
		100,
	);
	// 单条消息且缺 message.timestamp → 无区间可算，undefined。
	assert.equal(
		computeUsageTotals([
			assistant(
				{ input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: cost(0) },
				{},
				{ timestamp: "2024-11-15T10:00:01.000Z" },
			),
		]).tps,
		undefined,
	);
	assert.equal(
		computeUsageTotals([
			msg(1_731_664_800_000, "2024-11-15T10:00:01.000Z", 0),
			msg(1_731_664_801_000, "2024-11-15T10:00:02.000Z", 0),
		]).tps,
		undefined,
	);
	assert.equal(
		computeUsageTotals([
			msg(1_731_664_800_000, "2024-11-15T10:00:01.000Z", 100),
			msg(1_731_664_802_000, "2024-11-15T10:00:01.000Z", 100),
		]).tps,
		undefined,
	);
});

function snapshot(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
	return {
		cwd: "/home/u/work/proj",
		gitBranch: "main",
		entries: [
			assistant({
				input: 12345,
				output: 456,
				cacheRead: 12000,
				cacheWrite: 2500,
				cost: cost(0.012),
			}),
		],
		contextUsage: { percent: 45.2, contextWindow: 200_000 },
		model: { id: "deepseek-v4-flash", reasoning: true },
		thinkingLevel: "high",
		mcpEnabledCount: 6,
		extensionStatuses: new Map([["my-ext", "● active"]]),
		...overrides,
	};
}

test("renderFooterLines：按 user.md 设计稿渲染两行 + status 行", () => {
	const lines = renderFooterLines(snapshot(), plainTheme, 120);
	assert.equal(lines.length, 3);
	// line 1：模型 · 思考 | 进度条 百分比/窗口 (auto)
	const line1 = lines[0]!;
	assert.ok(line1.startsWith("deepseek-v4-flash · high | "), line1);
	assert.ok(line1.includes("█████░░░░░ 45.2%/200k (auto)"), line1);
	// line 2：cwd 目录名 | 分支 | MCP | CH | 成本
	const line2 = lines[1]!;
	assert.equal(
		line2,
		"proj | main | 🔌 MCP: 6 servers enabled | CH44.7% | $0.012",
		line2,
	);
	// line 3：status 行
	assert.ok(lines[2]!.includes("● active"), lines[2]);
});

test("renderFooterLines：无分支 / MCP / CH / 成本时对应段隐藏", () => {
	const lines = renderFooterLines(
		snapshot({
			gitBranch: null,
			mcpEnabledCount: 0,
			entries: [],
			contextUsage: { percent: null, contextWindow: 200_000 },
		}),
		plainTheme,
		100,
	);
	assert.equal(lines[1], "proj", lines[1]);
	// 未知占用：?/window，进度条全空。
	assert.ok(lines[0]!.includes("░".repeat(10)), lines[0]);
	assert.ok(lines[0]!.includes("?/200k (auto)"), lines[0]);
});

test("renderFooterLines：thinking off / 无模型 / 单 MCP 服务", () => {
	const lines = renderFooterLines(
		snapshot({
			thinkingLevel: "off",
			model: { id: "some-model", reasoning: true },
			mcpEnabledCount: 1,
		}),
		plainTheme,
		120,
	);
	assert.ok(lines[0]!.startsWith("some-model · off | "), lines[0]);
	assert.ok(lines[1]!.includes("🔌 MCP: 1 server enabled"), lines[1]);

	const noModel = renderFooterLines(snapshot({ model: null }), plainTheme, 120);
	assert.ok(noModel[0]!.startsWith("no model | "), noModel[0]);
	assert.equal(noModel.length, 3);
});

test("renderFooterLines：流式期间 TPS 用实时值（output ÷ elapsed），覆盖已落盘口径", () => {
	const entries = [
		assistant(
			{ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: cost(0.001) },
			{ timestamp: 1_731_664_800_000 },
			{ timestamp: "2024-11-15T10:00:00.500Z" },
		),
		assistant(
			{ input: 2000, output: 47, cacheRead: 0, cacheWrite: 0, cost: cost(0.002) },
			{ timestamp: 1_731_664_801_000 },
			{ timestamp: "2024-11-15T10:00:02.000Z" },
		),
	];
	const base = {
		cwd: "/home/u/work/proj",
		gitBranch: "main",
		entries,
		mcpEnabledCount: 6,
		extensionStatuses: new Map(),
	};
	// 未流式：已落盘口径 47 tok ÷ 1s = 47tok/s。
	assert.ok(renderFooterLines({ ...base }, plainTheme, 120)[1]!.includes("TPS:47tok/s"));
	// 流式中：实时值覆盖 → 120 tok ÷ 2s = 60tok/s。
	const live = renderFooterLines({ ...base, live: { output: 120, elapsedMs: 2000 } }, plainTheme, 120);
	assert.ok(live[1]!.includes("TPS:60tok/s"), live[1]);
	// 首 token 未到：0tok/s 也显示（跳动起点）。
	const zero = renderFooterLines({ ...base, live: { output: 0, elapsedMs: 500 } }, plainTheme, 120);
	assert.ok(zero[1]!.includes("TPS:0tok/s"), zero[1]);
	// elapsedMs <= 0（异常）：回退已落盘口径。
	const guard = renderFooterLines({ ...base, live: { output: 999, elapsedMs: 0 } }, plainTheme, 120);
	assert.ok(guard[1]!.includes("TPS:47tok/s"), guard[1]);
});

test("renderFooterLines：TPS 段位于 CH 与成本之间，无数据时隐藏", () => {
	const lines = renderFooterLines(
		snapshot({
			entries: [
				assistant(
					{ input: 1000, output: 100, cacheRead: 900, cacheWrite: 0, cost: cost(0.001) },
					{ timestamp: 1_731_664_800_000 },
					{ timestamp: "2024-11-15T10:00:00.500Z" },
				),
				assistant(
					{ input: 2000, output: 47, cacheRead: 1800, cacheWrite: 0, cost: cost(0.002) },
					{ timestamp: 1_731_664_801_000 },
					{ timestamp: "2024-11-15T10:00:02.000Z" },
				),
			],
		}),
		plainTheme,
		120,
	);
	// 47tok ÷ 1s = 47tok/s；CH 取最近一条：1800/(2000+1800)=47.4%。
	assert.equal(
		lines[1],
		"proj | main | 🔌 MCP: 6 servers enabled | CH47.4% | TPS:47tok/s | $0.003",
		lines[1],
	);

	// 单条消息（无 TPS 数据）→ 段隐藏，退化为 CH | 成本。
	const single = renderFooterLines(snapshot(), plainTheme, 120);
	assert.equal(single[1], "proj | main | 🔌 MCP: 6 servers enabled | CH44.7% | $0.012", single[1]);
});

test("renderFooterLines：窄宽度不抛错，行不超宽", () => {
	const lines = renderFooterLines(snapshot(), plainTheme, 30);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 30, `${JSON.stringify(line)} 超过 30 列`);
	}
});

test("renderFooterLines：context 阈值配色（>70 warning，>90 error）", () => {
	const theme = {
		fg(color: string, text: string): string {
			return `[${color}:${text}]`;
		},
	};
	const error = renderFooterLines(
		snapshot({ contextUsage: { percent: 92, contextWindow: 200_000 } }),
		theme,
		120,
	);
	assert.ok(error[0]!.includes("[error:█████████░]"), error[0]);
	assert.ok(error[0]!.includes("[error:92]"), error[0]);

	const warning = renderFooterLines(
		snapshot({ contextUsage: { percent: 75, contextWindow: 200_000 } }),
		theme,
		120,
	);
	assert.ok(warning[0]!.includes("[warning:████████░░]"), warning[0]);
	assert.ok(warning[0]!.includes("[warning:75]"), warning[0]);

	const normal = renderFooterLines(
		snapshot({ contextUsage: { percent: 40, contextWindow: 200_000 } }),
		theme,
		120,
	);
	assert.ok(!normal[0]!.includes("[error:") && !normal[0]!.includes("[warning:"), normal[0]);
});

test("applyFooter：on → 注册渲染器（branch 变更订阅 + dispose）；off → setFooter(undefined)", () => {
	const previous = config.enableCustomFooter;
	try {
		config.enableCustomFooter = true;
		let unsubscribeCalled = false;
		let registered: any = null;
		const ctx = {
			hasUI: true,
			model: { id: "m", reasoning: false },
			thinkingLevel: "medium",
			cwd: "/proj",
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }),
			ui: {
				setFooter(renderer: unknown) {
					registered = renderer;
				},
			},
		};
		const footerData = {
			getGitBranch: () => "feat/x",
			getExtensionStatuses: () => new Map<string, string>(),
			onBranchChange: () => {
				unsubscribeCalled = true;
				return () => {
					unsubscribeCalled = false;
				};
			},
		};
		applyFooter(ctx as never);

		assert.ok(registered, "应注册渲染器");
		// setFooter 收到的是工厂函数 (tui, theme, footerData) → 渲染器对象。
		const renderer = (registered as (tui: unknown, theme: unknown, footerData: unknown) => {
			render(width: number): string[];
			dispose: () => void;
		})({}, plainTheme, footerData);
		const lines = renderer.render(100);
		assert.ok(lines[0]!.includes("m"), lines[0]!);
		assert.ok(lines[1]!.includes("proj | feat/x"), lines[1]!);
		// dispose 来自 onBranchChange 的 unsubscribe。
		assert.equal(unsubscribeCalled, true);
		renderer.dispose();
		assert.equal(unsubscribeCalled, false);

		// off → 恢复官方默认 footer。
		config.enableCustomFooter = false;
		registered = null;
		applyFooter(ctx as never);
		assert.equal(registered, undefined);
	} finally {
		config.enableCustomFooter = previous;
	}
});

test("applyFooter：无 UI / 无 setFooter 时静默跳过", () => {
	const previous = config.enableCustomFooter;
	try {
		config.enableCustomFooter = true;
		applyFooter({ hasUI: false } as never);
		applyFooter({ hasUI: true, ui: {} } as never);
	} finally {
		config.enableCustomFooter = previous;
	}
});

test("installCustomFooter：session_start 应用、session_shutdown 恢复；旧配置残留不影响", async () => {
	const previous = config.enableCustomFooter;
	try {
		config.enableCustomFooter = true;
		const events = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
		let installed: unknown = undefined;
		installCustomFooter({
			on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) {
				events.set(name, handler);
			},
		} as never);

		const ctx = {
			hasUI: true,
			model: { id: "m" },
			cwd: "/proj",
			sessionManager: { getEntries: () => [] },
			ui: {
				setFooter(renderer: unknown) {
					installed = renderer;
				},
			},
		};
		await events.get("session_start")?.({}, ctx);
		assert.ok(installed, "session_start 应挂载自定义 footer");
		await events.get("session_shutdown")?.({}, ctx);
		assert.equal(installed, undefined, "shutdown 应恢复官方 footer");
	} finally {
		config.enableCustomFooter = previous;
	}
});

test("installCustomFooter：message 事件驱动实时 TPS，750ms 心跳重绘", async () => {
	const previous = config.enableCustomFooter;
	try {
		config.enableCustomFooter = true;
		const events = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
		let registered: unknown = undefined;
		installCustomFooter({
			on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) {
				events.set(name, handler);
			},
		} as never);

		const ctx = {
			hasUI: true,
			model: { id: "m" },
			cwd: "/proj",
			sessionManager: { getEntries: () => [] },
			ui: {
				setFooter(renderer: unknown) {
					registered = renderer;
				},
			},
		};
		await events.get("session_start")?.({}, ctx);
		assert.ok(registered, "session_start 应注册渲染器");

		let requestRenders = 0;
		const factory = registered as (
			tui: unknown,
			theme: unknown,
			footerData: unknown,
		) => {
			render(width: number): string[];
			dispose(): void;
		};
		const footerDataStub = {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => {},
		};
		const renderer = factory(
			{
				requestRender() {
					requestRenders++;
				},
			},
			plainTheme,
			footerDataStub,
		);

		const start = 1_731_664_800_000;
		const nowMock = mock.method(Date, "now", () => start);

		// 无 start 的 update：忽略，不产生实时段。
		await events.get("message_update")?.(
			{ message: { role: "assistant", content: [{ type: "text", text: "x".repeat(80) }] } },
			ctx,
		);
		assert.ok(!renderer.render(120)[1]!.includes("TPS:"), "无 start 的 update 应被忽略");

		// message_start：实时段出现，首 token 未到 → 0tok/s。
		await events.get("message_start")?.(
			{ message: { role: "assistant", timestamp: start } },
			ctx,
		);
		nowMock.mock.mockImplementation(() => start + 500);
		assert.ok(renderer.render(120)[1]!.includes("TPS:0tok/s"), "start 后应显示 0tok/s");

		// message_update：40 字符 → 估算 10 tok；1s 后 10tok/s。
		await events.get("message_update")?.(
			{ message: { role: "assistant", content: [{ type: "text", text: "x".repeat(40) }] } },
			ctx,
		);
		nowMock.mock.mockImplementation(() => start + 1000);
		assert.ok(renderer.render(120)[1]!.includes("TPS:10tok/s"), "估算 10 tok ÷ 1s");

		// provider 累计 usage 优先：200 tok，2s 后 100tok/s。
		await events.get("message_update")?.(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "y".repeat(400) }],
					usage: { output: 200 },
				},
			},
			ctx,
		);
		nowMock.mock.mockImplementation(() => start + 2000);
		assert.ok(renderer.render(120)[1]!.includes("TPS:100tok/s"), "usage 优先：200 tok ÷ 2s");

		// message_end：实时段消失（无落盘数据时无 TPS 段）。
		await events.get("message_end")?.({ message: { role: "assistant" } }, ctx);
		assert.ok(!renderer.render(120)[1]!.includes("TPS:"), "end 后实时段消失");

		// ── 心跳：真实定时器，缩小刷新间隔验证节奏 ──
		renderer.dispose();
		mock.restoreAll();
		const prevRefresh = liveTpsRefreshSettings.intervalMs;
		liveTpsRefreshSettings.intervalMs = 15;
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		let beats = 0;
		const renderer2 = factory(
			{
				requestRender() {
					beats++;
				},
			},
			plainTheme,
			footerDataStub,
		);
		// 空闲：无活动流 → 心跳不重绘。
		await sleep(50);
		assert.equal(beats, 0, "空闲不心跳");

		// 流式：持续心跳重绘。
		await events.get("message_start")?.(
			{ message: { role: "assistant", timestamp: Date.now() } },
			ctx,
		);
		await sleep(60);
		assert.ok(beats >= 2, "流式期间应持续心跳重绘");

		// 结束后停止心跳。
		await events.get("message_end")?.({ message: { role: "assistant" } }, ctx);
		const afterEnd = beats;
		await sleep(60);
		assert.equal(beats, afterEnd, "结束后不再心跳");

		// dispose 后彻底停止。
		renderer2.dispose();
		const afterDispose = beats;
		await sleep(60);
		assert.equal(beats, afterDispose, "dispose 后不再心跳");

		// shutdown：清理注册表并恢复官方 footer，不抛错。
		await events.get("session_shutdown")?.({}, ctx);
		assert.equal(registered, undefined, "shutdown 恢复官方 footer");
	} finally {
		mock.restoreAll();
		liveTpsRefreshSettings.intervalMs = 750;
		config.enableCustomFooter = previous;
	}
});

test("normalizeConfig / DEFAULT_CONFIG：enableCustomFooter 默认开，可关", () => {
	assert.equal(DEFAULT_CONFIG.enableCustomFooter, true);
	assert.equal(normalizeConfig({}).enableCustomFooter, true);
	assert.equal(normalizeConfig({ enableCustomFooter: false }).enableCustomFooter, false);
	// 用户显式写 true 也不会被误伤。
	assert.equal(normalizeConfig({ enableCustomFooter: true }).enableCustomFooter, true);
});