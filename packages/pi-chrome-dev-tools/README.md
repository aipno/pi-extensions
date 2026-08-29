# 🌐 pi-chrome-dev-tools — Inspect and Control Chrome from Pi

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Let Pi inspect browser tabs, navigate pages, evaluate JavaScript, and capture screenshots through native Chrome DevTools Protocol tools.

Use it for web debugging, UI validation, and browser-assisted investigation without running an MCP server.

The design is inspired by [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) and ports [`@narumitw/pi-chrome-devtools`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-chrome-devtools), not guaranteed to be compatible with either.

## ✨ Features

- Lists and selects inspectable pages, navigates URLs, evaluates JavaScript, and captures PNG screenshots.
- Reuses an existing CDP endpoint or lazily launches an isolated Chromium-family browser.
- Recovers from stale page selections and reports actionable browser startup or endpoint errors.
- Uses native deferred browser tools when supported and eager exposure otherwise, with availability, setup, status, and help through `/chrome-devtools`.
- Shows compact expandable results and activity only while browser tools are running.
- Persists the reviewed tool availability catalog while keeping browser connection settings machine-owned.

## 📦 Install

From this repository:

```bash
pi -e ./packages/pi-chrome-dev-tools
```

The package loads directly from TypeScript sources, so no build step is required.

## 🚀 Quick start

Start Pi and ask the agent to load the Chrome DevTools capability needed for the task.
The extension first tries `http://127.0.0.1:9222` and otherwise launches an isolated local Chromium-family browser by default.
Run `/chrome-devtools` to review browser status, settings, help, and available tools.

## 🌐 Browser setup

The extension first tries `browser.endpoint`, defaulting to `http://127.0.0.1:9222`.
If that endpoint is unavailable and `browser.autoLaunch` is `true`, it lazily launches a managed browser with an isolated temporary profile and retries the CDP request.
Existing endpoints are reused and never terminated by the extension.

Configure the canonical user file at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-dev-tools.json`:

```json
{
  "browser": {
    "endpoint": "http://127.0.0.1:9222",
    "autoLaunch": true,
    "executablePath": "/absolute/path/to/chromium"
  }
}
```

`browser.endpoint` must be an HTTP origin with an explicit port and no credentials, path, query, or fragment.
Omitting it keeps attach-first behavior on `127.0.0.1:9222` and lets a managed launch use Chrome's dynamic DevTools port mode (`--remote-debugging-port=0`).
Explicitly saving an endpoint pins managed launches to that port.
`browser.autoLaunch` defaults to `true`.
`browser.executablePath` is optional and must be an absolute path; when absent, normal browser discovery applies (Google Chrome, Chromium, Brave, and Microsoft Edge).

The configured endpoint must expose the standard CDP HTTP discovery routes such as `/json/version` and `/json/list`.
Chrome's newer built-in permission flow can listen on port `9222` while returning `404` from those routes; setting the same HTTP origin does not by itself make that flow compatible.

### Deprecated environment overrides

The existing `PI_CHROME_DEVTOOLS_HOST`, `PI_CHROME_DEVTOOLS_PORT`, `PI_CHROME_DEVTOOLS_AUTO_LAUNCH`, and `PI_CHROME_DEVTOOLS_BROWSER` variables remain temporary compatibility overrides.
They still take precedence over JSON, but every session that sees one emits a deprecation warning.
Move their values to `browser.endpoint`, `browser.autoLaunch`, and `browser.executablePath`; the variables will be removed in a future version.

Manual launch remains available:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/pi-chrome-dev-tools
```

On session shutdown, the extension terminates only browser processes it started and best-effort removes their temporary profiles.
It never closes user-started browsers or remote endpoints.

## 🛠️ Tools

- `chrome_devtools_load` — find and load browser capabilities relevant to a task.
- `chrome_devtools_list_pages` — list inspectable Chrome tabs/pages.
- `chrome_devtools_select_page` — select the active page for later tool calls.
- `chrome_devtools_navigate` — navigate a page to a URL; if no page exists, create one first.
- `chrome_devtools_evaluate` — evaluate JavaScript in the selected page.
- `chrome_devtools_screenshot` — capture a PNG screenshot and save it as a PNG file.

### Tool exposure

All six tools are registered: one loader and five stable DevTools capabilities.

On a model/provider with native deferred-tool support, only `chrome_devtools_load` starts active for this extension.

The loader accepts a task-oriented `query`, matches it against the five capabilities, and adds matching available tools without removing any active Pi tool.

Loaded capability tools remain active for the rest of the session unless the user makes them unavailable through `/chrome-devtools`.

Pi uses native deferred tool references on compatible Anthropic models, native additional-tools or tool-search loading on compatible OpenAI and Codex Responses models, and native Kimi loading on compatible OpenAI Chat Completions models.

When the selected model/provider lacks native deferred support, the extension activates every capability allowed by settings before the next model request instead of using Pi's cache-invalidating lazy-loading fallback.

After a session enters eager exposure, it stays eager across later model switches to avoid removing tool definitions within that session.

The saved `tools` array controls which capabilities the extension may expose.
An empty array leaves the loader active but makes every browser capability unavailable.

### Screenshot files

`chrome_devtools_screenshot` always saves the captured PNG to disk.
If `savePath` is omitted, the extension writes a unique temp file such as:

