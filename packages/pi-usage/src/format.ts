import type {
	ProviderUsageState,
	UsageBucket,
	UsageDisplayState,
	UsageModel,
	UsageReport,
} from "./types.ts";

const BAR_SEGMENTS = 20;
const VALUE_COLUMN = 29;

export function formatUsageReport(report: UsageReport, displayState: UsageDisplayState): string {
	const stateLabel = displayState === "current" ? "Current" : "Configured";
	const lines = [`${report.providerName} Usage · ${stateLabel}`];
	if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
	lines.push(`Semantics: ${report.semantics.label}`, "");

	if (report.providerId === "openai-codex") formatCodexReport(lines, report);
	else if (report.providerId === "github-copilot") formatGitHubCopilotReport(lines, report);
	else if (report.providerId === "openrouter") formatOpenRouterReport(lines, report);
	else if (report.providerId === "opencode-go") formatOpenCodeZenReport(lines, report);
	else if (report.providerId === "kimi-coding") formatKimiCodingReport(lines, report);
	else if (report.providerId === "xai") formatXaiReport(lines, report);
	else if (report.providerId === "new-api") formatNewApiReport(lines, report);
	else if (report.providerId === "zai" || report.providerId === "zai-coding-cn") {
		formatZaiReport(lines, report);
	} else formatGenericReport(lines, report);

	if (report.notes) {
		for (const note of report.notes) lines.push(note);
	}
	return lines.join("\n").trimEnd();
}

export function formatUsageStatusline(report: UsageReport, model?: UsageModel): string | undefined {
	if (report.providerId === "openai-codex") return formatCodexStatusline(report, model);
	if (report.providerId === "github-copilot") return formatGitHubCopilotStatusline(report);
	if (report.providerId === "openrouter") {
		const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
		if (limit?.remaining !== undefined) return `openrouter ${formatUsd(limit.remaining)} left`;
		const total = report.metrics.find((metric) => metric.id === "usage-total");
		if (typeof total?.value === "number") return `openrouter ${formatUsd(total.value)} used`;
	}
	if (report.providerId === "opencode-go") return formatOpenCodeZenStatusline(report);
	if (report.providerId === "kimi-coding") return formatKimiCodingStatusline(report);
	if (report.providerId === "zai" || report.providerId === "zai-coding-cn") {
		return formatZaiStatusline(report);
	}
	return undefined;
}

export function formatProviderStates(states: readonly ProviderUsageState[]): string {
	return states
		.map((state) => {
			if (state.status === "ready") return formatUsageReport(state.report, state.displayState);
			const label = state.displayState === "current" ? "Current" : "Configured";
			const status =
				state.status === "auth-unavailable"
					? "Authentication unavailable"
					: state.status === "unsupported"
						? "Unsupported"
						: "Query failed";
			return `${state.providerName} · ${label}\n${status}: ${state.message}`;
		})
		.join("\n\n");
}

function formatCodexReport(lines: string[], report: UsageReport): void {
	let previousGroup: string | undefined;
	for (const bucket of report.buckets) {
		const group = bucket.groupId ?? bucket.id;
		if (group !== previousGroup && group !== "codex") {
			lines.push(`${bucket.groupLabel ?? group} limit:`);
		}
		previousGroup = group;
		const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
		const label = `${formatWindowLabel(bucket.windowMinutes, fallback, false)} limit:`;
		lines.push(`${label.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
	}
	for (const metric of report.metrics) {
		if (metric.id === "reset-credits") {
			lines.push(`${"Usage limit resets:".padEnd(VALUE_COLUMN)}${metric.value} available`);
		} else if (metric.id === "credits") {
			lines.push(
				`${"Credits:".padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
			);
		}
	}
}

function formatGitHubCopilotReport(lines: string[], report: UsageReport): void {
	const quota = findGitHubCopilotQuota(report);
	if (!quota || quota.limit === undefined || quota.remaining === undefined) {
		lines.push(`${`${quota?.label ?? "Copilot quota"}:`.padEnd(VALUE_COLUMN)}unlimited`);
		return;
	}
	const percent = percentRemaining(quota);
	const reset = quota.resetsAt ? ` (resets ${formatReset(quota.resetsAt)})` : "";
	lines.push(
		`${`${quota.label}:`.padEnd(VALUE_COLUMN)}${quota.remaining} of ${quota.limit} left · ${percent}%${reset}`,
	);
	const overage = report.metrics.find((metric) => metric.id === "overage-used");
	if (typeof overage?.value === "number" && overage.value > 0) {
		lines.push(`${"Additional usage:".padEnd(VALUE_COLUMN)}${overage.value} ${quota.label}`);
	}
}

