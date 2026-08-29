/**
 * edit/write 流式（partial）diff 渐进预览。
 *
 * 宿主 ToolExecutionComponent 在 args 流式阶段会以 updateResult(result, isPartial=true)
 * 携带半截 details.diff（edit）调用 renderResult，且每次 update 都重建渲染器。
 * 之前我们对 partial 一律返回 "Pending…"，半截 diff 从不露出；这里按 omp
 * streaming diff 抖动抑制（stripTrailingUnbalancedRemoval）接入渐进预览：
 *  - 剪尾后再 parse，尾部未配对的 `-`/`@@` 行不参与渲染，消除"删除先到、新增追上来"的抖动；
 *  - 显示计数省略行 `↳ +N -M · waiting…`，让用户知道后面还有内容在补齐；
 *  - 完全剪空（变更行尚未开始）时回退 Pending 占位。
 * 复用 renderEditDiffResult / renderWriteDiffResult 的完整管线（含缓存、主题、语法高亮）。
 */
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	renderEditDiffResult,
	renderWriteDiffResult,
	type DisplayConfigInput,
} from "./diff-renderer.ts";
import { splitWriteContentLines } from "./diff-text.ts";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import { stripTrailingUnbalancedRemovalText } from "./diff-stream-guard.ts";
import { countEditDiffStats } from "./diff-edit-render.ts";

/** partial 预览的最大处理行数——克制值，防巨型流式 diff 卡顿。 */
const PARTIAL_PREVIEW_MAX_LINES = 400;

function clampDeferredText(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= PARTIAL_PREVIEW_MAX_LINES) return text;
	return lines.slice(0, PARTIAL_PREVIEW_MAX_LINES).join("\n");
}

/**
 * edit partial diff 预览。
 * details.diff 缺失/无变更行时返回 undefined（调用方回退 Pending 文案）。
 */
export function renderPartialEditDiff(
	details: unknown,
	options: { expanded?: boolean; filePath?: string; isHovered?: (() => boolean) | undefined },
	config: DisplayConfigInput,
	theme: any,
): any | undefined {
	const detailsRecord = (details ?? {}) as { diff?: unknown };
	const rawDiff = sanitizeToolResultText(
		typeof detailsRecord.diff === "string" ? detailsRecord.diff : "",
	);
	if (!rawDiff.trim()) return undefined;
	const diff = clampDeferredText(rawDiff);
	const guarded = stripTrailingUnbalancedRemovalText(diff);
	const body = sanitizeToolResultText(guarded.text);
	// 剪尾后没有任何可渲染行（首帧只有 @@ 或 - 行）→ 交回调用方显示 Pending。
	if (!body.trim()) return undefined;

	const stats = countEditDiffStats({ diff: body });
	const component = renderEditDiffResult(
		{ diff: body },
		{ ...options, expanded: false },
		config,
		theme,
		"",
	);
	if (!component) return undefined;
	const hasTail = guarded.deferred;
	return {
		render(width: number): string[] {
			const lines = component.render(width);
			if (hasTail && stats) {
				lines.push(theme.fg("dim", `↳ +${stats.added} -${stats.removed} · waiting…`));
			}
			return lines;
		},
		invalidate: () => component.invalidate?.(),
	};
}

/**
 * write partial 预览：流式 args 期间 result 不存在，宿主仅给 options.isPartial →
 * 由 default-mode 传入已收到的 args.content。write 是覆盖语义（previousContent 在
 * 执行前快照、此时还没有），先按"新文件全 added"渲染，不猜删除行。
 */
export function renderPartialWriteDiff(
	content: string | undefined,
	options: { expanded?: boolean; filePath?: string; isHovered?: (() => boolean) | undefined },
	config: DisplayConfigInput,
	theme: any,
): any | undefined {
	if (typeof content !== "string") return undefined;
	const lines = splitWriteContentLines(sanitizeToolResultText(content));
	if (lines.length === 0) return undefined;

	const component = renderWriteDiffResult(
		content,
		{ ...options, expanded: false, fileExistedBeforeWrite: false },
		config,
		theme,
		"",
	);
	if (!component) return undefined;
	return {
		render(width: number): string[] {
			const rendered = component.render(width);
			// 流式 write 的 content 只增不减，无剪尾需求；仅追加计数提示。
			return [...rendered, theme.fg("dim", "↳ writing…")];
		},
		invalidate: () => component.invalidate?.(),
	};
}