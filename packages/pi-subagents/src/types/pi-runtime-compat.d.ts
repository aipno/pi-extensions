/**
 * Runtime-compat shim, modeled on nicobailon/pi-subagents
 * src/types/pi-runtime-compat.d.ts.
 *
 * pi's tool executor reads `isError` on tool results at runtime to color the
 * result as failed, but the shipped @earendil-works/pi-agent-core types do
 * not declare it. The augmentation keeps our code honest about the contract
 * we rely on.
 */
declare module "@earendil-works/pi-agent-core" {
	interface AgentToolResult<T> {
		/** Runtime error flag emitted and rendered by pi tool execution. */
		isError?: boolean;
	}
}

export {};