function formatGitHubCopilotStatusline(report: UsageReport): string {
	const quota = findGitHubCopilotQuota(report);
	const kind = compactGitHubCopilotQuotaKind(quota);
	if (!quota || quota.limit === undefined || quota.remaining === undefined) {
		return `copilot ${kind} unlimited`;
	}
	const overage = report.metrics.find((metric) => metric.id === "overage-used");
	const overageSuffix =
		typeof overage?.value === "number" && overage.value > 0 ? ` +${overage.value} over` : "";
	return `copilot ${kind === "premium" ? "" : `${kind} `}${quota.remaining}/${quota.limit} ${percentRemaining(quota)}%${overageSuffix}`;
}

function findGitHubCopilotQuota(report: UsageReport): UsageBucket | undefined {
	return report.buckets.find((bucket) =>
		["ai-credits", "premium-requests", "chat-requests"].includes(bucket.id),
	);
}

function compactGitHubCopilotQuotaKind(bucket: UsageBucket | undefined): string {
	if (bucket?.id === "ai-credits") return "credits";
	if (bucket?.id === "chat-requests") return "chat";
	return "premium";
}

function percentRemaining(bucket: UsageBucket): number {
	if (!bucket.limit || bucket.remaining === undefined) return 0;
	return Math.round(clampPercent((bucket.remaining / bucket.limit) * 100));
}

function formatOpenRouterReport(lines: string[], report: UsageReport): void {
	const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
	if (limit) {
		const period = limit.period ? ` (${limit.period})` : "";
		const value =
			limit.remaining === undefined
				? `${formatUsd(limit.limit ?? 0)} cap; remaining unavailable`
				: `${formatUsd(limit.remaining)} of ${formatUsd(limit.limit ?? 0)} left`;
		lines.push(`${`Key limit${period}:`.padEnd(VALUE_COLUMN)}${value}`);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatOpenCodeZenReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
		const used = bucket.used ?? "unavailable";
		lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${used}% used${reset}`);
	}
}

function formatOpenCodeZenStatusline(report: UsageReport): string | undefined {
	const parts = ["zen"];
	for (const bucket of report.buckets) {
		if (bucket.used === undefined) continue;
		const compact = bucket.id === "rolling" ? "r" : bucket.id === "weekly" ? "w" : "m";
		parts.push(`${clampPercent(bucket.used).toFixed(0)}% ${compact}`);
	}
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function formatKimiCodingReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
		if (bucket.used === undefined || bucket.limit === undefined) {
			lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}unavailable${reset}`);
			continue;
		}
		lines.push(
			`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${bucket.used} of ${bucket.limit} used · ${percentRemaining(bucket)}% left${reset}`,
		);
	}
	const balance = report.metrics.find((metric) => metric.id === "booster-balance");
	const total = report.metrics.find((metric) => metric.id === "booster-total");
	const monthlyUsed = report.metrics.find((metric) => metric.id === "booster-monthly-used");
	const monthlyLimit = report.metrics.find((metric) => metric.id === "booster-monthly-limit");
	if (!balance && !monthlyUsed && !monthlyLimit) return;
	lines.push("", "Extra usage wallet:");
	if (balance) {
		const totalSuffix = total ? ` of ${formatCurrencyMetric(total)}` : "";
		lines.push(`${"Balance:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(balance)}${totalSuffix}`);
	}
	if (monthlyUsed) {
		lines.push(`${"Used this month:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(monthlyUsed)}`);
	}
	if (monthlyLimit) {
		lines.push(`${"Monthly limit:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(monthlyLimit)}`);
	}
}

