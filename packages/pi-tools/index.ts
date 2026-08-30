/**
 * pi-tools — Pi extension replacing pi's built-in file tools with
 * self-implemented versions (omp-style):
 *
 * - grep   — pure-TS search engine, gitignore-aware, with optional ripgrep fast path
 * - read   — text/offset/limit + SQLite preview + ZIP/TAR archive reading + images
 * - write  — atomic writes through pi's per-file mutation queue
 * - find   — own glob engine over the gitignore-aware walker
 * - ls     — own directory listing
 * - edit   — exact-text multi-edit with fuzzy fallback, display diff + unified patch
 *
 * Same-name registration overrides pi's built-ins (extension tools shadow
 * built-ins in the tool registry). `/tools` shows status and toggles tools at
 * runtime; defaults are configured in `pi-tools.json` (see config.ts).
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { isToolEnabled, loadConfig, runtimeOverrides, TOOL_NAMES, type ToolName } from "./config.ts";
import { registerEditTool } from "./tools/edit.ts";
import { registerFindTool } from "./tools/find.ts";
import { registerGrepTool } from "./tools/grep.ts";
import { registerLsTool } from "./tools/ls.ts";
import { registerReadTool } from "./tools/read.ts";
import { registerWriteTool } from "./tools/write.ts";

export { loadConfig, type PiToolsConfig } from "./config.ts";

export default function registerPiTools(pi: ExtensionAPI): void {
	const config = loadConfig();

	// --- tool registration (same names shadow pi's built-ins) ---
	if (isToolEnabled("grep")) {
		registerGrepTool(pi, { rgFirst: config.grep?.rgFirst ?? true });
	}
	if (isToolEnabled("read")) {
		registerReadTool(pi);
	}
	if (isToolEnabled("write")) {
		registerWriteTool(pi);
	}
	if (isToolEnabled("find")) {
		registerFindTool(pi);
	}
	if (isToolEnabled("ls")) {
		registerLsTool(pi);
	}
	if (isToolEnabled("edit")) {
		registerEditTool(pi);
	}

	// --- /tools command: status + runtime toggling ---
	pi.registerCommand("tools", {
		description: "Show which built-in tools pi-tools overrides and toggle them at runtime",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "enable" || arg === "disable") {
				ctx.ui.notify("Usage: /tools enable|disable <name>", "error");
				return;
			}
			const [verb, name] = arg.split(/\s+/, 2);
			if (verb === "enable" || verb === "disable") {
				if (!name || !(TOOL_NAMES as readonly string[]).includes(name)) {
					ctx.ui.notify(`Unknown tool: ${name}. Known: ${TOOL_NAMES.join(", ")}`, "error");
					return;
				}
				const enabled = verb === "enable";
				runtimeOverrides.tools.set(name as ToolName, enabled);
				const active = new Set(pi.getActiveTools());
				if (enabled) active.add(name);
				else active.delete(name);
				pi.setActiveTools([...active]);
				ctx.ui.notify(`pi-tools: ${enabled ? "enabled" : "disabled"} ${name}`, "info");
				return;
			}

			// Status listing.
			const all = pi.getAllTools();
			const active = new Set(pi.getActiveTools());
			const lines: string[] = [`Config: ${join(getAgentDir(), "pi-tools.json")}`];
			for (const name of TOOL_NAMES) {
				const ours = all.find((t) => t.name === name);
				const isOurs = ours !== undefined && ours.sourceInfo.source !== "builtin";
				const state = active.has(name) ? "active" : "off";
				lines.push(`  ${name.padEnd(6)} ${isOurs ? "pi-tools (override)" : "builtin (not overridden)"} [${state}]`);
			}
			lines.push("Toggle: /tools enable|disable <name> (runtime only; edit pi-tools.json to persist)");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}