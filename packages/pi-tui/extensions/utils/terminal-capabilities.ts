/**
 * 终端能力探测与优雅降级（omp terminal-capabilities.ts 的轻量版）。
 *
 * 不做 omp 那套 1370 行的逐终端矩阵（kitty/sixel/OSC9 等扩展侧做不了或收益低），
 * 只补两层对我们渲染有实际影响的降级：
 *  1. 真彩 → 256 色：COLORTERM 未声明 truecolor 时，diff 调色板里合成的
 *     `48;2;r;g;b` 背景色可能被老终端映射到离谱颜色甚至丢色；这里在发色前把
 *     RGB 量化到 xterm 256 色板最近色。
 *  2. 无能力环境（dumb 终端 / NO_COLOR / CI）降级：关动画（spinner 帧冻结），
 *     背景色退 16 色，none 时不发背景色。
 *
 * 探测只读环境变量（进程启动后缓存），不做 SGR 查询往返（那需要宿主配合）。
 * 显式覆盖：PI_TUI_COLOR=truecolor|256|16|none、PI_TUI_ANIMATIONS=1（测试用）。
 */
import { ansi16ToRgb, ansi256ToRgb } from "./ansi-color.ts";

export type ColorSupport = "truecolor" | "256" | "16" | "none";

let cachedColorSupport: ColorSupport | undefined;
let cachedAnimationAllowed: boolean | undefined;

/** 预声明真彩的 COLORTERM 值 + 常见自带真彩的 TERM。 */
const TRUECOLOR_HINTS = /truecolor|24bit/i;
const TRUECOLOR_TERMINALS = /iterm|alacritty|wezterm|kitty|ghostty|warp|vscode|contour/i;

export function detectColorSupport(env: NodeJS.ProcessEnv = process.env): ColorSupport {
	if (env === process.env && cachedColorSupport) return cachedColorSupport;
	const support = computeColorSupport(env);
	if (env === process.env) cachedColorSupport = support;
	return support;
}

function computeColorSupport(env: NodeJS.ProcessEnv): ColorSupport {
	// 显式降级开关：测试与用户强制降级用（omp ascii preset 的环境开关思路）。
	switch (env.PI_TUI_COLOR) {
		case "none":
			return "none";
		case "16":
			return "16";
		case "256":
			return "256";
		case "truecolor":
			return "truecolor";
	}

	if (env.NO_COLOR) return "none";
	const term = env.TERM ?? "";
	if (term === "dumb") return "none";
	// TERM/CI 均无（纯管道、无 TTY 进程）：保守 256（不猜 truecolor）。
	if (!term && !env.TERM_PROGRAM && !env.TMUX) return "256";
	if (TRUECOLOR_HINTS.test(env.COLORTERM ?? "") || TRUECOLOR_TERMINALS.test(term)) {
		return "truecolor";
	}
	// 现代终端基准假设是 256 色（xterm-256color/screen/tmux/linux/rxvt…）。
	return "256";
}

/** 是否允许动画（spinner/logo）：dumb / NO_COLOR / CI 降级为静帧；PI_TUI_ANIMATIONS=1 强制开。 */
export function isAnimationAllowed(): boolean {
	if (cachedAnimationAllowed !== undefined) return cachedAnimationAllowed;
	const env = process.env;
	const allowed =
		env.PI_TUI_ANIMATIONS === "1" ||
		(env.TERM !== "dumb" && detectColorSupport() !== "none" && !env.CI);
	cachedAnimationAllowed = allowed;
	return allowed;
}

/** 测试与 /reload 后重新探测（进程环境在测试里可被改写）。 */
export function resetTerminalCapabilityCache(): void {
	cachedColorSupport = undefined;
	cachedAnimationAllowed = undefined;
}

// ---------------------------------------------------------------------------
// RGB → 终端色板最近色量化
// ---------------------------------------------------------------------------

/** xterm 256 色板全量 RGB（懒缓存）。 */
let paletteCache: [number, number, number][] | undefined;
function xtermPalette(): [number, number, number][] {
	if (paletteCache) return paletteCache;
	const palette: [number, number, number][] = [];
	for (let code = 0; code <= 255; code++) palette.push(ansi256ToRgb(code));
	paletteCache = palette;
	return palette;
}

/**
 * RGB → 最近 xterm 256 色码。加权欧氏距离（2/4/3），与感知亮度近似对齐。
 * 全板线性扫描仅 256 项，且调用点（diff 调色板解析）每主题只发生几次，无需优化。
 */
export function rgbToAnsi256(r: number, g: number, b: number): number {
	const wr = 2;
	const wg = 4;
	const wb = 3;
	let bestCode = 0;
	let bestScore = Number.POSITIVE_INFINITY;
	const palette = xtermPalette();
	for (let code = 0; code <= 255; code++) {
		const [pr, pg, pb] = palette[code]!;
		const score =
			wr * (pr - r) * (pr - r) + wg * (pg - g) * (pg - g) + wb * (pb - b) * (pb - b);
		if (score < bestScore) {
			bestScore = score;
			bestCode = code;
		}
	}
	return bestCode;
}

/** RGB → 最近 ANSI 16 色码（0-15，与 ansi-color.ts 的标准 xterm 色序一致）。 */
export function rgbToAnsi16(r: number, g: number, b: number): number {
	let best = 7;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let index = 0; index < 16; index++) {
		const [pr, pg, pb] = ansi16ToRgb(index);
		const score = 2 * (pr - r) ** 2 + 4 * (pg - g) ** 2 + 3 * (pb - b) ** 2;
		if (score < bestScore) {
			bestScore = score;
			best = index;
		}
	}
	return best;
}

/** 便捷封装：按当前能力把 RGB 转为 bg ANSI 序列（none → 空串，不发色）。 */
export function rgbToBgAnsiForTerminal(r: number, g: number, b: number): string {
	switch (detectColorSupport()) {
		case "truecolor":
			return `\x1b[48;2;${r};${g};${b}m`;
		case "256":
			return `\x1b[48;5;${rgbToAnsi256(r, g, b)}m`;
		case "16":
			return `\x1b[48;5;${rgbToAnsi16(r, g, b)}m`;
		default:
			return "";
	}
}

/** 动画冻结工具：不允许动画时 spinner 死在第一帧而不是鬼畜。 */
export function animationFrameOrFrozen<T>(frames: readonly T[], now: number, intervalMs: number): T {
	if (!isAnimationAllowed()) return frames[0] as T;
	return frames[Math.floor(now / intervalMs) % frames.length] as T;
}