import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	loadSettings,
	projectSettingsFilePath,
	saveBrowserSettings,
	saveSettings,
	settingsFilePath,
} from "../../src/settings.ts";
import { CHROME_DEVTOOLS_TOOL_NAMES } from "../../src/tool-names.ts";

const LIST_PAGES_TOOL = "chrome_devtools_list_pages";
const ENVIRONMENT_NAMES = [
	"PI_CHROME_DEVTOOLS_HOST",
	"PI_CHROME_DEVTOOLS_PORT",
	"PI_CHROME_DEVTOOLS_AUTO_LAUNCH",
	"PI_CHROME_DEVTOOLS_BROWSER",
] as const;

let root: string;
let previousAgentDir: string | undefined;
let previousEnvironment: Record<(typeof ENVIRONMENT_NAMES)[number], string | undefined>;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pi-cdt-settings-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousEnvironment = Object.fromEntries(
		ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]),
	) as Record<(typeof ENVIRONMENT_NAMES)[number], string | undefined>;
	mkdirSync(agentDir(), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir();
	for (const name of ENVIRONMENT_NAMES) delete process.env[name];
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const name of ENVIRONMENT_NAMES) {
		const previous = previousEnvironment[name];
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
});

function agentDir() {
	return path.join(root, "agent");
}

function cwd() {
	return path.join(root, "project");
}

function writeJson(filePath: string, value: unknown) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("browser-only user settings load without creating or requiring tool settings", async () => {
	writeJson(settingsFilePath(), {
		browser: {
			endpoint: "http://localhost:9333",
			autoLaunch: false,
			executablePath: "/usr/bin/example-chromium",
		},
		future: { kept: true },
	});

	const loaded = await loadSettings({ cwd: cwd(), projectTrusted: false });

	assert.equal(loaded.kind, "loaded");
	assert.equal(loaded.settings?.tools, undefined);
	assert.equal(loaded.effectiveBrowser.endpoint, "http://localhost:9333");
	assert.equal(loaded.effectiveBrowser.host, "localhost");
	assert.equal(loaded.effectiveBrowser.port, 9333);
	assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, false);
	assert.equal(loaded.effectiveBrowser.endpointSource, "user");
	assert.equal(loaded.effectiveBrowser.autoLaunchSource, "user");
	assert.equal(loaded.effectiveBrowser.executablePath, "/usr/bin/example-chromium");
	assert.equal(loaded.effectiveBrowser.executablePathSource, "user");
	assert.deepEqual(loaded.warnings, []);
});

test("missing user and project settings are side-effect free defaults", async () => {
	rmSync(agentDir(), { recursive: true, force: true });
	rmSync(path.join(cwd(), ".pi"), { recursive: true, force: true });

	const loaded = await loadSettings({ cwd: cwd(), projectTrusted: true });

	assert.equal(loaded.kind, "missing");
	assert.equal(loaded.effectiveBrowser.endpoint, "http://127.0.0.1:9222");
	assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, true);
	assert.equal(loaded.effectiveBrowser.endpointSource, "default");
	assert.equal(existsSync(settingsFilePath()), false);
	assert.equal(existsSync(projectSettingsFilePath(cwd())), false);
});

test("an explicit empty tool selection remains a loaded global setting", async () => {
	writeJson(settingsFilePath(), { tools: [], updatedAt: 1 });

	const loaded = await loadSettings({ cwd: cwd(), projectTrusted: false });

	assert.equal(loaded.kind, "loaded");
	assert.deepEqual(loaded.settings?.tools, []);
});

