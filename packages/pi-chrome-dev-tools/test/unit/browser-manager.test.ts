import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildManagedBrowserLaunchArguments,
	devToolsEndpoint,
	ensureDevToolsEndpoint,
	fetchDevToolsJson,
	formatHostForUrl,
	isLocalDevToolsHost,
	launchAttemptLines,
	launchModeLabel,
	managedBrowserForOwner,
	quoteCommandPart,
	setBrowserManagerOperationsForTests,
	shutdownManagedBrowser,
	startManagedBrowserSession,
	syncManagedBrowserSettings,
	withEndpointRetry,
} from "../../src/browser-manager.ts";
import { state } from "../../src/runtime.ts";

function effectiveSettings(overrides: Record<string, unknown> = {}) {
	return {
		endpoint: "http://127.0.0.1:9222",
		host: "127.0.0.1",
		port: 9222,
		hostConfigured: false,
		portConfigured: false,
		autoLaunchEnabled: true,
		endpointSource: "default" as const,
		autoLaunchSource: "default" as const,
		executablePathSource: "default" as const,
		...overrides,
	};
}

class FakeBrowserChild extends EventEmitter {
	killCalls = 0;

	constructor() {
		super();
		queueMicrotask(() => this.emit("spawn"));
	}

	kill(): boolean {
		this.killCalls += 1;
		queueMicrotask(() => this.emit("exit", 0, null));
		return true;
	}
}

let root: string;
let previousAutoLaunch = true;
let previousExecutable: string | undefined;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pi-cdt-browser-"));
	previousAutoLaunch = state.autoLaunchEnabled;
	previousExecutable = state.browserExecutable;
	state.autoLaunchEnabled = true;
	state.browserExecutable = undefined;
});

afterEach(() => {
	state.autoLaunchEnabled = previousAutoLaunch;
	state.browserExecutable = previousExecutable;
	state.managedBrowser = undefined;
	state.launchPromise = undefined;
	state.lastLaunchAttempt = undefined;
	state.port = 9222;
	state.shuttingDown = false;
	rmSync(root, { recursive: true, force: true });
});

test("managed launch arguments enable the DevTools port with an isolated profile", () => {
	const args = buildManagedBrowserLaunchArguments("/tmp/profile", "0");
	assert.equal(args[0], "--remote-debugging-port=0");
	assert.equal(args[1], "--user-data-dir=/tmp/profile");
	assert.deepEqual(
		args.filter((arg) => arg.startsWith("--disable-extensions-except")),
		[],
	);
	assert.equal(args.at(-1), "about:blank");

	const pinned = buildManagedBrowserLaunchArguments("/tmp/pinned", "9222");
	assert.deepEqual(pinned.slice(0, 2), [
		"--remote-debugging-port=9222",
		"--user-data-dir=/tmp/pinned",
	]);
});

