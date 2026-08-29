/**
 * 共享动画 ticker 注册表（omp tool-execution sharedSpinnerFrame 模式，issue #8731）。
 *
 * 问题：并行动画块（工具卡 spinner、grouped 工具、footer TPS 心跳）若各自 setinterval，
 * N 块并行就是 N 倍无效唤醒，且 spinner 相位不同步（glyph 步进不齐）。
 * 模式：单个 timer 驱动全部注册者，最后一块注销时自动停表；空表零开销。
 *
 * 关键语义（与 omp 一致）：
 *  - 帧率 = glyph 步进率对齐到渲染频率（默认 80ms）；渲染帧率对齐后 paints 减半、视觉无差。
 *  - tick 时回调拿到全局锁定的 now（`floor(now/interval)`），所有块同相位。
 *  - `unref` 定时器，进程退出不被 UI 动画拖住。
 */

type TickerCallback = (now: number) => void;

export class SharedTicker {
	readonly intervalMs: number;
	private callbacks = new Set<TickerCallback>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(intervalMs: number) {
		this.intervalMs = intervalMs;
	}

	private ensureTimer(): void {
		if (this.timer) return;
		const timer = setInterval(() => {
			// 单一时间源：所有块同相位（floor(now/interval) 帧）。
			this.fire(Date.now());
		}, this.intervalMs);
		timer.unref?.();
		this.timer = timer;
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private fire(now: number): void {
		// 回调内可能注册/注销（含自身），先快照再遍历。
		for (const cb of [...this.callbacks]) {
			if (!this.callbacks.has(cb)) continue;
			try {
				cb(now);
			} catch {
				// 动画回调失败不拖垮其它块：下一帧重新尝试（或由 unwatch 移除）。
			}
		}
		if (this.callbacks.size === 0) this.stopTimer();
	}

	watch(cb: TickerCallback): () => void {
		this.callbacks.add(cb);
		this.ensureTimer();
		return () => this.unwatch(cb);
	}

	unwatch(cb: TickerCallback): void {
		this.callbacks.delete(cb);
		if (this.callbacks.size === 0) this.stopTimer();
	}

	/** 测试与 /reload 清理：停表并清空全部注册。 */
	reset(): void {
		this.stopTimer();
		this.callbacks.clear();
	}

	get size(): number {
		return this.callbacks.size;
	}
}

/** 按频率缓存的 ticker 实例：同频全项目共享一个 timer，异频各自一组。 */
const tickers = new Map<number, SharedTicker>();

export function getSharedTicker(intervalMs: number): SharedTicker {
	let ticker = tickers.get(intervalMs);
	if (!ticker) {
		ticker = new SharedTicker(intervalMs);
		tickers.set(intervalMs, ticker);
	}
	return ticker;
}

/** spinner/工具卡动画：80ms 帧（与 tool-loading-icon glyph 步进率同频）。 */
export const sharedSpinnerTicker = getSharedTicker(80);

/** 测试与 /reload 清理：停掉全部 ticker。 */
export function resetSharedTickers(): void {
	for (const ticker of tickers.values()) ticker.reset();
}

export type { TickerCallback };