test("the tools catalog normalizes to the canonical ordering and rejects unknown names", async () => {
	writeJson(settingsFilePath(), {
		tools: [LIST_PAGES_TOOL, "chrome_devtools_navigate", "not_a_tool"],
		updatedAt: 7,
	});

	const loaded = await loadSettings();

	assert.equal(loaded.kind, "invalid");
	assert.match(loaded.reason ?? "", /expected tools to be an array/u);

	writeJson(settingsFilePath(), {
		tools: ["chrome_devtools_navigate", LIST_PAGES_TOOL],
		updatedAt: 7,
	});
	const canonical = await loadSettings();
	assert.equal(canonical.kind, "loaded");
	assert.deepEqual(canonical.settings?.tools, [LIST_PAGES_TOOL, "chrome_devtools_navigate"]);
});

test("legacy settings files remain readable with a warning and are never modified", async () => {
	const legacyFile = path.join(agentDir(), "pi-chrome-dev-tools-settings.json");
	writeJson(legacyFile, { tools: [LIST_PAGES_TOOL], updatedAt: 3 });

	const loaded = await loadSettings();

	assert.equal(loaded.kind, "loaded");
	assert.deepEqual(loaded.settings?.tools, [LIST_PAGES_TOOL]);
	assert.match(loaded.warnings.join("\n"), /legacy pi-chrome-dev-tools-settings\.json/u);

	await saveSettings({ tools: [], updatedAt: 9 });
	const canonical = JSON.parse(readFileSync(settingsFilePath(), "utf8")) as {
		tools: string[];
	};
	assert.deepEqual(canonical.tools, []);
	assert.equal(existsSync(legacyFile), true);
	assert.equal(
		(JSON.parse(readFileSync(legacyFile, "utf8")) as { updatedAt: number }).updatedAt,
		3,
	);
});

test("the canonical file wins while the legacy file is ignored", async () => {
	writeJson(path.join(agentDir(), "pi-chrome-dev-tools-settings.json"), {
		tools: [],
		updatedAt: 1,
	});
	writeJson(settingsFilePath(), { tools: CHROME_DEVTOOLS_TOOL_NAMES, updatedAt: 2 });

	const loaded = await loadSettings();

	assert.equal(loaded.kind, "loaded");
	assert.equal(loaded.settings?.tools?.length, CHROME_DEVTOOLS_TOOL_NAMES.length);
	assert.match(loaded.warnings.join("\n"), /takes precedence/u);
});

test("invalid user JSON is ignored with an actionable warning", async () => {
	writeFileSync(settingsFilePath(), "{not json");

	const loaded = await loadSettings();

	assert.equal(loaded.kind, "invalid");
	assert.match(loaded.reason ?? "", /invalid JSON/u);
	assert.equal(loaded.warnings.length, 1);
});

test("trusted project settings may not override machine-owned browser fields", async () => {
	writeJson(settingsFilePath(), { browser: { autoLaunch: false } });
	writeJson(projectSettingsFilePath(cwd()), {
		browser: {
			endpoint: "http://127.0.0.1:9444",
			autoLaunch: true,
			executablePath: "/usr/bin/project-chromium",
		},
	});

	const loaded = await loadSettings({ cwd: cwd(), projectTrusted: true });

	assert.equal(loaded.effectiveBrowser.endpoint, "http://127.0.0.1:9222");
	assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, false);
	assert.equal(loaded.effectiveBrowser.executablePath, undefined);
	assert.equal(loaded.warnings.length, 3);
	assert.match(loaded.warnings.join("\n"), /project browser\.endpoint ignored/u);
	assert.match(loaded.warnings.join("\n"), /project browser\.autoLaunch ignored/u);
	assert.match(loaded.warnings.join("\n"), /project browser\.executablePath ignored/u);
});

test("untrusted project settings are not read at all", async () => {
	writeJson(projectSettingsFilePath(cwd()), { browser: { autoLaunch: false } });

	const loaded = await loadSettings({ cwd: cwd(), projectTrusted: false });

	assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, true);
	assert.deepEqual(loaded.warnings, []);
});

