/**
 * 启动 header：移植自 Phoobobo/pi-claude-code-tui（MIT）的 PiStartupHeader 样式。
 *
 * - 圆角边框盒子：顶部 `╭─── Pi v<VERSION> ─────╮`，底部 `╰───...╯`，内容行带 `│` 侧边
 * - 动画 pi logo：install.sh 的动态变色 mark（红/青/绿三段滑入 → 灼烧闪白 → 定格为主题 accent 色）
 * - 左栏居中：logo、"Let's build something great"、`model · effort`、`cwd`
 * - 右侧 tips 栏（宽终端）：Getting started + Commands 斜杠命令，窄屏自动隐藏
 *
 * 开关仍由 `config.showStartupHeader` 控制（/tui-style → UI → Startup header）
 */
import { VERSION, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { getSharedTicker } from "../../utils/shared-ticker.ts";
import { t } from "../../utils/i18n.ts";

const LOGO_CELL = "███";
/**
 * 动画帧率：默认逐帧 120ms（约 8.3fps）。
 * 帧间隔可由 config.animationIntervalMs 缩放（面板 Animation interval ms 同源），
 * 但播放节奏用 deadline 计算而非累计 tick —— 休眠/卡顿后不漂移（omp countdown-timer 思路）。
 */
const LOGO_ANIMATION_INTERVAL_MS = 120;

type LogoColor = "panel" | "cyan" | "red" | "green" | "orange" | "white" | "flash" | "brand";
type LogoFrame = {
	phase: number;
	active: "left" | "top" | "right" | "none";
	ax: number;
	ay: number;
	flash: boolean;
	white: boolean;
};

// install.sh logo 动画帧：红段从左滑入 → 青段从顶滑入 → 绿段从右滑入 →
// 闪烁灼烧 → 分区块定格 → 白闪 → 最终定格为主题 accent。
const LOGO_FRAMES: LogoFrame[] = [
	...Array.from({ length: 4 }, (_, ay) => ({ phase: 0, active: "left" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 3 }, (_, ay) => ({ phase: 1, active: "top" as const, ax: 2, ay, flash: false, white: false })),
	...Array.from({ length: 5 }, (_, ay) => ({ phase: 2, active: "right" as const, ax: 5, ay, flash: false, white: false })),
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
	{ phase: 4, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
	{ phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
	{ phase: 6, active: "none", ax: 0, ay: 0, flash: false, white: false },
];

/**
 * 动画总帧数 = LOGO_FRAMES 数组长度（22 帧 × 120ms ≈ 2.6s）。
 * 以数组派生：新增/删帧时终止条件自动跟随，避免与帧序列漂移导致动画提前截止
 * （曾硬编码 13，结果滑入完成后就停住，灼烧闪白 → 白闪 → accent 定格全被跳过）。
 */
export const LOGO_TOTAL_FRAMES = LOGO_FRAMES.length;

function colorCell(color: LogoColor, paintBrand: (text: string) => string): string {
	switch (color) {
		case "cyan":
			return `\x1b[36m${LOGO_CELL}\x1b[39m`;
		case "red":
			return `\x1b[31m${LOGO_CELL}\x1b[39m`;
		case "green":
			return `\x1b[32m${LOGO_CELL}\x1b[39m`;
		case "orange":
		case "flash":
			return `\x1b[33m${LOGO_CELL}\x1b[39m`;
		case "white":
			return `\x1b[39m${LOGO_CELL}`;
		case "brand":
			return paintBrand(LOGO_CELL);
		default:
			return " ".repeat(LOGO_CELL.length);
	}
}

function hasCell(y: number, x: number, cells: string): boolean {
	return cells.split(" ").includes(`${y},${x}`);
}

function hasPiece(y: number, x: number, py: number, px: number, cells: string): boolean {
	return cells.split(" ").some((item) => {
		const [dy, dx] = item.split(",").map(Number);
		return y === py + dy && x === px + dx;
	});
}

function logoCellColor(frame: LogoFrame, y: number, x: number): LogoColor {
	if (frame.white) {
		return hasCell(y, x, "3,2 3,3 3,4 4,2 4,4 5,2 5,3 5,5 6,2 6,5") ? "white" : "panel";
	}
	if (frame.flash && y === 6 && x >= 1 && x <= 6) return "flash";

	switch (frame.active) {
		case "left":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 1,1 2,0")) return "red";
			break;
		case "top":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 0,1 0,2 1,2")) return "cyan";
			break;
		case "right":
			if (hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 2,0 2,1")) return "green";
			break;
	}

	if (frame.phase === 6) {
		return hasCell(y, x, "3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5") ? "brand" : "panel";
	}

	if (frame.phase === 4) {
		if (hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
		if (hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
		if (hasCell(y, x, "4,5 5,5")) return "green";
		return "panel";
	}

	if (frame.phase >= 5) {
		if (hasCell(y, x, "3,2 3,3 3,4 4,4")) return "cyan";
		if (hasCell(y, x, "4,2 5,2 5,3 6,2")) return "red";
		if (hasCell(y, x, "5,5 6,5")) return "green";
		return "panel";
	}

	if (frame.phase <= 3 && hasCell(y, x, "6,1 6,2 6,3 6,4")) return "orange";
	if (frame.phase >= 2 && hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
	if (frame.phase >= 1 && hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
	if (frame.phase >= 3 && hasCell(y, x, "4,5 5,5 6,5 6,6")) return "green";
	return "panel";
}

/** 渲染指定帧的 logo：裁掉 9 行画布的空列，只输出 7 行，便于居中。 */
export function piLogoFrame(frameIndex: number, paintBrand: (text: string) => string): string[] {
	const frame = LOGO_FRAMES[frameIndex % LOGO_FRAMES.length]!;
	const grid: LogoColor[][] = [];
	for (let y = 1; y <= 7; y++) {
		const row: LogoColor[] = [];
		for (let x = 1; x <= 8; x++) row.push(logoCellColor(frame, y, x));
		grid.push(row);
	}

	let minX = 7;
	let maxX = 0;
	for (const row of grid) {
		row.forEach((cell, x) => {
			if (cell !== "panel") {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
		});
	}
	if (maxX < minX) {
		minX = 0;
		maxX = 7;
	}

	return grid.map((row) => {
		let line = "";
		for (let x = minX; x <= maxX; x++) line += colorCell(row[x]!, paintBrand);
		return line;
	});
}

function borderLine(
	left: string,
	label: string,
	right: string,
	width: number,
	paint: (text: string) => string,
): string {
	if (width <= 1) return "";
	if (width < 8 || label.length === 0) {
		return paint(truncateToWidth(left + "─".repeat(Math.max(0, width - 2)) + right, width, ""));
	}

	const before = "─── ";
	const after = " ─────";
	const fixedWidth = visibleWidth(before) + visibleWidth(label) + visibleWidth(after);
	const fill = Math.max(0, width - 2 - fixedWidth);
	return `${paint(left)}${paint(before)}${label}${paint(after)}${paint("─".repeat(fill))}${paint(right)}`;
}

function boxedLine(content: string, width: number, paint: (text: string) => string): string {
	if (width <= 2) return truncateToWidth(content, width, "");
	return `${paint("│")}${padRight(content, width - 2)}${paint("│")}`;
}

function twoColumn(
	left: string,
	right: string,
	leftWidth: number,
	rightWidth: number,
	paint: (text: string) => string,
): string {
	// Tips 栏以省略号截断（Claude Code 风格），logo 半不截断。
	return `${padRight(left, leftWidth)} ${paint("│")} ${padRight(right, rightWidth, "…")}`;
}

export function center(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return `${" ".repeat(Math.floor((width - w) / 2))}${text}`;
}

export function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = truncateToWidth(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * header 正文分栏宽度（Claude Code 比例）：
 * - Tips 栏约 28% 宽，夹在 [MIN_TIPS_WIDTH, MAX_TIPS_WIDTH] 之间
 * - logo 半吸收剩余宽度并始终更宽
 * - 过窄时隐藏 tips，logo 半独占全部内宽
 */
export const MIN_LEFT_WIDTH = 28;
export const MIN_TIPS_WIDTH = 16;
export const MAX_TIPS_WIDTH = 28;
const COLUMN_GAP = 3; // ` ${divider} `

export function headerColumnWidths(
	innerWidth: number,
	minTipsWidth = MIN_TIPS_WIDTH,
	maxTipsWidth = MAX_TIPS_WIDTH,
	minLeftWidth = MIN_LEFT_WIDTH,
): { leftWidth: number; rightWidth: number; useTips: boolean } {
	if (innerWidth <= 0) {
		return { leftWidth: 0, rightWidth: 0, useTips: false };
	}

	const gap = COLUMN_GAP;
	if (innerWidth < minLeftWidth + gap + minTipsWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	// 窄 tips 栏；logo 半吸收剩余宽度。
	let rightWidth = Math.min(maxTipsWidth, Math.max(minTipsWidth, Math.round(innerWidth * 0.28)));
	let leftWidth = innerWidth - gap - rightWidth;

	if (leftWidth < minLeftWidth) {
		leftWidth = minLeftWidth;
		rightWidth = innerWidth - gap - leftWidth;
	}

	// 保持 logo 半严格宽于 tips（Claude Code 感觉）。
	if (leftWidth <= rightWidth) {
		leftWidth = Math.ceil((innerWidth - gap) * 0.65);
		rightWidth = innerWidth - gap - leftWidth;
	}

	if (rightWidth < minTipsWidth || leftWidth < minLeftWidth) {
		return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
	}

	return { leftWidth, rightWidth, useTips: true };
}

// ---- tips：内置斜杠命令 + 会话命令，固定 `/tui-style` 打头 ----

export const PI_BUILTIN_SLASH_COMMAND_NAMES = [
	"settings",
	"model",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const;

/**
 * 生成 tips 行：固定 `fixed`（默认 `/tui-style`）在前，再随机取 `count` 条可用命令。
 * 返回带 `/` 前缀的命令名。
 */
export function pickSlashCommandTips(
	availableNames: readonly string[],
	options: {
		fixed?: readonly string[];
		count?: number;
		exclude?: readonly string[];
		/** 注入的 RNG，供测试使用。 */
		random?: () => number;
	} = {},
): string[] {
	const fixed = [...(options.fixed ?? ["tui-style"])];
	const count = options.count ?? 3;
	const exclude = new Set<string>([...(options.exclude ?? []), ...fixed]);
	const random = options.random ?? Math.random;

	const pool = [...new Set(availableNames.map((n) => n.trim()).filter(Boolean))].filter(
		(name) => !exclude.has(name),
	);

	// 部分 Fisher–Yates：均匀取 `count` 个样本。
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
	}

	const picked = pool.slice(0, Math.max(0, count));
	return [...fixed, ...picked].map((name) => (name.startsWith("/") ? name : `/${name}`));
}

/** 内置命令 + 会话注册命令（pi.getCommands()）合并去重。 */
export function collectPiCommandNames(sessionCommands: readonly { name: string }[]): string[] {
	const names = new Set<string>(PI_BUILTIN_SLASH_COMMAND_NAMES);
	for (const command of sessionCommands) {
		if (command.name) names.add(command.name);
	}
	return [...names];
}

// ---- info 行格式化 ----

export function formatCwd(cwd: string, home = process.env.HOME): string {
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export function formatModelLabel(model: { provider?: string; id?: string } | null | undefined): string {
	if (!model?.id) return t("header.defaultModel", "Default model");
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function formatThinkingLabel(level: string): string {
	return level === "off" ? "off" : level;
}

// ---- 头部组件 ----

/** startup header 需要的最小上下文形状（panel 传入完整 ctx 亦可）。 */
export interface StartupHeaderContext {
	cwd: string;
	model?: { provider?: string; id?: string } | null | undefined;
	ui: { theme: Theme };
}

export class PiStartupHeader implements Component {
	/** 当前帧（deadline 制推进，休眠后不漂移）。 */
	private frame = 0;
	/** 下帧截止时刻（ms）；deadline 制：跳过已过期的帧数赶进度，不逐帧补偿。 */
	private nextFrameAt = 0;
	/** 共享 ticker 的注销句柄（终帧后自动注销）。 */
	private stopAnimationWatch: (() => void) | null = null;
	private readonly pi: ExtensionAPI;
	private readonly ctx: StartupHeaderContext;
	private readonly tui: TUI;
	/** 构造时固定一次，动画帧切换时不会打乱 tips。 */
	private readonly tipCommands: string[];

	constructor(pi: ExtensionAPI, ctx: StartupHeaderContext, tui: TUI) {
		this.pi = pi;
		this.ctx = ctx;
		this.tui = tui;

		const pool = collectPiCommandNames(pi.getCommands());
		this.tipCommands = pickSlashCommandTips(pool, {
			fixed: ["tui-style"],
			count: 3,
		});

		// 共享 ticker 驱动 + deadline 帧：帧率常量化（默认 120ms/帧），
		// 休眠/卡顿后按错过帧数直接跃迁，不逐帧补偿也不漂移（omp countdown-timer 思路）。
		this.nextFrameAt = Date.now() + LOGO_ANIMATION_INTERVAL_MS;
		this.stopAnimationWatch = getSharedTicker(LOGO_ANIMATION_INTERVAL_MS).watch(() => {
			const now = Date.now();
			if (now < this.nextFrameAt) return;
			// 跳到下一个未过期的 slot，避免休眠后连发追帧。
			const missed = Math.floor((now - this.nextFrameAt) / LOGO_ANIMATION_INTERVAL_MS);
			this.nextFrameAt += (missed + 1) * LOGO_ANIMATION_INTERVAL_MS;
			if (this.frame < LOGO_TOTAL_FRAMES - 1) {
				this.frame = Math.min(LOGO_TOTAL_FRAMES - 1, this.frame + 1 + missed);
				this.tui.requestRender();
			} else {
				this.stopAnimationWatch?.();
				this.stopAnimationWatch = null;
			}
		});
	}

	render(width: number): string[] {
		// 每次渲染重读主题，/theme 切换即时生效。
		const theme = this.ctx.ui.theme;
		const paint = (s: string) => theme.fg("accent", s);
		const muted = (s: string) => theme.fg("muted", s);
		const dim = (s: string) => theme.fg("dim", s);
		const bold = (s: string) => theme.bold(s);

		if (width < 24) return [paint(`Pi v${VERSION}`)];

		const innerWidth = width - 2;
		const { leftWidth, rightWidth, useTips } = headerColumnWidths(innerWidth);
		const model = formatModelLabel(this.ctx.model);
		const effort = formatThinkingLabel(this.pi.getThinkingLevel());
		const cwd = formatCwd(this.ctx.cwd);

		const leftLines = [
			...piLogoFrame(this.frame, paint).map((line) => center(line, leftWidth)),
			center(bold(t("header.tagline", "Let's build something great")), leftWidth),
			center(muted(t("header.effort", "{model} · {effort} effort", { model, effort })), leftWidth),
			center(dim(cwd), leftWidth),
		];

		// 固定 `/tui-style` + 3 条随机真实命令（构造时已选定）。
		const tipDivider = paint("─".repeat(Math.max(8, Math.min(rightWidth, 22))));
		const [cmd0 = "", cmd1 = "", cmd2 = "", cmd3 = ""] = this.tipCommands;
		const tipLines = [
			"",
			paint(bold(t("header.gettingStarted", "Getting started"))),
			muted(t("header.askPi", "Ask Pi to build it")),
			tipDivider,
			paint(bold(t("header.commands", "Commands"))),
			muted(cmd0),
			muted(cmd1),
			muted(cmd2),
			muted(cmd3),
			"",
		];

		const lines = [borderLine("╭", `${paint("Pi")} v${VERSION}`, "╮", width, paint)];
		for (let i = 0; i < leftLines.length; i++) {
			const content = useTips
				? twoColumn(leftLines[i] ?? "", tipLines[i] ?? "", leftWidth, rightWidth, paint)
				: padRight(leftLines[i] ?? "", leftWidth);
			lines.push(boxedLine(content, width, paint));
		}
		lines.push(borderLine("╰", "", "╯", width, paint));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	dispose(): void {
		this.stopAnimationWatch?.();
		this.stopAnimationWatch = null;
	}
}

/** 进程内最近一次注册的 ExtensionAPI（供 panel 无参调用时取命令列表）。 */
let activePi: ExtensionAPI | undefined;

const FALLBACK_PI = {
	getCommands: () => [],
	getThinkingLevel: () => "medium",
} as unknown as ExtensionAPI;

/**
 * 按配置应用启动头：on → 自定义 header；off → 恢复官方默认 header。
 * 导出供 /tui-style 面板在切换开关时实时重应用。
 */
export function applyStartupHeader(ctx: any, pi?: ExtensionAPI): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function") return;
	if (pi) activePi = pi;
	if (!config.showStartupHeader) {
		// 恢复官方内置 header。
		ctx.ui.setHeader(undefined);
		return;
	}
	const resolvedPi = activePi ?? FALLBACK_PI;
	ctx.ui.setHeader((tui: TUI, _theme: Theme) => new PiStartupHeader(resolvedPi, ctx, tui));
}

export default function piStartupHeader(pi: ExtensionAPI) {
	activePi = pi;
	pi.on("session_start", async (_event, ctx) => {
		applyStartupHeader(ctx, pi);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader(undefined);
	});
}