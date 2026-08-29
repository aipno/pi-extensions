import { animationFrameOrFrozen, isAnimationAllowed } from "./terminal-capabilities.ts";

export const TOOL_LOADING_INTERVAL_MS = 80;

const BRAILLE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function toolLoadingIcon(now = Date.now()): string {
	// dumb / NO_COLOR / CI 终端冻结在首帧（能力探测降级，omp graceful-degradation 思路）。
	return animationFrameOrFrozen(BRAILLE_LOADING_FRAMES, Math.floor(now), TOOL_LOADING_INTERVAL_MS);
}

/** 动画是否被终端能力层允许（测试与面板探测用）。 */
export function isToolAnimationAllowed(): boolean {
	return isAnimationAllowed();
}
