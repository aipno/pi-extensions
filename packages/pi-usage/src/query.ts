import { randomBytes } from "node:crypto";
import { type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { errorMessage, fingerprintResolvedAuth, redactUsageError } from "./core.ts";
import {
	fallbackOAuthCredentialCandidates,
	type OAuthCredentialCandidateReader,
} from "./oauth-credential-source.ts";
import { normalizeCodexBackendPayload } from "./providers/codex.ts";
import { normalizeGitHubCopilotUsagePayload } from "./providers/github-copilot.ts";
import { normalizeKimiCodingUsagePayload } from "./providers/kimi-coding.ts";
import { normalizeNewApiUsage } from "./providers/new-api.ts";
import { normalizeOpenCodeZenPayload } from "./providers/opencode-zen.ts";
import { normalizeOpenRouterKeyPayload } from "./providers/openrouter.ts";
import { normalizeXaiBillingPayload } from "./providers/xai.ts";
import { normalizeZaiQuotaPayload } from "./providers/zai.ts";
import type {
	CodexBackendPayload,
	GitHubCopilotUsagePayload,
	KimiCodingUsagePayload,
	NewApiDataPayload,
	NewApiUserPayload,
	OpenCodeZenPayload,
	OpenRouterKeyPayload,
	PiModel,
	ResolvedUsageAuth,
	UsageProviderAdapter,
	UsageReport,
	XaiBillingPayload,
	XaiUserPayload,
	ZaiQuotaPayload,
} from "./types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GITHUB_COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const KIMI_CODING_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const XAI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_CLIENT_HEADERS = Object.freeze({
	"X-XAI-Token-Auth": "xai-grok-cli",
	"x-grok-client-version": "1.0.10",
	"x-grok-client-mode": "interactive",
});
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
// /api/data/self returns one row per model per hour; busy self-hosted
// gateways can exceed the default success-body bound for a 30-day window.
const NEW_API_DATA_BODY_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
// new-api /api/data/self rejects spans longer than one month (30 days).
const NEW_API_WINDOW_SECONDS = 30 * 86_400;

export const AUTH_FINGERPRINT_SALT = randomBytes(32);

export type UsageRequestGuard = () => Promise<void>;

