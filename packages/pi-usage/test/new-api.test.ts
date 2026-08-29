import assert from "node:assert/strict";
import { test } from "node:test";
import { vi } from "./vi.ts";
import { createMockContext } from "./support.ts";
import {
	formatUsageReport,
	formatUsageStatusline,
	normalizeNewApiUsage,
	type ResolvedUsageAuth,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
} from "../src/index.ts";
import type { UsageProviderAdapter } from "../src/index.ts";

const USER_PAYLOAD = {
	success: true,
	message: "",
	data: {
		username: "alice",
		display_name: "Alice",
		quota: 1_612_600,
		used_quota: 3_387_400,
		request_count: 1_234,
	},
};
// 1,612,600 / 500,000 = $3.2252 left; 3,387,400 / 500,000 = $6.7748 used;
// total $10.00 → 32% left.
const DATE_ROWS = [
	{ model_name: "gpt-4o", count: 100, quota: 500_000, token_used: 100_000, created_at: 1_700_000_000 },
	{ model_name: "gpt-4o", count: 50, quota: 250_000, token_used: 50_000, created_at: 1_700_003_600 },
	{ model_name: "claude-3.7-sonnet", count: 300, quota: 100_000, token_used: 200_000, created_at: 1_700_000_000 },
	{ model_name: "free-model", count: 999, quota: 0, token_used: 0, created_at: 1_700_000_000 },
];
const DATA_PAYLOAD = { success: true, message: "", data: DATE_ROWS };

const NEW_API_MODEL = {
	id: "gpt-4o",
	name: "GPT-4o",
	provider: "new-api",
	baseUrl: "https://gateway.example.com/v1",
};

function newApiAuth(): ResolvedUsageAuth {
	return {
		apiKey: "sys-access-token-0123456789abcdef",
		headers: { Authorization: "Bearer sys-access-token-0123456789abcdef" },
		fingerprint: "fingerprint",
		secrets: ["sys-access-token-0123456789abcdef"],
		model: NEW_API_MODEL as never,
	};
}

function newApiAdapter(): UsageProviderAdapter {
	const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "new-api");
	if (!adapter) throw new Error("missing new-api adapter");
	return adapter;
}

test("new-api adapter normalizes account quota with USD conversion and 30-day model rows", () => {
	const report = normalizeNewApiUsage(
		{ success: true, message: "", data: USER_PAYLOAD.data },
		DATA_PAYLOAD,
		1_000,
	);

	assert.equal(report.providerId, "new-api");
	assert.equal(report.accountLabel, "Alice");
	assert.deepEqual(report.semantics, {
		kind: "api-key",
		label: "New API gateway account quota",
	});
	assert.equal(report.source, "new-api-self");
	assert.deepEqual(report.buckets[0], {
		id: "account-quota",
		label: "Account quota",
		used: 6.7748,
		remaining: 3.2252,
		limit: 10,
		unit: "usd",
	});
	assert.deepEqual(
		report.metrics.map((metric) => [metric.id, metric.value]),
		[
			["requests", 1_234],
			["lifetime-used", 6.7748],
			["thirty-day-used", 1.7],
			["thirty-day-requests", 1_449],
			["thirty-day-tokens", 350_000],
			["model:0", 1.5],
			["model:1", 0.2],
		],
	);
	assert.deepEqual(
		report.metrics.slice(5).map((metric) => [metric.label, metric.value]),
		[
			["gpt-4o", 1.5],
			["claude-3.7-sonnet", 0.2],
		],
	);
	assert.equal(report.notes, undefined);

	const text = formatUsageReport(report, "current");
	assert.match(text, /New API Usage · Current/);
	assert.match(text, /Account: Alice/);
	assert.match(text, /Account quota:\s+\$3\.23 left of \$10\.00 \(32%\)/);
	assert.match(text, /Requests:\s+1234/);
	assert.match(text, /Last 30 days usage:\s+\$1\.70/);
	assert.match(text, /Last 30 days by model:/);
	assert.match(text, /gpt-4o:\s+\$1\.50/);
	assert.equal(formatUsageStatusline(report), undefined);
});

test("new-api adapter ranks models by spend, bounds the list, and sanitizes labels", () => {
	const rows = Array.from({ length: 12 }, (_value, index) => ({
		model_name: `model-${index}\u001b[31m\nname`,
		count: 1,
		quota: 500_000 * (index + 1),
		token_used: 1,
	}));
	const report = normalizeNewApiUsage(
		{ success: true, message: "", data: USER_PAYLOAD.data },
		{ success: true, message: "", data: rows },
		2_000,
	);

	const modelMetrics = report.metrics.filter((metric) => metric.id.startsWith("model:"));
	assert.equal(modelMetrics.length, 8);
	assert.equal(modelMetrics[0]?.label, "model-11 name");
	assert.equal(modelMetrics[0]?.value, 12);
	assert.equal(modelMetrics.at(-1)?.label, "model-4 name");
});

