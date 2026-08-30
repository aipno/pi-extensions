/**
 * P3(§3) composer 形态注册表：主输入框（composer）的外观形态。
 *
 * 宿主开放 `ctx.ui.setEditorComponent(factory)`（CustomEditor extends Editor，
 * 文本迁移 / onSubmit·onChange 复制 / borderColor·paddingX·autocomplete /
 * actionHandlers 继承 / onEscape·onCtrlD 兜底全部由宿主接线）。
 *
 * 形态层方案（§3 定案）：StyledComposerEditor 覆写 render(width) ——
 * super.render(width) 后**仅变换首尾两行**（顶/底边框行），**行数不变**，
 * 不触碰父类内部布局与 autocomplete。autocomplete 弹出时行数变化：
 * 底边框通过"最后一条纯边框行"定位（autocomplete 行在其后）。
 *
 * registry 跨扩展共享：globalThis[Symbol.for("pi.tui.composer-styles")]，
 * 同名 id 冲突直接抛错（含冲突方提示）；同 owner 重注册（/reload）覆盖。
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";

export const COMPOSER_STYLES_REGISTRY_KEY = Symbol.for("pi.tui.composer-styles");
/** 默认形态 id：透传父类渲染，还原宿主默认观感。 */
export const DEFAULT_STYLE_ID = "pi";

/** 边框行的最大可见宽度预览（面板预览用）。 */
export const PREVIEW_WIDTH = 16;

export interface ComposerStyle {
	readonly id: string;
	/**
	 * 形态变换：输入/输出行数一致（保持父类布局）。paint 用于给形态字符
	 * 上色（编辑器 borderColor），无配色环境（测试）可传恒等函数。
	 */
	apply(rows: readonly string[], width: number, paint: (text: string) => string): string[];
}

type RegistryEntry = { style: ComposerStyle; owner: string };
type ComposerStyleRegistry = Map<string, RegistryEntry>;

function getRegistry(): ComposerStyleRegistry {
	const global = globalThis as Record<PropertyKey, unknown>;
	let registry = global[COMPOSER_STYLES_REGISTRY_KEY];
	if (!registry) {
		registry = new Map();
		global[COMPOSER_STYLES_REGISTRY_KEY] = registry;
	}
	return registry as ComposerStyleRegistry;
}

export function registerComposerStyle(
	id: string,
	style: ComposerStyle,
	owner = "pi-tui",
): void {
	if (!id || typeof id !== "string") {
		throw new Error(
			`composer style id must be a non-empty string, got ${JSON.stringify(id)}`,
		);
	}
	if (style.apply === undefined || typeof style.apply !== "function") {
		throw new Error(`composer style "${id}" must implement apply(rows, width, paint)`);
	}
	const registry = getRegistry();
	const existing = registry.get(id);
	if (existing) {
		if (existing.owner === owner) {
			// /reload 后新模块实例用同一 Symbol.for 槽重新注册：同源覆盖。
			registry.set(id, { style, owner });
			return;
		}
		throw new Error(
			`composer style "${id}" already registered by "${existing.owner}"; cannot register by "${owner}"`,
		);
	}
	registry.set(id, { style, owner });
}

export function getComposerStyle(id: string): ComposerStyle | undefined {
	return getRegistry().get(id)?.style;
}

export function listComposerStyleIds(): string[] {
	return [...getRegistry().keys()];
}

export function isRegisteredComposerStyle(id: string): boolean {
	return getRegistry().has(id);
}

// ── 纯边框行识别与定位 ─────────────────────────────────────────────────────

