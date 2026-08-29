/**
 * Names of the agents shipped inside this package (agents/*.md).
 */
export const BUILTIN_AGENT_NAMES = [
	"delegate",
	"oracle",
	"researcher",
	"reviewer",
	"scout",
	"worker",
] as const;

export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];