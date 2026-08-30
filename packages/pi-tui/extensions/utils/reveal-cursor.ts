/**
 * P2(§1) 流式逐 grapheme 揭示的纯函数核心（无宿主运行时依赖，单测覆盖）。
 *
 * 语义：
 * - grapheme 游标：全消息统一计数，按 content[] 顺序跨 text 块消费；
 *   thinking/toolCall 不占游标（透传原样）。
 * - 时间闸：delta 到达时距上次推进 >= gateMs 才推进，宿主重绘帧顺带显示；
 *   密集 delta（< gateMs）合并到下一帧，保证 ≤30fps（33ms 闸）。
 * - 断流追赶：delta 停产后 backlog 非空时由调用方起 ticker，每帧
 *   revealSteps(backlog) 步进，直到 backlog 清空或新 delta 到达。
 * - 步进公式：max(3, ceil(backlog/8)) grapheme/帧（加速追赶，不丢字）。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ── grapheme 切分（Intl.Segmenter，无能力时回退 code point） ───────────────

let segmenter: Intl.Segmenter | undefined;
let segmenterFailed = false;

function getGraphemeSegmenter(): Intl.Segmenter | undefined {
	if (segmenter || segmenterFailed) return segmenter;
	try {
		segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	} catch {
		segmenterFailed = true;
	}
	return segmenter;
}

/** 测试专用：重置 Segmenter 缓存（回退路径验证）。 */
export function resetGraphemeSegmenterForTest(): void {
	segmenter = undefined;
	segmenterFailed = false;
}

/** 文本的 grapheme 数（Segmented 不可用时回退 code point 切分）。 */
export function graphemeCount(text: string): number {
	if (!text) return 0;
	const seg = getGraphemeSegmenter();
	if (!seg) return [...text].length;
	let count = 0;
	for (const _ of seg.segment(text)) count++;
	return count;
}

/**
 * 从 code-point 索引 `from` 前进 `steps` 个 grapheme，返回新的 code-point 索引。
 * - from 必须位于 grapheme 边界（调用方以本函数返回值维护游标，天然满足）；
 *   若防御性传入非边界位置，则从下一个边界开始计步。
 * - 超出文本末尾时钳制到 text.length（steps 超过剩余 grapheme 数）。
 * - Segmented 不可用时按 code point 切分回退（`[...str]` 语义：代理对天然成对、
 *   不劈；组合序列按多个 code point 计）。
 */
export function advanceGraphemeCursor(text: string, from: number, steps: number): number {
	if (steps <= 0) return Math.max(0, Math.min(text.length, from));
	const seg = getGraphemeSegmenter();
	if (!seg) {
		const start = Math.max(0, Math.min(text.length, from));
		const cps = [...text];
		let acc = 0;
		let originOrdinal = -1;
		for (let i = 0; i < cps.length; i++) {
			if (acc >= start) {
				originOrdinal = i;
				break;
			}
			acc += cps[i]!.length;
		}
		if (originOrdinal === -1) return text.length;
		const targetOrdinal = Math.min(cps.length, originOrdinal + steps);
		let unit = 0;
		for (let i = 0; i < targetOrdinal; i++) unit += cps[i]!.length;
		return unit;
	}
	const start = Math.max(0, Math.min(text.length, from));
	let seen = 0;
	let target = text.length;
	for (const grapheme of seg.segment(text)) {
		const index = grapheme.index;
		if (index < start) continue;
		if (seen >= steps) {
			target = index;
			break;
		}
		seen++;
	}
	return target;
}

// ── BlockUnitCounter：增量计数，只重扫 tail ─────────────────────────────────

/**
 * 累计文本的 grapheme 增量计数器。调用方按流式增量 push（互不重叠的片段），
 * 只重扫本次 chunk 的 tail，累计文本不全量重扫。文本缩短/替换场景由调用方
 * reset() 后重推。
 */
export class BlockUnitCounter {
	private _count = 0;

	get count(): number {
		return this._count;
	}

	push(chunk: string): number {
		if (!chunk) return this._count;
		this._count += graphemeCount(chunk);
		return this._count;
	}

	reset(): void {
		this._count = 0;
	}
}

// ── 时间闸与步进公式 ───────────────────────────────────────────────────────

/**
 * 时间闸：距上次推进 >= gateMs 即允许推进（33ms 闸 ≈ 30fps）。
 * lastRevealAt 用 performance.now() 初始化于首帧推进时刻（§0.1）。
 */
export function shouldReveal(lastRevealAt: number, now: number, gateMs: number): boolean {
	return now - lastRevealAt >= gateMs;
}

/**
 * 追赶步进：max(3, ceil(backlog/8)) grapheme/帧。
 * backlog 越大步进越大（加速追赶），最小 3（保证长停顿也持续可见推进）。
 */
export function revealSteps(backlogGraphemes: number): number {
	return Math.max(3, Math.ceil(backlogGraphemes / 8));
}

// ── 截断消息构造 ───────────────────────────────────────────────────────────

/** 消息内全部 text 块（按 content[] 顺序）。thinking/toolCall 不参与。 */
export function textSegments(message: AssistantMessage): string[] {
	const segments: string[] = [];
	for (const content of message.content) {
		if (content.type === "text" && typeof content.text === "string") {
			segments.push(content.text);
		}
	}
	return segments;
}

/**
 * 按 grapheme 游标截断消息：text 块按 content[] 顺序消费游标（跨块连续），
 * 游标用尽的块截断到该块内的 grapheme 边界；thinking/toolCall 原样保留。
 * 返回新消息（浅拷贝 content 数组，块对象仅 text 截断处重建），
 * 非 text 字段全部透传。cursor >= 全文 grapheme 数时返回原消息。
 */
export function truncateMessageToCursor(
	message: AssistantMessage,
	cursor: number,
): AssistantMessage {
	if (cursor <= 0) {
		return message;
	}
	let remaining = cursor;
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const total = graphemeCount(block.text);
		if (remaining >= total) {
			remaining -= total;
			return block;
		}
		changed = true;
		const taken = advanceGraphemeCursor(block.text, 0, remaining);
		remaining = 0;
		return { ...block, text: block.text.slice(0, taken) };
	});
	if (!changed) {
		return message;
	}
	return { ...message, content };
}