function formatKimiCodingStatusline(report: UsageReport): string | undefined {
	const fiveHour = report.buckets.find((bucket) => bucket.id === "five-hour");
	const weekly = report.buckets.find((bucket) => bucket.id === "weekly");
	const subWindow = fiveHour ?? report.buckets.find((bucket) => bucket.id !== "weekly");
	const selected = [subWindow, weekly].filter(
		(bucket, index, buckets): bucket is UsageBucket =>
			bucket !== undefined && buckets.indexOf(bucket) === index,
	);
	const parts = ["kimi"];
	for (const bucket of selected) {
		if (!bucket.limit || bucket.remaining === undefined) continue;
		const fallback = bucket.id === "weekly" ? "weekly" : "5h";
		parts.push(
			`${percentRemaining(bucket)}% ${formatWindowLabel(bucket.windowMinutes, fallback, true)}`,
		);
	}
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function formatZaiStatusline(report: UsageReport): string | undefined {
	const selected = [
		report.buckets.find((bucket) => bucket.id === "five-hour"),
		report.buckets.find((bucket) => bucket.id === "weekly"),
	];
	const parts = ["zai"];
	for (const bucket of selected) {
		if (!bucket?.limit || bucket.remaining === undefined) continue;
		const fallback = bucket.id === "weekly" ? "weekly" : "5h";
		parts.push(
			`${percentRemaining(bucket)}% ${formatWindowLabel(bucket.windowMinutes, fallback, true)}`,
		);
	}
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function formatNewApiReport(lines: string[], report: UsageReport): void {
	const quota = report.buckets.find((bucket) => bucket.id === "account-quota");
	if (quota) {
		let value = "unavailable";
		if (quota.remaining !== undefined && quota.limit !== undefined) {
			const percent = Math.round(clampPercent((quota.remaining / quota.limit) * 100));
			value = `${formatUsd(quota.remaining)} left of ${formatUsd(quota.limit)} (${percent}%)`;
		} else if (quota.remaining !== undefined) {
			value = `${formatUsd(quota.remaining)} left`;
		} else if (quota.used !== undefined) {
			value = `${formatUsd(quota.used)} used`;
		}
		lines.push(`${`${quota.label}:`.padEnd(VALUE_COLUMN)}${value}`);
	}
	const modelMetrics = report.metrics.filter((metric) => metric.id.startsWith("model:"));
	for (const metric of report.metrics) {
		if (modelMetrics.includes(metric)) continue;
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
	if (modelMetrics.length > 0) {
		lines.push("", "Last 30 days by model:");
		for (const metric of modelMetrics) {
			lines.push(
				`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
			);
		}
	}
}

function formatCurrencyMetric(metric: UsageReport["metrics"][number]): string {
	if (typeof metric.value !== "number") return String(metric.value);
	if (!metric.currency) return "unavailable";
	if (metric.currency === "USD") return `$${metric.value.toFixed(2)}`;
	if (metric.currency === "CNY") return `¥${metric.value.toFixed(2)}`;
	return `${metric.value.toFixed(2)} ${metric.currency}`;
}

function formatXaiReport(lines: string[], report: UsageReport): void {
	const included = report.buckets.find((bucket) => bucket.id === "included-allowance");
	if (included) {
		let value = "unavailable";
		if (included.unit === "percent" && included.used !== undefined) {
			value = `${included.used}% used`;
			if (included.remaining !== undefined) value += ` · ${included.remaining}% left`;
		} else if (included.used !== undefined) {
			value = `${formatUsd(included.used)} used`;
			if (included.limit !== undefined) value += ` of ${formatUsd(included.limit)}`;
		} else if (included.limit !== undefined) {
			value = `usage unavailable · ${formatUsd(included.limit)} limit`;
		}
		const period = included.period ? ` · ${included.period}` : "";
		const reset = included.resetsAt ? ` (resets ${formatReset(included.resetsAt)})` : "";
		lines.push(`${"Included allowance:".padEnd(VALUE_COLUMN)}${value}${period}${reset}`);
	}
	const onDemand = report.buckets.find((bucket) => bucket.id === "on-demand");
	if (onDemand) {
		let value =
			onDemand.used === undefined ? "usage unavailable" : `${formatUsd(onDemand.used)} used`;
		if (onDemand.limit !== undefined) value += ` of ${formatUsd(onDemand.limit)} cap`;
		lines.push(`${"On-demand usage:".padEnd(VALUE_COLUMN)}${value}`);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatZaiReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
		let value = "unavailable";
		if (bucket.unit === "percent" && bucket.used !== undefined) {
			value = `${bucket.used}% used`;
			if (bucket.remaining !== undefined) value += ` · ${bucket.remaining}% left`;
		} else if (bucket.used !== undefined && bucket.limit !== undefined) {
			value = `${bucket.used} of ${bucket.limit} used`;
			if (bucket.remaining !== undefined) value += ` · ${bucket.remaining} left`;
		} else if (bucket.used !== undefined) {
			value = `${bucket.used} used`;
		} else if (bucket.remaining !== undefined) {
			value = `${bucket.remaining} left`;
		}
		lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}${reset}`);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatGenericReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		lines.push(
			`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(bucket.remaining ?? bucket.used ?? "unavailable", bucket.unit)}`,
		);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatCodexStatusline(report: UsageReport, model?: UsageModel): string | undefined {
	const group = selectCodexGroup(report, model);
	if (!group) return formatCodexCreditsStatus(report);
	const buckets = report.buckets.filter((bucket) => (bucket.groupId ?? bucket.id) === group);
	const labelBucket = buckets[0];
	const parts = [
		group === "codex" ? "codex" : `codex ${compactLimitLabel(labelBucket?.groupLabel ?? group)}`,
	];
	for (const bucket of buckets) {
		if (bucket.remaining === undefined) continue;
		const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
		parts.push(
			`${clampPercent(bucket.remaining).toFixed(0)}% ${formatWindowLabel(bucket.windowMinutes, fallback, true)}`,
		);
	}
	return parts.length > 1 ? parts.join(" ") : formatCodexCreditsStatus(report);
}

function formatCodexCreditsStatus(report: UsageReport): string {
	const credits = report.metrics.find((metric) => metric.id === "credits");
	if (!credits) return "codex usage unavailable";
	if (credits.value === "none") return "codex no credits";
	if (credits.value === "available") return "codex credits available";
	if (credits.value === "unlimited") return "codex credits unlimited";
	return `codex ${formatMetricValue(credits.value, "count")} credits`;
}

function selectCodexGroup(report: UsageReport, model?: UsageModel): string | undefined {
	const groups = [...new Set(report.buckets.map((bucket) => bucket.groupId ?? bucket.id))];
	if (model?.provider !== "openai-codex") {
		return groups.includes("codex") ? "codex" : groups[0];
	}
	const modelKeys = normalizedModelKeys(model);
	for (const group of groups) {
		const bucket = report.buckets.find(
			(candidate) => (candidate.groupId ?? candidate.id) === group,
		);
		const keys = [group, bucket?.groupLabel, ...(bucket?.modelKeys ?? [])]
			.map(normalizeKey)
			.filter((key): key is string => key !== undefined);
		if (keys.some((key) => modelKeys.has(key))) return group;
	}
	const variants = [...modelKeys]
		.map((key) => key.match(/(?:^|-)codex-(.+)$/)?.[1])
		.filter((value): value is string => Boolean(value));
	for (const variant of variants) {
		const matches = groups.filter((group) => {
			if (group === "codex") return false;
			const key = normalizeKey(group);
			return key ? normalizedKeyHasToken(key, variant) : false;
		});
		if (matches.length === 1) return matches[0];
	}
	return groups.includes("codex") ? "codex" : groups[0];
}

function normalizedModelKeys(model: UsageModel): Set<string> {
	const keys = new Set<string>();
	for (const value of [model.id, model.name]) {
		const key = normalizeKey(value);
		if (!key) continue;
		keys.add(key);
		const index = key.indexOf("codex");
		if (index >= 0) keys.add(key.slice(index));
	}
	return keys;
}

function normalizeKey(value: string | undefined): string | undefined {
	const separated = value?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	if (!separated) return undefined;
	let start = 0;
	let end = separated.length;
	while (separated[start] === "-") start += 1;
	while (end > start && separated[end - 1] === "-") end -= 1;
	return separated.slice(start, end) || undefined;
}

function normalizedKeyHasToken(key: string, token: string): boolean {
	return (
		key === token ||
		key.startsWith(`${token}-`) ||
		key.endsWith(`-${token}`) ||
		key.includes(`-${token}-`)
	);
}

function compactLimitLabel(label: string): string {
	const normalized = label.replace(/[_-]+/g, " ").trim();
	const codex = /\bcodex\s/iu.exec(normalized);
	const suffix = codex ? normalized.slice(codex.index + codex[0].length).trim() : "";
	return (suffix || normalized).toLowerCase().replace(/\s+/g, " ");
}

function formatPercentBucket(bucket: UsageBucket): string {
	const remaining = clampPercent(bucket.remaining ?? 0);
	const filled = Math.round((remaining / 100) * BAR_SEGMENTS);
	const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}] ${remaining.toFixed(0)}% left${reset}`;
}

function formatWindowLabel(
	minutes: number | undefined,
	fallback: "5h" | "weekly",
	compact: boolean,
): string {
	if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
		return compact && fallback === "weekly" ? "wk" : capitalize(fallback);
	}
	if (minutes === 10_080) return compact ? "wk" : "Weekly";
	if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function formatMetricValue(value: number | string, unit: UsageBucket["unit"] | undefined): string {
	if (unit === "usd" && typeof value === "number") return formatUsd(value);
	return String(value);
}

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

function formatReset(epochSeconds: number): string {
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "at an unknown time";
	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	const now = new Date();
	if (reset.toDateString() === now.toDateString()) return time;
	return `${time} on ${reset.getDate()} ${reset.toLocaleDateString(undefined, { month: "short" })}`;
}

function capitalize(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