export const SUPPORTED_ADAPTERS: readonly UsageProviderAdapter[] = [
	{
		id: "openai-codex",
		displayName: "OpenAI Codex",
		semantics: {
			kind: "consumer-subscription",
			label: "ChatGPT subscription limits",
		},
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				CODEX_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"Codex usage endpoint",
			);
			return normalizeCodexBackendPayload(payload as CodexBackendPayload, Date.now());
		},
	},
	{
		id: "github-copilot",
		displayName: "GitHub Copilot",
		semantics: {
			kind: "consumer-subscription",
			label: "GitHub Copilot account allowance",
		},
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				GITHUB_COPILOT_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"GitHub Copilot usage endpoint",
			);
			return normalizeGitHubCopilotUsagePayload(payload as GitHubCopilotUsagePayload, Date.now());
		},
	},
	{
		id: "openrouter",
		displayName: "OpenRouter",
		semantics: { kind: "api-key", label: "API-key spend limits" },
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				OPENROUTER_KEY_URL,
				auth,
				signal,
				timeoutMs,
				"OpenRouter key endpoint",
			);
			return normalizeOpenRouterKeyPayload(payload as OpenRouterKeyPayload, Date.now());
		},
	},
	{
		id: "opencode-go",
		displayName: "OpenCode Go",
		semantics: { kind: "consumer-subscription", label: "OpenCode Zen plan usage" },
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				OPENCODE_GO_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"OpenCode Zen usage endpoint",
			);
			return normalizeOpenCodeZenPayload(payload as OpenCodeZenPayload, Date.now());
		},
	},
	{
		id: "kimi-coding",
		displayName: "Kimi For Coding",
		semantics: { kind: "consumer-subscription", label: "Kimi Coding Plan usage" },
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				KIMI_CODING_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"Kimi Coding usage endpoint",
				{ redirect: "error" },
			);
			return normalizeKimiCodingUsagePayload(payload as KimiCodingUsagePayload, Date.now());
		},
	},
	{
		id: "new-api",
		displayName: "New API",
		semantics: { kind: "api-key", label: "New API gateway account quota" },
		publishesStatusline: false,
		async query(auth, signal, timeoutMs) {
			const origin = newApiOrigin(auth.model.baseUrl);
			const startedAt = Date.now();
			let userPayload: NewApiUserPayload;
			try {
				userPayload = (await fetchProviderJson(
					`${origin}/api/user/self`,
					auth,
					signal,
					remainingTimeout(timeoutMs, startedAt),
					"New API account endpoint",
					{ redirect: "error" },
				)) as NewApiUserPayload;
			} catch (error) {
				throw translateNewApiAuthError(error);
			}
			const nowSeconds = Math.floor(Date.now() / 1000);
			try {
				const dataPayload = (await fetchProviderJson(
					`${origin}/api/data/self?start_timestamp=${nowSeconds - NEW_API_WINDOW_SECONDS}&end_timestamp=${nowSeconds}`,
					auth,
					signal,
					remainingTimeout(timeoutMs, startedAt),
					"New API statistics endpoint",
					{ redirect: "error", maxSuccessBytes: NEW_API_DATA_BODY_BYTES },
				)) as NewApiDataPayload;
				return normalizeNewApiUsage(userPayload, dataPayload, Date.now());
			} catch (error) {
				throw translateNewApiAuthError(error);
			}
		},
	},
	{
		id: "zai",
		displayName: "Z.AI",
		semantics: { kind: "consumer-subscription", label: "GLM Coding Plan usage" },
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				zaiMonitorUrl(auth.model.baseUrl),
				zaiMonitorAuth(auth),
				signal,
				timeoutMs,
				"Z.AI quota endpoint",
			);
			return normalizeZaiQuotaPayload("zai", "Z.AI", payload as ZaiQuotaPayload, Date.now());
		},
	},
	{
		id: "zai-coding-cn",
		displayName: "Z.AI Coding CN",
		semantics: { kind: "consumer-subscription", label: "GLM Coding Plan usage" },
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				zaiMonitorUrl(auth.model.baseUrl),
				zaiMonitorAuth(auth),
				signal,
				timeoutMs,
				"Z.AI Coding CN quota endpoint",
			);
			return normalizeZaiQuotaPayload(
				"zai-coding-cn",
				"Z.AI Coding CN",
				payload as ZaiQuotaPayload,
				Date.now(),
			);
		},
	},
];

// Reviewed contract pins:
// - Pi xAI provider at https://api.x.ai and OAuth scope
//   "openid profile email offline_access grok-cli:access api:access" at
//   e86823096c5bad39e1ca282ec24bc5eb9bec745b, unchanged at
//   ccfe79ed238674f760c986e3a61493aab794000a.
// - Grok Build identity, credits routes/structs, required token-auth and version headers, and
//   client-mode telemetry at 9684fa3cdbf2995e30ea8b9b637f1db008f144fc (client version 1.0.10).
// - xAI Management API's separate team billing boundary at
//   723dd2aa22d17be35617463837dc47cda008d90e.
// x-userid remains attached only to billing to bind the proxy-canonical identity as Grok Build does.
export const XAI_ADAPTER: UsageProviderAdapter = {
	id: "xai",
	displayName: "xAI",
	semantics: {
		kind: "consumer-subscription",
		label: "xAI consumer subscription usage",
	},
	publishesStatusline: false,
	async query(auth, signal, timeoutMs, guard) {
		if (!guard) throw new Error("xAI usage requires request-boundary revalidation.");
		const startedAt = Date.now();
		const clientAuth = {
			...auth,
			headers: { ...auth.headers, ...XAI_CLIENT_HEADERS },
		};
		await guard();
		const userPayload = (await fetchProviderJson(
			XAI_USER_URL,
			clientAuth,
			signal,
			remainingTimeout(timeoutMs, startedAt),
			"xAI consumer identity endpoint",
			{ redirect: "error", userAgent: false },
		)) as XaiUserPayload;
		await guard();
		const userId = validatedXaiUserId(userPayload.userId);
		const billingAuth = {
			...clientAuth,
			headers: { ...clientAuth.headers, "x-userid": userId },
			secrets: [...clientAuth.secrets, userId],
		};
		await guard();
		const billingPayload = (await fetchProviderJson(
			XAI_BILLING_URL,
			billingAuth,
			signal,
			remainingTimeout(timeoutMs, startedAt),
			"xAI consumer billing endpoint",
			{ redirect: "error", userAgent: false },
		)) as XaiBillingPayload;
		await guard();
		return normalizeXaiBillingPayload(billingPayload, userPayload.subscriptionTier, Date.now());
	},
};

