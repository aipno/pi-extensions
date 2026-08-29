import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const USAGE_SETTINGS_FILE = "pi-usage.json";
export const MAX_USAGE_SETTINGS_BYTES = 64 * 1024;

export interface UsageSettings {
	codexFastMode: boolean;
	xaiUsage: boolean;
	/** Show provider usage in the footer statusline (status key "usage"). */
	usageStatusline: boolean;
	/**
	 * new-api's dashboard system access token (个人设置-安全设置-系统访问令牌).
	 * Required to read /api/user/self and /api/data/self; the sk- inference
	 * token is not accepted by new-api's management endpoints.
	 */
	newApiSystemToken?: string;
	/**
	 * Numeric user id shown on the dashboard profile page (User ID).
	 * Sent as the New-Api-User header; deployments that predate the header
	 * deprecation require it and reject requests without it.
	 */
	newApiUserId?: number;
}

export const DEFAULT_USAGE_SETTINGS: Readonly<UsageSettings> = Object.freeze({
	codexFastMode: false,
	xaiUsage: true,
	usageStatusline: false,
});

export interface UsageSettingsState {
	kind: "missing" | "loaded" | "invalid";
	path: string;
	settings: UsageSettings;
	document?: Record<string, unknown>;
	issue?: string;
}

/**
 * Patch accepted by UsageSettingsRuntime.update. The two secret-ish new-api
 * keys additionally accept an empty string, which clears the stored value
 * (whitespace-only strings are ignored); undefined deletes the key.
 */
export type UsageSettingsPatch = Partial<
	Omit<UsageSettings, "newApiSystemToken" | "newApiUserId">
> & {
	newApiSystemToken?: string;
	newApiUserId?: number | "";
};

export interface UsageSettingsRuntime {
	get(): Readonly<UsageSettingsState>;
	reload(signal?: AbortSignal): Promise<Readonly<UsageSettingsState>>;
	update(
		patch: UsageSettingsPatch,
		signal?: AbortSignal,
	): Promise<Readonly<UsageSettingsState>>;
	flush(): Promise<void>;
}

/**
 * First validation problem with a client-supplied new-api system token, or
 * undefined when the value is acceptable (empty means "clear the setting").
 */
export function newApiSystemTokenIssue(value: string): string | undefined {
	const token = value.trim();
	if (token.length === 0) return undefined;
	if (token.length > 128) return "The token must be 128 characters or fewer.";
	for (let index = 0; index < token.length; index += 1) {
		const code = token.charCodeAt(index);
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			return "The token must not contain control characters.";
		}
	}
	return undefined;
}

/**
 * First validation problem with a client-supplied numeric new-api user id, or
 * undefined when the value is acceptable (empty means "clear the setting").
 */
export function newApiUserIdIssue(value: string): string | undefined {
	const text = value.trim();
	if (text.length === 0) return undefined;
	const userId = Number(text);
	if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2_147_483_647) {
		return "The user ID must be a positive whole number up to 2147483647.";
	}
	return undefined;
}

interface UsageSettingsFileOperations {
	rename: typeof rename;
	writeFile: typeof writeFile;
}

interface UsageSettingsRuntimeOptions {
	operations?: Partial<UsageSettingsFileOperations>;
	path?: string;
}

export function usageSettingsPath(): string {
	return join(getAgentDir(), USAGE_SETTINGS_FILE);
}

export function normalizeUsageSettings(value: unknown): UsageSettings | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.hasOwn(value, "codexFastMode") && typeof value.codexFastMode !== "boolean") {
		return undefined;
	}
	if (Object.hasOwn(value, "xaiUsage") && typeof value.xaiUsage !== "boolean") {
		return undefined;
	}
	if (Object.hasOwn(value, "usageStatusline") && typeof value.usageStatusline !== "boolean") {
		return undefined;
	}
	const result: UsageSettings = {
		codexFastMode:
			typeof value.codexFastMode === "boolean"
				? value.codexFastMode
				: DEFAULT_USAGE_SETTINGS.codexFastMode,
		xaiUsage:
			typeof value.xaiUsage === "boolean" ? value.xaiUsage : DEFAULT_USAGE_SETTINGS.xaiUsage,
		usageStatusline:
			typeof value.usageStatusline === "boolean"
				? value.usageStatusline
				: DEFAULT_USAGE_SETTINGS.usageStatusline,
	};
	if (Object.hasOwn(value, "newApiSystemToken")) {
		// A present-but-empty token is malformed (the runtime update path removes
		// the key on clear), so it makes the whole document invalid as before.
		if (typeof value.newApiSystemToken !== "string" || value.newApiSystemToken.trim().length === 0) {
			return undefined;
		}
		const token = value.newApiSystemToken;
		if (!isValidSystemToken(token)) return undefined;
		result.newApiSystemToken = token.trim();
	}
	if (Object.hasOwn(value, "newApiUserId")) {
		const userId = value.newApiUserId;
		if (
			typeof userId !== "number" ||
			!Number.isSafeInteger(userId) ||
			userId <= 0 ||
			userId > 2_147_483_647
		) {
			return undefined;
		}
		result.newApiUserId = userId;
	}
	return result;
}