test("new-api adapter keeps account quota when the 30-day window is empty", () => {
	const report = normalizeNewApiUsage(
		{ success: true, message: "", data: USER_PAYLOAD.data },
		{ success: true, message: "", data: [] },
		3_000,
	);

	assert.deepEqual(
		report.metrics.map((metric) => metric.id),
		["requests", "lifetime-used"],
	);
	assert.match(report.notes?.[0] ?? "", /No per-model usage data/);
	assert.equal(formatUsageStatusline(report), undefined);
});

test("new-api adapter rejects failed endpoints, missing data, and hostile values", () => {
	assert.throws(
		() =>
			normalizeNewApiUsage(
				{ success: false, message: "需要登录" },
				{ success: true, message: "", data: [] },
				0,
			),
		/rejected the request: 需要登录/,
	);
	assert.throws(
		() =>
			normalizeNewApiUsage(
				{ success: true, message: "", data: {} },
				{ success: true, message: "", data: [] },
				0,
			),
		/no displayable quota data/,
	);
	assert.throws(
		() =>
			normalizeNewApiUsage(
				{ success: true, message: "", data: { used_quota: -5 } },
				{ success: true, message: "", data: [] },
				0,
			),
		/no displayable quota data/,
	);
	assert.throws(
		() => normalizeNewApiUsage({ success: true }, { success: true, message: "", data: [] }, 0),
		/account response data was not an object/,
	);

	const hostile = normalizeNewApiUsage(
		{ success: true, message: "", data: { display_name: "a\u001b[31m\nb", quota: 500_000 } },
		{ success: true, message: "", data: [] },
		0,
	);
	assert.equal(hostile.accountLabel, "a b");
	assert.equal(hostile.buckets[0]?.remaining, 1);
});

test("new-api usage authenticates with the system access token on https origins", async () => {
	const { ctx } = createMockContext({
		model: NEW_API_MODEL,
	});
	const auth = await resolveUsageAuth(ctx, newApiAdapter(), undefined, undefined, undefined, {
		newApiSystemToken: "sys-access-token-0123456789abcdef",
		newApiUserId: 42,
	});
	assert.ok(auth);
	assert.deepEqual(auth.headers, {
		Authorization: "Bearer sys-access-token-0123456789abcdef",
		"New-Api-User": "42",
	});
	assert.equal(auth.apiKey, "sys-access-token-0123456789abcdef");
	assert.deepEqual(auth.secrets, [
		"sys-access-token-0123456789abcdef",
		"Bearer sys-access-token-0123456789abcdef",
	]);
	assert.equal(auth.model.baseUrl, "https://gateway.example.com/v1");
});

test("new-api usage omits New-Api-User until the user id is configured", async () => {
	const { ctx } = createMockContext({ model: NEW_API_MODEL });
	const auth = await resolveUsageAuth(ctx, newApiAdapter(), undefined, undefined, undefined, {
		newApiSystemToken: "sys-access-token-0123456789abcdef",
	});
	assert.ok(auth);
	assert.deepEqual(auth.headers, {
		Authorization: "Bearer sys-access-token-0123456789abcdef",
	});
});

test("new-api usage requires the system access token and never reuses the inference key", async () => {
	const { ctx } = createMockContext({
		model: NEW_API_MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-inference-key" }),
			getProviderAuth: async () => ({
				auth: { apiKey: "sk-inference-key", baseUrl: "https://gateway.example.com/v1" },
			}),
			getAvailable: () => [NEW_API_MODEL],
			getAll: () => [NEW_API_MODEL],
		},
	});
	await assert.rejects(
		() => resolveUsageAuth(ctx, newApiAdapter()),
		/system access token/iu,
	);
	const auth = await resolveUsageAuth(ctx, newApiAdapter(), undefined, undefined, undefined, {
		newApiSystemToken: "sys-access-token-0123456789abcdef",
	});
	assert.ok(auth);
	assert.deepEqual(auth.headers, {
		Authorization: "Bearer sys-access-token-0123456789abcdef",
	});
	assert.doesNotMatch(auth.headers.Authorization ?? "", /sk-inference-key/);
});

test("new-api usage accepts http origins and trims the configured token", async () => {
	const httpModel = { ...NEW_API_MODEL, baseUrl: "http://192.168.1.5:3000/v1" };
	const { ctx } = createMockContext({ model: httpModel });
	const auth = await resolveUsageAuth(ctx, newApiAdapter(), undefined, undefined, undefined, {
		newApiSystemToken: "  sys-access-token-abcdef0123456789  ",
	});
	assert.ok(auth);
	assert.equal(auth.model.baseUrl, "http://192.168.1.5:3000/v1");
	assert.equal(auth.headers.Authorization, "Bearer sys-access-token-abcdef0123456789");
});

test("new-api usage falls back to the provider-level base URL for inherited models", async () => {
	const inheritedModel = { id: "gpt-4o", name: "GPT-4o", provider: "new-api" };
	const { ctx } = createMockContext({
		model: inheritedModel,
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: "sk-inference-key", baseUrl: "https://gateway.example.com/v1" },
			}),
			getAvailable: () => [inheritedModel],
			getAll: () => [inheritedModel],
		},
	});
	const auth = await resolveUsageAuth(ctx, newApiAdapter(), undefined, undefined, undefined, {
		newApiSystemToken: "sys-access-token-0123456789abcdef",
	});
	assert.ok(auth);
	assert.equal(auth.model.baseUrl, "https://gateway.example.com/v1");
});