export function usageAdapters(xaiUsage = true): readonly UsageProviderAdapter[] {
	return xaiUsage ? [...SUPPORTED_ADAPTERS, XAI_ADAPTER] : SUPPORTED_ADAPTERS;
}

export function adapterForProvider(
	providerId: string | undefined,
	xaiUsage = true,
): UsageProviderAdapter | undefined {
	return usageAdapters(xaiUsage).find((adapter) => adapter.id === providerId);
}

export function isStaleExtensionContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

export type ResolvedUsageAuthOptions = {
	/** new-api dashboard system access token (个人设置-安全设置-系统访问令牌). */
	newApiSystemToken?: string;
	/** new-api numeric user id (dashboard profile → User ID); sent as New-Api-User. */
	newApiUserId?: number;
};

export async function resolveUsageAuth(
	ctx: ExtensionContext,
	adapter: UsageProviderAdapter,
	salt: Uint8Array = AUTH_FINGERPRINT_SALT,
	credentialReader: StoredCredentialReader = readStoredCredential,
	candidateReader?: OAuthCredentialCandidateReader,
	options: ResolvedUsageAuthOptions = {},
): Promise<ResolvedUsageAuth | undefined> {
	if (ctx.model?.provider === adapter.id && !isNewApi(adapter.id) && !hasOfficialOrigin(ctx.model, adapter.id)) {
		throw new Error(
			`${adapter.displayName} usage cannot send a custom provider base URL credential to the official usage endpoint.`,
		);
	}

	const model = candidateModels(ctx, adapter.id).find((candidate) =>
		isNewApi(adapter.id)
			? candidate.baseUrl === undefined || hasOfficialUrlOrigin(candidate.baseUrl, adapter.id)
			: hasOfficialOrigin(candidate, adapter.id),
	);
	if (!model) return undefined;
	if (isNewApi(adapter.id)) {
		return resolveNewApiSystemAuth(
			ctx,
			adapter,
			model,
			salt,
			options.newApiSystemToken,
			options.newApiUserId,
		);
	}
	// SAFETY: Pi exposes the required auth methods at runtime, and checks below narrow them before use.
	const registry = ctx.modelRegistry as unknown as UsageAuthRegistry;
	let modelAuth: RequestAuth | undefined;
	if (ctx.model?.provider === adapter.id && typeof registry.getApiKeyAndHeaders === "function") {
		const result = await registry.getApiKeyAndHeaders(ctx.model);
		if (!result.ok) throw new Error(redactUsageError(result.error));
		if (authorizationFrom(result)) modelAuth = result;
	}
	if (typeof registry.getProviderAuth !== "function") {
		throw new Error("pi-usage requires Pi 0.81.0 or newer to validate resolved provider auth.");
	}
	const providerResult = await registry.getProviderAuth(adapter.id);
	if (
		providerResult?.auth.baseUrl &&
		!hasOfficialUrlOrigin(providerResult.auth.baseUrl, adapter.id)
	) {
		throw new Error(
			`${adapter.displayName} usage cannot send a proxy-resolved credential to the official usage endpoint.`,
		);
	}
	const auth = modelAuth ?? providerResult?.auth;
	if (!auth) return undefined;
	if (adapter.id === "github-copilot") {
		const offered = candidateReader
			? candidateReader(ctx, adapter.id)
			: fallbackOAuthCredentialCandidates(adapter.id, credentialReader);
		if (!offered.ok) {
			throw new Error("GitHub Copilot OAuth credential discovery failed closed.");
		}
		return resolveGitHubCopilotUsageAuth(
			auth,
			model,
			salt,
			offered.candidates,
			offered.offeredCount === 0,
		);
	}
	if (adapter.id === "xai") {
		const offered = candidateReader
			? candidateReader(ctx, adapter.id)
			: fallbackOAuthCredentialCandidates(adapter.id, credentialReader);
		if (!offered.ok) throw new Error("xAI OAuth credential discovery failed closed.");
		return resolveXaiUsageAuth(auth, model, salt, offered.candidates);
	}
	const authorization = authorizationFrom(auth);
	if (!authorization) return undefined;
	const headers = { Authorization: authorization };
	const secrets = [auth.apiKey, headerValue(auth.headers, "Authorization"), authorization].filter(
		(value): value is string => Boolean(value),
	);
	return {
		apiKey: auth.apiKey,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets,
		model,
	};
}

