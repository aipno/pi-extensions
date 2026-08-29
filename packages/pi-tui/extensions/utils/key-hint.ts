/**
 * 统一键位提示样式（omp keybinding-hints.ts 的对齐移植，56 行哲学：全项目一处输出）。
 *
 * 问题：面板/组件的提示文案分散硬编码（"Esc to close"、"Enter to apply"），
 * 用户改键后提示不再跟随，颜色约定（dim 键位 + muted 说明）也各自为实现。
 * 模式：`keyHint(theme, action, description)` 统一输出 dim(按键) + muted(说明)，
 * 键位一律从宿主 keybindings manager 取（改键后 UI 自动跟随；未绑定时用 fallback）。
 *
 * 宿主 `keyHint`（pi-coding-agent）依赖其全局 theme 单例，扩展侧拿不到；
 * 这里保留相同输出形状（dim 键 + 空格 + muted 说明），paint 由调用方注入。
 * macOS 上 alt 显示为 option（与 pi 内置 keybinding-hints 一致）。
 */
import { getKeybindings } from "@earendil-works/pi-tui";

function formatKeyPart(part: string): string {
	// 与 pi 内置 keybinding-hints 一致：macOS 上 alt 显示为 option
	return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

/** 单个组合键显示文本：`ctrl+o` → `ctrl+o`（部分规范化 alt→option）。 */
export function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((combo) => combo.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

/**
 * 键位绑定显示文本；未绑定（空）时回退 fallback（缺省 undefined → 返回空串，
 * 调用方据此隐藏纯键位片段）。
 */
export function bindingKeys(action: string, fallback?: string): string {
	const keys = getKeybindings().getKeys(action as never);
	if (keys.length > 0) return keys.join("/").split("/").map(formatKeyPart).join("/");
	return fallback !== undefined ? formatKeyText(fallback) : "";
}

/** dim(键位) + muted(说明)；键位为空时只剩说明。 */
export function keyHint(
	theme: { fg(color: string, text: string): string },
	action: string,
	description: string,
	fallback?: string,
): string {
	const keys = bindingKeys(action, fallback);
	const keyPart = keys ? `${theme.fg("dim", keys)} ` : "";
	return `${keyPart}${theme.fg("muted", description)}`;
}

/** 无着色版本（纯文本场景/测试）。 */
export function keyHintPlain(action: string, description: string, fallback?: string): string {
	const keys = bindingKeys(action, fallback);
	return keys ? `${keys} ${description}` : description;
}