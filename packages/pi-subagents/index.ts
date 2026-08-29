/**
 * pi-subagents — entry point.
 *
 * Architecture modeled on nicobailon/pi-subagents:
 *
 *   index.ts (this file)
 *     └─ src/extension/index.ts   register tool / commands / renderers / events
 *          └─ src/runs/executor.ts  resolve agent, then run foreground or async
 *               └─ src/runs/execution.ts  spawn child `pi` (--mode json -p),
 *                                         stream JSONL events, extract result
 *               └─ src/runs/async.ts      detached background child + result files
 *          └─ src/agents/agents.ts  discover agent definitions (frontmatter .md)
 *
 * The child is another pi process launched non-interactively. The parent
 * decodes the child's JSONL event stream (message_end / tool_execution_* /
 * agent_settled) to report live progress, token usage and the final answer.
 *
 * Child subagent processes receive PI_SUBAGENT_CHILD=1 and skip the
 * parent-side runtime registration (see src/extension/index.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";

const registerParentExtension = process.env.PI_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	registerParentExtension?.(pi);
}