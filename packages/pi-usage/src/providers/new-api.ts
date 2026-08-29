import { sanitizeDisplayText } from "../core.ts";
import type {
	NewApiDataPayload,
	NewApiDataRow,
	NewApiUserPayload,
	UsageBucket,
	UsageMetric,
	UsageReport,
} from "../types.ts";

// New API (https://github.com/Calcium-Ion/new-api) reports gateway quota in
// fixed-point units defined by its common.QuotaPerUnit constant
// (var QuotaPerUnit = 500 * 1000.0 // $0.002 / 1K tokens). Stock deployments
// keep 500,000 units per USD; distributions that recompile with another value
// display proportionally shifted dollar figures.
const QUOTA_UNITS_PER_USD = 500_000;
const MAX_MODEL_METRICS = 8;

export function normalizeNewApiUsage(
	userPayload: NewApiUserPayload,
	dataPayload: NewApiDataPayload,
	capturedAt: number,
): UsageReport {
	assertEndpointSuccess(userPayload, "New API account endpoint");
	assertEndpointSuccess(dataPayload, "New API statistics endpoint");

	const userData = asObject(userPayload.data);
	if (!userData) throw new Error("New API account response data was not an object.");

	const quota = asNonnegativeNumber(userData.quota);
	const usedQuota = asNonnegativeNumber(userData.used_quota);
	if (quota === undefined && usedQuota === undefined) {
		throw new Error("New API account response returned no displayable quota data.");
	}
	const requestCount = asNonnegativeNumber(userData.request_count);

	const accountLabel = sanitizeDisplayText(
		(asString(userData.display_name) ?? asString(userData.username)) ?? "",
		80,
	);

	const rows = Array.isArray(dataPayload.data) ? (dataPayload.data as unknown[]) : [];
	const aggregated = aggregateModelRows(rows);

	const buckets: UsageBucket[] = [];
	const limit = quota !== undefined && usedQuota !== undefined ? quota + usedQuota : undefined;
	const bucket: UsageBucket = {
		id: "account-quota",
		label: "Account quota",
		unit: "usd",
	};
	if (usedQuota !== undefined) bucket.used = usedQuota / QUOTA_UNITS_PER_USD;
	if (quota !== undefined) bucket.remaining = quota / QUOTA_UNITS_PER_USD;
	if (limit !== undefined) bucket.limit = limit / QUOTA_UNITS_PER_USD;
	buckets.push(bucket);

	const metrics: UsageMetric[] = [];
	if (requestCount !== undefined) {
		metrics.push({ id: "requests", label: "Requests", value: requestCount, unit: "count" });
	}
	if (usedQuota !== undefined) {
		metrics.push({
			id: "lifetime-used",
			label: "Lifetime usage",
			value: usedQuota / QUOTA_UNITS_PER_USD,
			unit: "usd",
		});
	}
	const window = aggregateWindow(rows);
	if (window.rows > 0) {
		metrics.push({
			id: "thirty-day-used",
			label: "Last 30 days usage",
			value: window.quota / QUOTA_UNITS_PER_USD,
			unit: "usd",
		});
		metrics.push({
			id: "thirty-day-requests",
			label: "Requests (30d)",
			value: window.count,
			unit: "count",
		});
		metrics.push({
			id: "thirty-day-tokens",
			label: "Tokens (30d)",
			value: window.tokenUsed,
			unit: "count",
		});
	}

	const notes: string[] = [];
	if (window.rows === 0) {
		notes.push(
			"No per-model usage data in the last 30 days; the gateway may keep the usage dashboard export disabled.",
		);
	} else {
		for (const [index, model] of aggregated.entries()) {
			metrics.push({
				id: `model:${index}`,
				label: model.label,
				value: model.quota / QUOTA_UNITS_PER_USD,
				unit: "usd",
			});
		}
	}

	return {
		providerId: "new-api",
		providerName: "New API",
		capturedAt,
		source: "new-api-self",
		semantics: { kind: "api-key", label: "New API gateway account quota" },
		...(accountLabel ? { accountLabel } : {}),
		buckets,
		metrics,
		...(notes.length > 0 ? { notes } : {}),
	};
}

function assertEndpointSuccess(payload: NewApiUserPayload | NewApiDataPayload, description: string): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error(`${description} response was not an object.`);
	}
	if (payload.success === false) {
		const message = sanitizeDisplayText(asString(payload.message) ?? "", 200);
		throw new Error(
			message ? `${description} rejected the request: ${message}` : `${description} rejected the request.`,
		);
	}
}

function aggregateModelRows(rows: readonly unknown[]): Array<{ label: string; quota: number }> {
	const totals = new Map<string, number>();
	for (const raw of rows) {
		const row = asObject(raw) as NewApiDataRow;
		if (!row) continue;
		const modelName = sanitizeDisplayText(asString(row.model_name) ?? "", 64);
		const quota = asNonnegativeNumber(row.quota);
		if (!modelName || quota === undefined || quota <= 0) continue;
		totals.set(modelName, (totals.get(modelName) ?? 0) + quota);
	}
	return [...totals.entries()]
		.map(([label, quota]) => ({ label, quota }))
		.sort((a, b) => b.quota - a.quota)
		.slice(0, MAX_MODEL_METRICS);
}

function aggregateWindow(rows: readonly unknown[]): {
	rows: number;
	count: number;
	quota: number;
	tokenUsed: number;
} {
	let count = 0;
	let quota = 0;
	let tokenUsed = 0;
	let validRows = 0;
	for (const raw of rows) {
		const row = asObject(raw) as NewApiDataRow;
		if (!row) continue;
		const rowCount = asNonnegativeNumber(row.count);
		const rowQuota = asNonnegativeNumber(row.quota);
		const rowTokens = asNonnegativeNumber(row.token_used);
		if (rowCount === undefined && rowQuota === undefined && rowTokens === undefined) continue;
		validRows += 1;
		count += rowCount ?? 0;
		quota += rowQuota ?? 0;
		tokenUsed += rowTokens ?? 0;
	}
	return { rows: validRows, count, quota, tokenUsed };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}