```text
/tmp/pi-chrome-dev-tools-screenshot-<uuid>.png
```

Pass `savePath` to choose the output path:

```js
chrome_devtools_screenshot({
  fullPage: true,
  savePath: "artifacts/homepage.png",
});
```

Relative `savePath` values resolve from Pi's current working directory.
A single leading `@` is stripped to match Pi file-mention paths.
Absolute paths are accepted only when they stay inside the current working directory or the OS temp directory.
Paths containing `..` segments, NUL bytes, symlinked parent directories, directories as targets, final symbolic-link targets, or other non-regular file targets are rejected.
Existing regular files at the target path are replaced.
The tool result includes the resolved path, byte count, and an inline image block when the active model/provider can consume images.
If the model cannot inspect the inline image, ask it to read the saved path, for example `read({ path: "artifacts/homepage.png" })`.

## 💬 Commands

```text
/chrome-devtools
```

Opens a menu that shows the tool catalog size, whether that catalog is saved, the configured endpoint, the observed managed-browser state, and any settings or launch warning before you choose an action.

- **Choose available browser tools…** — stage any combination of the five capabilities, then review the exact available/unavailable result before selecting **Apply tool changes**.
- **Make all browser tools available…** or **Make all browser tools unavailable…** — preview the context-appropriate bulk change before applying it.
- **Browser status** — inspect runtime, endpoint, launch mode, and the last launch attempt without probing the endpoint or starting Chrome.
- **Browser settings** — immediately save the endpoint, auto-launch policy, or browser executable.
- **Help** — view command usage and return to the menu.

Direct subcommands are also available:

```text
/chrome-devtools help
/chrome-devtools quickstart
/chrome-devtools status
/chrome-devtools settings
/chrome-devtools tools
/chrome-devtools toggle
/chrome-devtools enable
/chrome-devtools disable
```

Compatibility aliases remain available: `toggle` and `select` mean `tools`, `on` means `enable`, and `off` means `disable`.

The menu, `settings`, `tools`, `help`, `quickstart`, and `status` require TUI or RPC mode so their result is observable.
In print and JSON modes, interactive and informational routes reject explicitly instead of silently opening unavailable UI.
The immediate `enable`/`disable` routes remain available for deterministic non-interactive use.

## ⚙️ Settings

The available capability names are saved to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-dev-tools.json
```

The same file owns `browser.endpoint`, `browser.autoLaunch`, and `browser.executablePath`.
Browser connection fields are machine-owned user settings.

When the file is missing or invalid, the extension preserves Pi's current Chrome DevTools availability policy instead of replacing it.
A valid saved catalog is restored on Pi startup and `/reload`, with capability definitions exposed natively deferred or eagerly according to model/provider support.
A missing file is created by the first confirmed browser or tool setting.
Within one Pi process, all browser and tool saves run in invocation order, reread the latest valid document, publish by temporary-file rename, and preserve unknown fields.
Malformed JSON or invalid recognized fields make menu mutation unavailable and block direct saves without replacement; a failed save restores the prior displayed and effective state.

Compatibility: older versions used `pi-chrome-dev-tools-settings.json`.
A legacy-only file remains readable with a warning and is never modified automatically; rename it to `pi-chrome-dev-tools.json`.
The first subsequent settings save writes the canonical file.
If both files exist, `pi-chrome-dev-tools.json` wins and the legacy file is ignored.
The legacy filename is deprecated and will be removed in a future major release.

## 🧠 Use cases

- Debug front-end applications with an AI coding agent.
- Verify DOM state after code changes.
- Capture screenshots for visual inspection.
- Drive local browser workflows without a separate MCP server.
- Combine with Pi coding tools for end-to-end web app fixes.

## 🗂️ Package layout

```txt
packages/pi-chrome-dev-tools/
├── src/
│   ├── index.ts                # Pi package entrypoint
│   ├── chrome-devtools.ts      # Extension registration and command orchestration
│   ├── browser-manager.ts      # Endpoint attach, managed launch, and shutdown
│   ├── cdp-client.ts           # CDP WebSocket client
│   ├── lazy-tools.ts           # Deferred capability catalog and loader tool
│   ├── menu.ts                 # Tool availability workflow
│   ├── browser-settings-menu.ts # Browser connection settings workflow
│   ├── render.ts               # Compact tool result rendering and status
│   ├── runtime.ts              # Session runtime state
│   ├── screenshot.ts           # Safe screenshot path handling
│   ├── settings.ts             # Settings persistence and browser resolution
│   ├── tool-names.ts           # Capability tool name catalog
│   └── tool-selector.ts        # Tool transaction, status, and sanitization
├── test/unit/                  # node --test unit tests
├── README.md
├── LICENSE
├── package.json
└── tsconfig.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Sources load directly through Pi's TypeScript runtime; no build step exists.

### Differences from the reference implementation

This port of `@narumitw/pi-chrome-devtools` intentionally omits the experimental WebMCP domain (page-provided tools) and unpacked-extension launching.
It also uses the package-local settings filename `pi-chrome-dev-tools.json`, the profile prefix `pi-chrome-dev-tools-profile-`, and loads sources directly instead of a generated `dist/` bundle.

## 🔎 Keywords

Pi extension, Pi coding agent, Chrome DevTools Protocol, CDP, browser automation, web debugging, JavaScript evaluation, screenshot automation, AI coding agent tools.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).