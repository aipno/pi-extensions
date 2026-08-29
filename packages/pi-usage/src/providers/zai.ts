import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport, ZaiQuotaPayload } from "../types.ts";

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10_080;

export function normalizeZaiQuotaPayload(
	providerId: string,
	providerName: string,
	payload: ZaiQuotaPayload,
	capturedAt: number,
): UsageReport {
	const data = asObject(payload.data);
	if (!data) throw new Error("Z.AI quota response data was not an object.");
	const limits = Array.isArray(data.limits) ? (data.limits as unknown[]) : [];

	const buckets: UsageBucket[] = [];
	const metrics: UsageMetric[] = [];
	for (const raw of limits) {
		const limit = asObject(raw);
		if (!limit) continue;
		const type = asString(limit.type);
		const unit = asNonnegativeNumber(limit.unit);
		const isPlanUsage = type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
		if (type === "TIME_LIMIT") {
			addCountBucket(buckets, limit, "mcp-monthly", "MCP monthly allowance");
			addUsageDetailMetrics(metrics, limit.usageDetails);
		} else if (isPlanUsage && unit === 3) {
			addPercentBucket(buckets, limit, "five-hour", "5h window", FIVE_HOUR_WINDOW_MINUTES);
		} else if (isPlanUsage && unit === 6) {
			const used = asNonnegativeNumber(limit.currentValue);
			const quota = asNonnegativeNumber(limit.usage);
			if (used !== undefined && quota !== undefined) {
				addCountBucket(buckets, limit, "weekly", "Weekly window", WEEKLY_WINDOW_MINUTES);
			} else {
				addPercentBucket(buckets, limit, "weekly", "Weekly window", WEEKLY_WINDOW_MINUTES);
			}
		}
	}
	if (buckets.length === 0) {
		throw new Error("Z.AI quota endpoint returned no displayable usage data.");
	}

	const notes: string[] = [];
	const level = asString(data.level);
	if (level) notes.push(`Plan: ${level}`);

	return {
		providerId,
		providerName,
		capturedAt,
		source: "zai-quota",
		semantics: { kind: "consumer-subscription", label: "GLM Coding Plan usage" },
		buckets,
		metrics,
		...(notes.length > 0 ? { notes } : {}),
	};
}

function addPercentBucket(
	buckets: UsageBucket[],
	limit: Record<string, unknown>,
	id: string,
	label: string,
	windowMinutes: number,
): void {
	const used = asNonnegativeNumber(limit.percentage);
	if (used === undefined) return;
	const percent = clampPercent(used);
	const resetsAt = asEpochSeconds(limit.nextResetTime);
	buckets.push({
		id,
		label,
		used: percent,
		remaining: 100 - percent,
		limit: 100,
		unit: "percent",
		windowMinutes,
		...(resetsAt !== undefined ? { resetsAt } : {}),
	});
}

function addCountBucket(
	buckets: UsageBucket[],
	limit: Record<string, unknown>,
	id: string,
	label: string,
	windowMinutes?: number,
): void {
	const used = asNonnegativeNumber(limit.currentValue);
	const quota = asNonnegativeNumber(limit.usage);
	if (used === undefined || quota === undefined) return;
	const resetsAt = asEpochSeconds(limit.nextResetTime);
	buckets.push({
		id,
		label,
		used,
		remaining: Math.max(0, quota - used),
		limit: quota,
		unit: "count",
		...(windowMinutes !== undefined ? { windowMinutes } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	});
}

function addUsageDetailMetrics(metrics: UsageMetric[], value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const raw of value) {
		const detail = asObject(raw);
		if (!detail) continue;
		const label = asString(detail.modelCode);
		const usage = asNonnegativeNumber(detail.usage);
		if (!label || usage === undefined) continue;
		metrics.push({ id: `mcp-${kebabCase(label)}`, label, value: usage, unit: "count" });
	}
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeDisplayText(value, 80) || undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

function asEpochSeconds(value: unknown): number | undefined {
	const millis = asNonnegativeNumber(value);
	if (millis === undefined) return undefined;
	return Math.floor(millis / 1000);
}

function kebabCase(label: string): string {
	return (
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "tool"
	);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