function isValidSystemToken(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return newApiSystemTokenIssue(value) === undefined;
}

export async function loadUsageSettings(
	path = usageSettingsPath(),
	signal?: AbortSignal,
): Promise<UsageSettingsState> {
	throwIfAborted(signal);
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let text: string;
		try {
			const stats = await handle.stat();
			throwIfAborted(signal);
			if (!stats.isFile()) throw new Error("settings path is not a regular file");
			if (stats.size > MAX_USAGE_SETTINGS_BYTES) {
				throw new Error("settings file exceeds 64 KiB");
			}
			text = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		throwIfAborted(signal);
		const document = JSON.parse(text) as unknown;
		const settings = normalizeUsageSettings(document);
		if (!settings || !isRecord(document)) throw new Error("invalid settings shape");
		return { kind: "loaded", path, settings, document };
	} catch (error) {
		if (signal?.aborted) throw error;
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				settings: { ...DEFAULT_USAGE_SETTINGS },
				document: {},
			};
		}
		return {
			kind: "invalid",
			path,
			settings: { ...DEFAULT_USAGE_SETTINGS },
			issue:
				isNodeError(error) && error.code === "ELOOP"
					? "symbolic links are not accepted"
					: error instanceof Error
						? error.message
						: String(error),
		};
	}
}

export function createUsageSettingsRuntime(
	options: UsageSettingsRuntimeOptions | string = {},
): UsageSettingsRuntime {
	const path = typeof options === "string" ? options : (options.path ?? usageSettingsPath());
	const operations: UsageSettingsFileOperations = {
		rename,
		writeFile,
		...(typeof options === "string" ? undefined : options.operations),
	};
	let state: UsageSettingsState = {
		kind: "missing",
		path,
		settings: { ...DEFAULT_USAGE_SETTINGS },
		document: {},
	};
	let queue = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = queue.then(operation, operation);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	return {
		get: () => structuredClone(state),
		reload: (signal) =>
			enqueue(async () => {
				const loaded = await loadUsageSettings(path, signal);
				state = loaded;
				return structuredClone(state);
			}),
		update: (patch, signal) =>
			enqueue(async () => {
				const saved = await saveUsageSettingsPatch(path, patch, operations, signal);
				state = saved;
				return structuredClone(state);
			}),
		flush: () => queue,
	};
}

async function saveUsageSettingsPatch(
	path: string,
	patch: UsageSettingsPatch,
	operations: UsageSettingsFileOperations,
	signal?: AbortSignal,
): Promise<UsageSettingsState> {
	const latest = await loadUsageSettings(path, signal);
	if (latest.kind === "invalid") {
		throw new Error("Cannot overwrite an invalid pi-usage.json; repair it and reload first");
	}
	// new-api secret/ID keys support explicit clearing: an empty-string patch
	// value removes the key (a whitespace-only value is skipped instead, so a
	// stray space can never silently wipe a stored credential), and an
	// undefined value deletes it. Other keys pass through unchanged.
	const document = { ...latest.document };
	for (const [key, value] of Object.entries(patch)) {
		if (key !== "newApiSystemToken" && key !== "newApiUserId") {
			document[key] = value;
			continue;
		}
		if (typeof value === "string" && value.trim().length === 0) {
			if (value.length > 0) continue;
			delete document[key];
		} else if (value === undefined) {
			delete document[key];
		} else {
			document[key] = value;
		}
	}
	const settings = normalizeUsageSettings(document);
	if (!settings) throw new Error("Refusing to save invalid pi-usage settings");
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	throwIfAborted(signal);
	try {
		await operations.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		if (process.platform !== "win32") await chmodPrivate(temporaryPath);
		throwIfAborted(signal);
		const current = await loadUsageSettings(path, signal);
		if (
			current.kind === "invalid" ||
			current.kind !== latest.kind ||
			JSON.stringify(current.document) !== JSON.stringify(latest.document)
		) {
			throw new Error("pi-usage.json changed while saving; retry the action");
		}
		throwIfAborted(signal);
		await operations.rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
	return { kind: "loaded", path, settings, document };
}

async function chmodPrivate(path: string): Promise<void> {
	await chmod(path, 0o600);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