const SGR_STRIP = /\x1b\[[0-9;]*m/g;

function stripSgr(row: string): string {
	return row.replace(SGR_STRIP, "");
}

/** 行是否为纯水平边框（剥 SGR 后恰为 width 个 `─`；scroll indicator 行不是）。 */
export function isPureBorderRow(row: string, width: number): boolean {
	return stripSgr(row) === "─".repeat(width);
}

/** 定位最后一条纯边框行（autocomplete 行追加在底边框之后时仍能定位）。 */
export function findBottomBorderIndex(rows: readonly string[], width: number): number {
	for (let index = rows.length - 1; index >= 0; index--) {
		if (isPureBorderRow(rows[index]!, width)) return index;
	}
	return -1;
}

// ── v0 内置形态（4 种） ────────────────────────────────────────────────────

/** pi：透传父类，还原默认观感。 */
export const piStyle: ComposerStyle = {
	id: DEFAULT_STYLE_ID,
	apply: (rows) => [...rows],
};

/** box：角字符 ╭╮╰╯ 圆角盒。 */
export const boxStyle: ComposerStyle = {
	id: "box",
	apply(rows, width, paint) {
		const safe = Math.max(0, Math.floor(width));
		const out = [...rows];
		const top = rows[0];
		if (top && isPureBorderRow(top, safe)) {
			const edge = "╭" + "─".repeat(Math.max(0, safe - 2)) + "╮";
			out[0] = paint(edge.slice(0, safe));
		}
		const bottomIndex = findBottomBorderIndex(rows, safe);
		if (bottomIndex > 0) {
			const edge = "╰" + "─".repeat(Math.max(0, safe - 2)) + "╯";
			out[bottomIndex] = paint(edge.slice(0, safe));
		}
		return out;
	},
};

/** rule：顶行标题化（`─ pi ─` 居中），窄屏退化为省略号行。 */
export const ruleStyle: ComposerStyle = {
	id: "rule",
	apply(rows, width, paint) {
		const safe = Math.max(0, Math.floor(width));
		const out = [...rows];
		const top = rows[0];
		if (top && isPureBorderRow(top, safe)) {
			const title = " pi ";
			if (safe <= title.length + 2) {
				out[0] = paint("…".repeat(safe));
			} else {
				const left = Math.floor((safe - title.length) / 2);
				out[0] = paint("─".repeat(left) + title + "─".repeat(safe - left - title.length));
			}
		}
		return out;
	},
};

/** borderless：首尾行清为空白占位（行数与宽度不变，输入框无边框观感）。 */
export const borderlessStyle: ComposerStyle = {
	id: "borderless",
	apply(rows, width, paint) {
		const safe = Math.max(0, Math.floor(width));
		const out = [...rows];
		const top = rows[0];
		if (top && isPureBorderRow(top, safe)) {
			out[0] = " ".repeat(safe);
		}
		const bottomIndex = findBottomBorderIndex(rows, safe);
		if (bottomIndex > 0) {
			out[bottomIndex] = " ".repeat(safe);
		}
		return out;
	},
};

/** 注册 v0 内置形态（模块加载即确保 registry 可用）。 */
export function registerBuiltinComposerStyles(): void {
	registerComposerStyle(piStyle.id, piStyle);
	registerComposerStyle(boxStyle.id, boxStyle);
	registerComposerStyle(ruleStyle.id, ruleStyle);
	registerComposerStyle(borderlessStyle.id, borderlessStyle);
}

// ── StyledComposerEditor：形态层 ───────────────────────────────────────────

export class StyledComposerEditor extends CustomEditor {
	readonly style: ComposerStyle;

	constructor(tui: any, theme: any, keybindings: any, style: ComposerStyle) {
		super(tui, theme, keybindings);
		this.style = style;
	}

	render(width: number): string[] {
		const rows = super.render(width);
		if (this.style.id === DEFAULT_STYLE_ID) {
			return rows;
		}
		return this.style.apply(rows, Math.floor(width), (text) => this.borderColor(text));
	}
}

/**
 * 面板/命令接线：按 id 替换主输入框组件。
 * "default"/"" → setEditorComponent(undefined)，宿主自动还原 defaultEditor 并迁移文本。
 * 未注册的 id → false（调用方提示）。
 */
export function applyComposerStyle(id: string, ctx: any): boolean {
	if (id === "default" || id === "") {
		ctx.ui?.setEditorComponent?.(undefined);
		return true;
	}
	const style = getComposerStyle(id);
	if (!style) return false;
	ctx.ui?.setEditorComponent?.(
		(ui: any, theme: any, keybindings: any) =>
			new StyledComposerEditor(ui, theme, keybindings, style),
	);
	return true;
}

// 模块加载时注册内置形态（幂等：同 owner 覆盖）。
registerBuiltinComposerStyles();