test("new-api usage fails closed without any http(s) base URL", async () => {
	const brokenModel = { id: "gpt-4o", name: "GPT-4o", provider: "new-api" };
	for (const baseUrl of [undefined, "file:///tmp/gateway"]) {
		const { ctx } = createMockContext({ model: { ...brokenModel, baseUrl } });
		const auth = await resolveUsageAuth(ctx, newApiAdapter(), undefined, undefined, undefined, {
			newApiSystemToken: "sys-access-token-0123456789abcdef",
		});
		assert.equal(auth, undefined);
	}
});

test("new-api transport queries only the resolved gateway origin and honors redirects", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		if (String(input).includes("/api/user/self")) {
			return new Response(JSON.stringify(USER_PAYLOAD), { status: 200 });
		}
		return new Response(JSON.stringify(DATA_PAYLOAD), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const adapter = newApiAdapter();
		const auth = { ...newApiAuth(), headers: { ...newApiAuth().headers, "New-Api-User": "42" } };
		const report = await adapter.query(auth, new AbortController().signal, 1_000);
		assert.equal(report.providerId, "new-api");
		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.url, "https://gateway.example.com/api/user/self");
		assert.match(
			requests[1]?.url ?? "",
			/^https:\/\/gateway\.example\.com\/api\/data\/self\?start_timestamp=\d+&end_timestamp=\d+$/u,
		);
		const window = windowSeconds(requests[1]?.url ?? "");
		assert.equal(window, 30 * 86_400);
		assert.ok(
			Math.abs(
				(requests[1]?.url.match(/end_timestamp=(\d+)/u)?.[1] ?? 0) as number -
					Math.floor(Date.now() / 1000),
			) < 10,
		);
		for (const request of requests) {
			assert.deepEqual(request.init?.headers, {
				Authorization: "Bearer sys-access-token-0123456789abcdef",
				"New-Api-User": "42",
				"User-Agent": "pi-usage",
			});
			assert.equal(request.init?.redirect, "error");
		}

		const redirected = new Response("{}", { status: 200 });
		Object.defineProperty(redirected, "redirected", { value: true });
		fetchMock.mockResolvedValueOnce(redirected);
		await assert.rejects(
			() => adapter.query(newApiAuth(), new AbortController().signal, 1_000),
			/refused a redirected response/iu,
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("new-api transport rejects endpoint failures and redacts the gateway token", async () => {
	const fetchMock = vi.fn(async () =>
		new Response(
			JSON.stringify({ success: false, message: "invalid sys-access-token-0123456789abcdef" }),
			{ status: 401, statusText: "Unauthorized" },
		),
	);
	vi.stubGlobal("fetch", fetchMock);
	try {
		const adapter = newApiAdapter();
		await assert.rejects(
			() => adapter.query(newApiAuth(), new AbortController().signal, 1_000),
			(error: unknown) => {
				if (!(error instanceof Error)) return false;
				return (
					/returned 401/u.test(error.message) &&
					!error.message.includes("sys-access-token-0123456789abcdef")
				);
			},
		);
		fetchMock.mockImplementation(async () =>
			new Response(JSON.stringify({ success: false, message: "no such data" }), {
				status: 200,
			}),
		);
		await assert.rejects(
			() => adapter.query(newApiAuth(), new AbortController().signal, 1_000),
			/rejected the request: no such data/,
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("new-api transport enforces the 1 MiB statistics body bound", async () => {
	const payload = JSON.stringify({
		success: true,
		message: "",
		data: Array.from({ length: 15_000 }, (_value, index) => ({
			model_name: `model-${index}`,
			count: 1,
			quota: 1,
			token_used: 1,
			created_at: 1_700_000_000,
		})),
	});
	assert.ok(payload.length > 1024 * 1024);
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		if (String(input).includes("/api/user/self")) {
			return new Response(JSON.stringify(USER_PAYLOAD), { status: 200 });
		}
		return new Response(payload, { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const adapter = newApiAdapter();
		await assert.rejects(
			() => adapter.query(newApiAuth(), new AbortController().signal, 5_000),
			/exceeded 1048576 bytes/,
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("new-api transport guides configuration when the gateway demands New-Api-User", async () => {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					success: false,
					message: "Unauthorized, New-Api-User header not provided",
				}),
				{ status: 401, statusText: "Unauthorized" },
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	try {
		const adapter = newApiAdapter();
		await assert.rejects(
			() => adapter.query(newApiAuth(), new AbortController().signal, 1_000),
			/New-Api-User header not provided.*newApiUserId/,
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

function windowSeconds(url: string): number {
	const start = Number(/\?start_timestamp=(\d+)/u.exec(url)?.[1]);
	const end = Number(/&end_timestamp=(\d+)/u.exec(url)?.[1]);
	return end - start;
}