/**
 * Slash commands.
 *
 * Learned from nicobailon/pi-subagents src/slash/slash-commands.ts:
 * commands are thin bridges to the shared executor, and their output is
 * delivered as custom message types with dedicated renderers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentExecutor } from "../runs/executor.ts";
import { DEFAULT_FORK_MAX_TURNS } from "../runs/fork-context.ts";
import { applyConfigUpdates, configPath, loadConfig, parseConfigUpdates, readConfigFile } from "../extension/config.ts";
import type { SubagentConfig } from "../extension/config.ts";
import { openConfigEditor, modelsFromContext } from "../tui/config-editor.ts";
import { SUBAGENTS_RUN_MESSAGE_TYPE, SUBAGENTS_CONFIG_MESSAGE_TYPE, SUBAGENT_RUN_RESULT_MESSAGE_TYPE } from "../shared/types.ts";

export function registerSlashCommands(pi: ExtensionAPI, deps: { executor: SubagentExecutor; config: SubagentConfig }): void {
	const executor = () => deps.executor;

	pi.registerCommand("subagents-runs", {
		description: "List recent background subagent runs and their status",
		handler: async (_args, _ctx) => {
			const runs = executor().listRuns();
			pi.sendMessage(
				{
					customType: SUBAGENTS_RUN_MESSAGE_TYPE,
					content: `${runs.length} subagent runs`,
					details: { runs },
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	/** Build the config card details from the effective + file-stored values. */
	const configDetails = () => {
		const effective = loadConfig();
		const file = readConfigFile();
		const entries = [
			{
				key: "asyncByDefault",
				value: String(effective.asyncByDefault),
				source: file.asyncByDefault !== undefined ? ("file" as const) : ("default" as const),
			},
			{
				key: "defaultModel",
				value: effective.defaultModel ?? "inherit (parent session)",
				source: file.defaultModel !== undefined ? ("file" as const) : ("default" as const),
			},
			{
				key: "defaultTimeoutMs",
				value: effective.defaultTimeoutMs === undefined ? "unset (no timeout)" : `${effective.defaultTimeoutMs} ms`,
				source: file.defaultTimeoutMs !== undefined ? ("file" as const) : ("default" as const),
			},
			{
				key: "maxSubagentDepth",
				value: String(effective.maxSubagentDepth),
				source: file.maxSubagentDepth !== undefined ? ("file" as const) : ("default" as const),
			},
			{
				key: "runsRetentionDays",
				value: String(effective.runsRetentionDays),
				source: file.runsRetentionDays !== undefined ? ("file" as const) : ("default" as const),
			},
			{
				key: "forkContext",
				value: `pruned (maxTurns: ${effective.forkContext?.maxTurns ?? DEFAULT_FORK_MAX_TURNS})`,
				source: file.forkContext !== undefined ? ("file" as const) : ("default" as const),
			},
		];
		return { path: configPath(), entries };
	};

	pi.registerCommand("subagents-config", {
		description:
			"Show subagent config, or update it: /subagents-config [key=value ...]. Keys: asyncByDefault, defaultTimeoutMs, maxSubagentDepth, runsRetentionDays, forkContext.maxTurns",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				// Interactive settings-style editor when a TUI is available;
				// otherwise fall back to the read-only config card.
				if (ctx.hasUI) {
					const models = await modelsFromContext(ctx.scopedModels, ctx.modelRegistry);
					await openConfigEditor(ctx.ui, deps.config, models);
					return;
				}
				pi.sendMessage(
					{
						customType: SUBAGENTS_CONFIG_MESSAGE_TYPE,
						content: "Subagent config",
						details: configDetails(),
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}
			const tokens = trimmed.split(/\s+/).filter(Boolean);
			const parsed = parseConfigUpdates(tokens);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const error = applyConfigUpdates(deps.config, parsed.updates);
			if (error) {
				ctx.ui.notify(error, "error");
				return;
			}
			const applied = Object.keys(parsed.updates).join(", ");
			pi.sendMessage(
				{
					customType: SUBAGENTS_CONFIG_MESSAGE_TYPE,
					content: `Subagent config updated (${applied})`,
					details: {
						...configDetails(),
						message: `Updated: ${applied} — effective immediately, saved to config file.`,
					},
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("run", {
		description: "Run a subagent: /run <agent> <task...> (--async runs in the background)",
		getArgumentCompletions: (prefix) => {
			const names = executor().listAgents(process.cwd()).agents
				.flatMap((agent) => [agent.name, ...(agent.aliases ?? [])]);
			const match = prefix.toLowerCase();
			return names
				.filter((name) => name.toLowerCase().startsWith(match))
				.slice(0, 20)
				.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /run <agent> <task...>", "warning");
				return;
			}
			let async = false;
			let rest = trimmed;
			if (rest.startsWith("--async")) {
				async = true;
				rest = rest.slice("--async".length).trim();
			}
			const [agentName, ...taskParts] = rest.split(/\s+/);
			if (!agentName || taskParts.length === 0) {
				ctx.ui.notify("Usage: /run <agent> <task...>", "warning");
				return;
			}
			const task = taskParts.join(" ");
			try {
				const result = await deps.executor.execute(
					`/run-${Date.now()}`,
					{ agent: agentName, task, async },
					// H2: a never-aborted signal is strictly worse than none — it
					// looks cancellable but can never fire. Commands have no
					// cancellation source; runSync's own exit/timeout paths
					// (and defaultTimeoutMs when configured) cover hangs.
					undefined,
					undefined,
					ctx,
				);
				const text = typeof result.content === "string" ? result.content : result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
				pi.sendMessage(
					{
						customType: SUBAGENT_RUN_RESULT_MESSAGE_TYPE,
						content: text,
						details: result.details ?? { mode: "single", results: [], progress: [] },
						display: true,
					},
					{ triggerTurn: true },
				);
			} catch (error) {
				ctx.ui.notify(`Subagent failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}