export async function queryProviderUsage(
	adapter: UsageProviderAdapter,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
	guard?: UsageRequestGuard,
): Promise<UsageReport> {
	try {
		return await adapter.query(auth, signal, timeoutMs, guard);
	} catch (error) {
		if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
		throw new Error(redactUsageError(errorMessage(error), auth.secrets));
	}
}

export function providerIsConfigured(ctx: ExtensionContext, providerId: string): boolean {
	try {
		return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
	} catch {
		return candidateModels(ctx, providerId).length > 0;
	}
}

function candidateModels(ctx: ExtensionContext, providerId: string): PiModel[] {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || model.provider !== providerId) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};
	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model);
	for (const model of ctx.modelRegistry.getAll()) add(model);
	return candidates;
}

export async function fetchProviderJson(
	url: string,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
	description: string,
	request: {
		method?: "GET" | "POST";
		body?: Record<string, unknown>;
		// Undici's RequestInit.redirect union, spelled out so this package
		// typechecks without a DOM lib.
		redirect?: "error" | "follow" | "manual";
		userAgent?: boolean;
		maxSuccessBytes?: number;
	} = {},
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const headers = { ...auth.headers };
		if (request.userAgent !== false && !hasHeader(headers, "User-Agent")) {
			headers["User-Agent"] = "pi-usage";
		}
		if (request.body && !hasHeader(headers, "Content-Type")) {
			headers["Content-Type"] = "application/json";
		}
		const response = await fetch(url, {
			method: request.method ?? "GET",
			headers,
			...(request.body ? { body: JSON.stringify(request.body) } : {}),
			...(request.redirect ? { redirect: request.redirect } : {}),
			signal: controller.signal,
		});
		if (response.redirected) throw new Error(`${description} refused a redirected response.`);
		if (controller.signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		const text = await readBoundedResponse(
			response,
			response.ok ? (request.maxSuccessBytes ?? MAX_SUCCESS_BODY_BYTES) : MAX_ERROR_BODY_BYTES,
			!response.ok,
			description,
			controller.signal,
		);
		if (controller.signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		if (!response.ok) {
			throw new Error(
				`${description} returned ${response.status} ${response.statusText}: ${redactUsageError(text, auth.secrets)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch (error) {
			throw new Error(`${description} returned invalid JSON: ${errorMessage(error)}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${description} response was not an object.`);
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (timedOut) {
			throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
		}
		if (signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortFromCaller);
	}
}

async function readBoundedResponse(
	response: Response,
	maxBytes: number,
	truncateOverflow: boolean,
	description: string,
	signal: AbortSignal,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	const abort = () => void reader.cancel().catch(() => undefined);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	if (truncated && !truncateOverflow) {
		throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(body);
	return truncated ? `${text}…` : text;
}

type RequestAuth = {
	apiKey?: string;
	headers?: Record<string, string | null>;
};

type StoredCredentialReader = (providerId: string) => unknown;

type UsageAuthRegistry = {
	getApiKeyAndHeaders?(
		model: PiModel,
	): Promise<({ ok: true } & RequestAuth) | { ok: false; error: string }>;
	getProviderAuth?(providerId: string): Promise<
		| {
				auth: RequestAuth & { baseUrl?: string };
		  }
		| undefined
	>;
};

async function resolveNewApiSystemAuth(
	ctx: ExtensionContext,
	adapter: UsageProviderAdapter,
	model: PiModel,
	salt: Uint8Array,
	token: string | undefined,
	userId: number | undefined,
): Promise<ResolvedUsageAuth | undefined> {
	const systemToken = token?.trim();
	if (!systemToken) {
		throw new Error(
			"New API usage requires the gateway's system access token (个人设置-安全设置-系统访问令牌); set newApiSystemToken in pi-usage.json.",
		);
	}
	// The runtime inference key (sk-…) never authenticates new-api management
	// endpoints; only the provider-level base URL is reused for origin fallback.
	let providerBaseUrl: string | undefined;
	const registry = ctx.modelRegistry as unknown as UsageAuthRegistry;
	if (typeof registry.getProviderAuth === "function") {
		try {
			providerBaseUrl = (await registry.getProviderAuth(adapter.id))?.auth.baseUrl;
		} catch {
			providerBaseUrl = undefined;
		}
	}
	const effectiveBaseUrl = model.baseUrl ?? providerBaseUrl;
	if (!effectiveBaseUrl || !hasOfficialUrlOrigin(effectiveBaseUrl, adapter.id)) {
		return undefined;
	}
	const authorization = `Bearer ${systemToken}`;
	const headers: Record<string, string> = { Authorization: authorization };
	if (userId !== undefined) {
		// Older new-api deployments require the New-Api-User header to match
		// the user resolved from the access token; newer deployments ignore it.
		headers["New-Api-User"] = String(userId);
	}
	return {
		apiKey: systemToken,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets: [systemToken, authorization],
		model: { ...model, baseUrl: effectiveBaseUrl },
	};
}

function resolveXaiUsageAuth(
	auth: RequestAuth,
	model: PiModel,
	salt: Uint8Array,
	candidates: readonly unknown[],
): ResolvedUsageAuth {
	const resolvedAccess = bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
	if (!resolvedAccess) throw new Error("xAI runtime authentication was incomplete.");
	let sawOAuth = false;
	let sawMatchingAccess = false;
	let sawIncompleteMatch = false;
	const matches: Array<{ access: string; refresh: string }> = [];
	for (const candidate of candidates) {
		try {
			const credential = asObject(candidate);
			if (credential?.type !== "oauth") continue;
			sawOAuth = true;
			if (credential.access !== resolvedAccess) continue;
			sawMatchingAccess = true;
			if (
				typeof credential.access !== "string" ||
				!credential.access ||
				typeof credential.refresh !== "string" ||
				!credential.refresh ||
				typeof credential.expires !== "number" ||
				!Number.isFinite(credential.expires)
			) {
				sawIncompleteMatch = true;
				continue;
			}
			matches.push({ access: credential.access, refresh: credential.refresh });
		} catch {
			// Malformed candidates never authorize a consumer-proxy request.
		}
	}
	if (sawIncompleteMatch) throw new Error("The matching xAI OAuth credential was incomplete.");
	if (matches.length > 1) {
		throw new Error("Multiple OAuth credentials match the active xAI runtime account.");
	}
	const match = matches[0];
	if (!match) {
		if (!sawOAuth) {
			throw new Error(
				"xAI consumer usage requires the OAuth subscription account configured through Pi /login; XAI_API_KEY users can review API spend at console.x.ai.",
			);
		}
		if (sawMatchingAccess) throw new Error("The matching xAI OAuth credential was incomplete.");
		throw new Error("The active xAI runtime account does not match Pi's stored OAuth account.");
	}
	const authorization = `Bearer ${match.access}`;
	const headers = { Authorization: authorization };
	return {
		apiKey: match.access,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets: [
			match.access,
			match.refresh,
			resolvedAccess,
			auth.apiKey,
			headerValue(auth.headers, "Authorization"),
			authorization,
		].filter((value): value is string => Boolean(value)),
		model,
	};
}

function resolveGitHubCopilotUsageAuth(
	auth: RequestAuth,
	model: PiModel,
	salt: Uint8Array,
	candidates: readonly unknown[],
	standaloneFallback: boolean,
): ResolvedUsageAuth {
	const resolvedAccess = bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
	if (!resolvedAccess) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
	let sawOAuth = false;
	let sawMatchingAccess = false;
	let sawIncompleteMatch = false;
	let sawEnterpriseMatch = false;
	const matches = new Map<string, { refresh: string; storedAccess: string }>();
	for (const candidate of candidates) {
		try {
			const credential = asObject(candidate);
			if (credential?.type !== "oauth") continue;
			sawOAuth = true;
			const storedAccess =
				typeof credential.access === "string" && credential.access ? credential.access : undefined;
			if (storedAccess !== resolvedAccess) continue;
			sawMatchingAccess = true;
			const enterpriseUrl = credential.enterpriseUrl;
			if (
				typeof enterpriseUrl === "string" &&
				enterpriseUrl &&
				!isPublicGitHubDomain(enterpriseUrl)
			) {
				sawEnterpriseMatch = true;
				continue;
			}
			const refresh =
				typeof credential.refresh === "string" && credential.refresh
					? credential.refresh
					: undefined;
			if (!refresh) {
				sawIncompleteMatch = true;
				continue;
			}
			matches.set(`${storedAccess.length}:${storedAccess}${refresh}`, { refresh, storedAccess });
		} catch {
			// Malformed candidates never authorize a provider request.
		}
	}
	if (sawEnterpriseMatch) {
		throw new Error("GitHub Copilot usage does not yet support GitHub Enterprise accounts.");
	}
	if (sawIncompleteMatch) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
	if (matches.size > 1) {
		throw new Error(
			"Conflicting OAuth credentials match the active GitHub Copilot runtime account.",
		);
	}
	const match = matches.values().next().value;
	if (!match) {
		if (!sawOAuth) {
			throw new Error(
				standaloneFallback
					? "GitHub Copilot usage requires the OAuth account configured through Pi /login."
					: "GitHub Copilot usage requires an OAuth account configured through Pi /login or a compatible credential source.",
			);
		}
		if (sawMatchingAccess) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
		throw new Error(
			standaloneFallback
				? "The active GitHub Copilot runtime account does not match Pi's stored OAuth account."
				: "The active GitHub Copilot runtime account does not match any available OAuth account.",
		);
	}
	const { refresh, storedAccess } = match;
	const authorization = `Bearer ${refresh}`;
	const headers = {
		Authorization: authorization,
		"X-GitHub-Api-Version": "2025-05-01",
	};
	return {
		apiKey: refresh,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets: [refresh, storedAccess, resolvedAccess, authorization],
		model,
	};
}

function authorizationFrom(auth: RequestAuth): string | undefined {
	return (
		headerValue(auth.headers, "Authorization") ??
		(auth.apiKey ? `Bearer ${auth.apiKey}` : undefined)
	);
}

function bearerToken(authorization: string | undefined): string | undefined {
	const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
	return match?.[1];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function isPublicGitHubDomain(value: string): boolean {
	try {
		const url = new URL(value.includes("://") ? value : `https://${value}`);
		return url.hostname.toLowerCase() === "github.com";
	} catch {
		return false;
	}
}

function hasOfficialOrigin(model: PiModel, providerId: string): boolean {
	return hasOfficialUrlOrigin(model.baseUrl, providerId);
}

function isNewApi(providerId: string): boolean {
	return providerId === "new-api";
}

function hasOfficialUrlOrigin(value: string, providerId: string): boolean {
	try {
		const url = new URL(value);
		if (isNewApi(providerId)) {
			// Deliberate deviation: new-api is self-hosted gateway software with
			// no single official origin. The usage credential is sent only to
			// the http(s) origin Pi resolved for the new-api provider/model.
			return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
		}
		if (providerId === "openai-codex") return url.origin === "https://chatgpt.com";
		if (providerId === "openrouter") return url.origin === "https://openrouter.ai";
		if (providerId === "opencode-go") return url.origin === "https://opencode.ai";
		if (providerId === "kimi-coding") return url.origin === "https://api.kimi.com";
		if (providerId === "xai") return url.origin === "https://api.x.ai";
		if (providerId === "zai") return url.origin === "https://api.z.ai";
		if (providerId === "zai-coding-cn") return url.origin === "https://open.bigmodel.cn";
		if (providerId === "github-copilot") {
			return (
				url.protocol === "https:" && /^api\.[a-z0-9-]+\.githubcopilot\.com$/u.test(url.hostname)
			);
		}
		return false;
	} catch {
		return false;
	}
}

function headerValue(
	headers: Record<string, string | null> | undefined,
	name: string,
): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
	);
	return entry?.[1] ?? undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function validatedXaiUserId(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) {
		throw new Error("xAI consumer identity returned an unsafe canonical user ID.");
	}
	return value;
}

function remainingTimeout(timeoutMs: number, startedAt: number): number {
	const remaining = timeoutMs - (Date.now() - startedAt);
	if (remaining <= 0) throw new Error("Timed out while fetching xAI consumer usage.");
	return remaining;
}

function zaiMonitorUrl(baseUrl: string | undefined): string {
	const base = baseUrl?.trim();
	if (!base) throw new Error("Z.AI model base URL is unavailable.");
	return `${new URL(base).origin}/api/monitor/usage/quota/limit`;
}

function newApiOrigin(baseUrl: string | undefined): string {
	const base = baseUrl?.trim();
	if (!base) throw new Error("New API model base URL is unavailable.");
	return new URL(base).origin;
}

function translateNewApiAuthError(error: unknown): unknown {
	if (!(error instanceof Error) || !error.message.includes("New-Api-User")) {
		return error;
	}
	const message = error.message;
	if (/New-Api-User header not provided/i.test(message)) {
		return new Error(
			`${message} — set newApiUserId in pi-usage.json (the numeric User ID shown on the gateway dashboard profile page).`,
		);
	}
	if (/New-Api-User does not match/i.test(message)) {
		return new Error(
			`${message} — verify that newApiUserId in pi-usage.json matches the dashboard profile User ID of the system-access-token account.`,
		);
	}
	if (/New-Api-User header format/i.test(message)) {
		return new Error(
			`${message} — newApiUserId must be the numeric User ID shown on the gateway dashboard profile page.`,
		);
	}
	return new Error(
		`${message} — verify newApiUserId in pi-usage.json matches the dashboard profile User ID of the system-access-token account.`,
	);
}

function zaiMonitorAuth(auth: ResolvedUsageAuth): ResolvedUsageAuth {
	const authorization = headerValue(auth.headers, "Authorization");
	const token =
		authorization === undefined ? undefined : (bearerToken(authorization) ?? authorization);
	if (token === undefined || token === authorization) return auth;
	return { ...auth, headers: { ...auth.headers, Authorization: token } };
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