test("deprecated environment overrides remain active with a deprecation warning", async () => {
	process.env.PI_CHROME_DEVTOOLS_HOST = "localhost";
	process.env.PI_CHROME_DEVTOOLS_PORT = "9555";
	process.env.PI_CHROME_DEVTOOLS_AUTO_LAUNCH = "0";
	process.env.PI_CHROME_DEVTOOLS_BROWSER = "/usr/bin/env-chromium";

	const loaded = await loadSettings();

	assert.equal(loaded.effectiveBrowser.host, "localhost");
	assert.equal(loaded.effectiveBrowser.port, 9555);
	assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, false);
	assert.equal(loaded.effectiveBrowser.autoLaunchSource, "environment");
	assert.equal(loaded.effectiveBrowser.executablePath, "/usr/bin/env-chromium");
	assert.equal(loaded.effectiveBrowser.executablePathSource, "environment");
	assert.match(loaded.warnings.join("\n"), /deprecated/u);
});

test("endpoint values must be HTTP origins with an explicit port", async () => {
	const invalidEndpoints = [
		"https://127.0.0.1:9222",
		"http://127.0.0.1",
		"http://user:pass@127.0.0.1:9222",
		"http://127.0.0.1:9222/path",
		"http://127.0.0.1:0",
		"http://127.0.0.1:70000",
		"not a url",
	];
	for (const endpoint of invalidEndpoints) {
		writeJson(settingsFilePath(), { browser: { endpoint } });
		const loaded = await loadSettings();
		assert.equal(loaded.kind, "invalid", endpoint);
		assert.match(loaded.reason ?? "", /browser\.endpoint/u, endpoint);
	}

	writeJson(settingsFilePath(), { browser: { endpoint: "http://[::1]:9333" } });
	const loaded = await loadSettings();
	assert.equal(loaded.kind, "loaded");
	assert.equal(loaded.effectiveBrowser.endpoint, "http://[::1]:9333");
	assert.equal(loaded.effectiveBrowser.host, "[::1]");
});

test("saving tools preserves unknown fields and writes atomically", async () => {
	writeJson(settingsFilePath(), { tools: [], updatedAt: 1, future: { kept: true } });

	await saveSettings({ tools: [LIST_PAGES_TOOL], updatedAt: 11 });

	const saved = JSON.parse(readFileSync(settingsFilePath(), "utf8")) as Record<string, unknown>;
	assert.deepEqual(saved.future, { kept: true });
	assert.deepEqual(saved.tools, [LIST_PAGES_TOOL]);
	assert.equal(saved.updatedAt, 11);
});

test("saving browser settings deletes fields on null and validates the result", async () => {
	writeJson(settingsFilePath(), {
		browser: { endpoint: "http://127.0.0.1:9333", autoLaunch: false },
	});

	await saveBrowserSettings({ autoLaunch: true, endpoint: null });

	const saved = JSON.parse(readFileSync(settingsFilePath(), "utf8")) as {
		browser: Record<string, unknown>;
	};
	assert.deepEqual(saved.browser, { autoLaunch: true });
	await assert.rejects(saveBrowserSettings({ endpoint: "http://127.0.0.1:0" }), /browser\.endpoint/u);
});

test("saving into an invalid settings file refuses without overwriting it", async () => {
	writeFileSync(settingsFilePath(), "{broken");

	await assert.rejects(
		saveSettings({ tools: [LIST_PAGES_TOOL], updatedAt: 1 }),
		/Cannot save Chrome DevTools settings until you repair/u,
	);
	assert.equal(readFileSync(settingsFilePath(), "utf8"), "{broken");
	assert.equal(existsSync(settingsFilePath()), true);
});

test("a first save creates the canonical file when missing", async () => {
	assert.equal(existsSync(settingsFilePath()), false);
	await saveSettings({ tools: [LIST_PAGES_TOOL], updatedAt: 1 });
	assert.equal(existsSync(settingsFilePath()), true);
	const loaded = await loadSettings();
	assert.equal(loaded.kind, "loaded");
	assert.deepEqual(loaded.settings?.tools, [LIST_PAGES_TOOL]);
});