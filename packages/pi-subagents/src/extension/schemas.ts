/**
 * TypeBox schema for the `subagent` tool parameters.
 */

import { Type } from "typebox";

export const createSubagentParamsSchema = () =>
	Type.Object({
		agent: Type.String({ description: "Subagent to run. Builtins: scout, worker, reviewer, oracle, researcher, delegate. Custom agents can be added as .md files in .pi/subagents/ (project) or ~/.pi/agent/subagents/ (user)." }),
		task: Type.String({ description: "The task for the subagent. Be concrete: what to inspect, produce, or change; which files matter; what the final response should contain." }),
		instructions: Type.Optional(Type.String({ description: "Optional extra run instructions appended to the agent prompt for this call only." })),
		async: Type.Optional(Type.Boolean({ description: "Run in the background. Default: follows the extension config (asyncByDefault). Foreground streams progress into this conversation." })),
		model: Type.Optional(Type.String({ description: "Override the model for this child (provider/model, optionally :thinking). Default: inherit the parent model." })),
		thinking: Type.Optional(Type.String({ enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Override the thinking level for this child." })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Override the tool allowlist for this child (e.g. [\"read\", \"grep\", \"bash\"])." })),
		context: Type.Optional(Type.String({ enum: ["fork", "fresh"], description: "\"fork\" seeds the child session with a pruned copy of this conversation so it can honor decisions already made. Default: the agent's defaultContext." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Foreground timeout in milliseconds. Omit to use the configured default (no timeout by default)." })),
	});