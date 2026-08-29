import type { ChildProcess } from "node:child_process";
import {
	DEFAULT_BROWSER_HOST,
	DEFAULT_BROWSER_PORT,
	type EffectiveBrowserSettings,
	parseConfiguredPort,
} from "./settings.ts";

export const DEFAULT_HOST = DEFAULT_BROWSER_HOST;
export const DEFAULT_PORT = DEFAULT_BROWSER_PORT;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 1_000;
export const DEFAULT_ENDPOINT_WAIT_MS = 5_000;
export const DEFAULT_ENDPOINT_RETRY_MS = 250;
export const MANAGED_BROWSER_PROFILE_PREFIX = "pi-chrome-dev-tools-profile-";
export const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
export const BROWSER_SHUTDOWN_WAIT_MS = 1_500;

export interface DevToolsPage {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

export interface ChromeDevToolsState {
	host: string;
	port: number;
	configuredPort: number;
	hostConfigured: boolean;
	portConfigured: boolean;
	autoLaunchEnabled: boolean;
	endpointSource: EffectiveBrowserSettings["endpointSource"];
	autoLaunchSource: EffectiveBrowserSettings["autoLaunchSource"];
	browserExecutable?: string;
	browserExecutableSource: EffectiveBrowserSettings["executablePathSource"];
	settingsFilePath?: string;
	projectSettingsFilePath?: string;
	projectSettingsTrusted: boolean;
	activePageId?: string;
	managedBrowser?: ManagedBrowser;
	launchPromise?: Promise<void>;
	lastLaunchAttempt?: BrowserLaunchAttempt;
	shuttingDown: boolean;
	sessionGeneration: number;
	sessionController: AbortController;
	settingsNotice?: string;
}

export interface ManagedBrowser {
	process: ChildProcess;
	userDataDir: string;
	port?: number;
	exited: boolean;
	ready: boolean;
	ownerGeneration: number;
	sessionOwner?: object;
	cleanupPromise?: Promise<void>;
}

export interface BrowserLaunchAttempt {
	candidateLabels: string[];
	mode: "dynamic-port" | "explicit-port";
	selectedCandidate?: string;
	userDataDir?: string;
	lastError?: string;
}

export interface BrowserCandidateDefinition {
	label: string;
	executable: string;
	source: "env" | "path" | "wellKnownPath";
}

export interface BrowserCandidate extends BrowserCandidateDefinition {
	resolvedExecutable: string;
}

export { parseConfiguredPort };

export const state: ChromeDevToolsState = {
	host: DEFAULT_HOST,
	port: DEFAULT_PORT,
	configuredPort: DEFAULT_PORT,
	hostConfigured: false,
	portConfigured: false,
	autoLaunchEnabled: true,
	endpointSource: "default",
	autoLaunchSource: "default",
	browserExecutableSource: "default",
	projectSettingsTrusted: false,
	shuttingDown: false,
	sessionGeneration: 0,
	sessionController: new AbortController(),
};

export function applyRuntimeBrowserSettings(
	browser: EffectiveBrowserSettings,
	paths: { user: string; project?: string },
	projectTrusted: boolean,
) {
	state.host = browser.host;
	state.port = browser.port;
	state.configuredPort = browser.port;
	state.hostConfigured = browser.hostConfigured;
	state.portConfigured = browser.portConfigured;
	state.autoLaunchEnabled = browser.autoLaunchEnabled;
	state.endpointSource = browser.endpointSource;
	state.autoLaunchSource = browser.autoLaunchSource;
	state.browserExecutable = browser.executablePath;
	state.browserExecutableSource = browser.executablePathSource;
	state.settingsFilePath = paths.user;
	state.projectSettingsFilePath = paths.project;
	state.projectSettingsTrusted = projectTrusted;
}