test("endpoint and executable helpers format command parts and hosts", () => {
	assert.equal(quoteCommandPart("google-chrome"), "google-chrome");
	assert.equal(quoteCommandPart("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"');
	assert.equal(formatHostForUrl("127.0.0.1"), "127.0.0.1");
	assert.equal(formatHostForUrl("::1"), "[::1]");
	assert.equal(formatHostForUrl("[::1]"), "[::1]");
	assert.equal(isLocalDevToolsHost("localhost"), true);
	assert.equal(isLocalDevToolsHost("127.0.0.1"), true);
	assert.equal(isLocalDevToolsHost("::1"), true);
	assert.equal(isLocalDevToolsHost("[::1]"), true);
	assert.equal(isLocalDevToolsHost("0:0:0:0:0:0:0:1"), true);
	assert.equal(isLocalDevToolsHost("192.168.1.10"), false);
});

test("fetchDevToolsJson classifies connection, HTTP, and JSON errors", async () => {
	const restore = setBrowserManagerOperationsForTests({
		fetch: async () => {
			throw new TypeError("fetch failed");
		},
	});
	try {
		const connectionError = await fetchDevToolsJson<unknown>("/json/version").catch(
			(error: unknown) => error,
		);
		assert.ok(connectionError instanceof Error);
		assert.match(connectionError.message, /Cannot connect to Chrome DevTools endpoint/u);
	} finally {
		restore();
	}

	const restoreHttp = setBrowserManagerOperationsForTests({
		fetch: async () => new Response("not found", { status: 404 }),
	});
	try {
		await assert.rejects(fetchDevToolsJson("/json/version"), /returned 404/u);
	} finally {
		restoreHttp();
	}

	const restoreServer = setBrowserManagerOperationsForTests({
		fetch: async () => new Response("boom", { status: 500 }),
	});
	try {
		await assert.rejects(fetchDevToolsJson("/json/version"), /returned 500/u);
	} finally {
		restoreServer();
	}

	const restoreJson = setBrowserManagerOperationsForTests({
		fetch: async () => new Response("{not json", { status: 200 }),
	});
	try {
		await assert.rejects(fetchDevToolsJson("/json/version"), /invalid JSON/u);
	} finally {
		restoreJson();
	}
});

test("withEndpointRetry retries retryable failures until success or deadline", async () => {
	let failures = 0;
	const restore = setBrowserManagerOperationsForTests({
		fetch: async () => {
			failures += 1;
			if (failures <= 2) throw new TypeError("fetch failed");
			return new Response("{\"ok\":true}", { status: 200 });
		},
		sleep: async () => undefined,
	});
	try {
		const value = await withEndpointRetry(
			() => fetchDevToolsJson<{ ok: boolean }>("/json/version"),
			1_000,
		);
		assert.deepEqual(value, { ok: true });
		assert.equal(failures, 3);
	} finally {
		restore();
	}

	const exhaustedRestore = setBrowserManagerOperationsForTests({
		fetch: async () => {
			throw new TypeError("fetch failed");
		},
		sleep: async () => undefined,
	});
	try {
		const exhausted = withEndpointRetry(
			() => fetchDevToolsJson<unknown>("/json/version"),
			1,
		);
		await assert.rejects(exhausted, /Cannot connect to Chrome DevTools endpoint/u);
	} finally {
		exhaustedRestore();
	}
});

test("attach-first succeeds when an endpoint answers without launching a browser", async () => {
	const restore = setBrowserManagerOperationsForTests({
		fetch: async (input) => {
			assert.ok(input.startsWith(devToolsEndpoint()));
			return new Response("{}", { status: 200 });
		},
	});
	try {
		await ensureDevToolsEndpoint(1_000, undefined, undefined);
		assert.equal(managedBrowserForOwner(undefined), undefined);
	} finally {
		restore();
	}
});

test("a non-retryable endpoint error surfaces when auto-launch cannot help", async () => {
	const owner = {};
	startManagedBrowserSession(owner);
	syncManagedBrowserSettings(owner, effectiveSettings({ autoLaunchEnabled: false }));
	const restore = setBrowserManagerOperationsForTests({
		fetch: async () => new Response("{broken", { status: 200 }),
	});
	try {
		await assert.rejects(
			ensureDevToolsEndpoint(100, undefined, owner),
			/returned invalid JSON/u,
		);
	} finally {
		restore();
	}
});

test("a failing endpoint launches a managed browser with a dynamic DevTools port", async () => {
	const owner = {};
	startManagedBrowserSession(owner);
	syncManagedBrowserSettings(
		owner,
		effectiveSettings({
			portConfigured: false,
			executablePath: "/fake/browser-for-testing",
			executablePathSource: "user",
		}),
	);
	const profileDir = path.join(root, "profiles");
	mkdirSync(profileDir, { recursive: true });
	const activePortFile = path.join(profileDir, "DevToolsActivePort");
	const launchAttempts: Array<{ executable: string; args: string[] }> = [];
	let fetchAttempts = 0;
	let portFileWrites = 0;
	const children: FakeBrowserChild[] = [];
	const restore = setBrowserManagerOperationsForTests({
		access: async () => undefined,
		mkdtemp: async () => profileDir,
		readFile: async (filePath) => {
			if (filePath !== activePortFile) throw new Error(`unexpected read: ${filePath}`);
			portFileWrites += 1;
			if (portFileWrites < 2) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return "13337\n/devtools-profile-information\n";
		},
		spawn: (executable, args) => {
			launchAttempts.push({ executable, args });
			const child = new FakeBrowserChild();
			children.push(child);
			return child as unknown as ChildProcess;
		},
		fetch: async (input, init) => {
			fetchAttempts += 1;
			if (fetchAttempts === 1) throw new TypeError("no endpoint yet");
			assert.ok(input.startsWith("http://127.0.0.1:13337"));
			return new Response("{}", { status: 200 });
		},
		sleep: async () => undefined,
	});
	try {
		await ensureDevToolsEndpoint(100, undefined, owner);

		assert.equal(launchAttempts.length, 1);
		assert.equal(launchAttempts[0]?.executable, "/fake/browser-for-testing");
		assert.deepEqual(launchAttempts[0]?.args.slice(0, 2), [
			"--remote-debugging-port=0",
			`--user-data-dir=${profileDir}`,
		]);
		const browser = managedBrowserForOwner(owner);
		assert.ok(browser);
		assert.equal(browser.ready, true);
		assert.equal(browser.port, 13337);
		assert.equal(browser.userDataDir, profileDir);
		assert.match(launchAttemptLines(owner).join("\n"), /Last launch attempt: dynamic-port/u);

		// A browser has not been launched for the global (ownerless) state.
		assert.equal(managedBrowserForOwner(undefined), undefined);

		await shutdownManagedBrowser(undefined, { owner });
		assert.equal(children[0]?.killCalls, 1);
		assert.equal(existsSync(profileDir), false);
	} finally {
		await shutdownManagedBrowser(undefined, { owner }).catch(() => undefined);
		restore();
	}
});

test("an explicit occupied port fails the managed launch before spawning", async () => {
	const owner = {};
	startManagedBrowserSession(owner);
	syncManagedBrowserSettings(
		owner,
		effectiveSettings({
			portConfigured: true,
			executablePath: "/fake/browser-for-testing",
			executablePathSource: "user",
		}),
	);
	let spawnCalls = 0;
	const restore = setBrowserManagerOperationsForTests({
		access: async () => undefined,
		isPortAvailable: async () => false,
		spawn: () => {
			spawnCalls += 1;
			return new FakeBrowserChild() as unknown as ChildProcess;
		},
		fetch: async () => {
			throw new TypeError("no endpoint yet");
		},
		sleep: async () => undefined,
	});
	try {
		await assert.rejects(
			ensureDevToolsEndpoint(50, undefined, owner),
			/explicit port 9222 is already in use/u,
		);
		assert.equal(spawnCalls, 0);
	} finally {
		restore();
	}
});

test("launch mode labels reflect auto-launch and managed state", () => {
	const owner = {};
	startManagedBrowserSession(owner);
	syncManagedBrowserSettings(owner, effectiveSettings());
	assert.equal(launchModeLabel(owner), "attach first; auto-launch dynamic port");

	syncManagedBrowserSettings(owner, effectiveSettings({ autoLaunchEnabled: false }));
	assert.equal(launchModeLabel(owner), "manual; auto-launch disabled");

	syncManagedBrowserSettings(owner, effectiveSettings({ autoLaunchEnabled: true }));
	syncManagedBrowserSettings(owner, effectiveSettings({ portConfigured: true, port: 9333 }));
	assert.equal(launchModeLabel(owner), "attach first; auto-launch explicit port");
});