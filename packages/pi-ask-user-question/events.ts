/**
 * Public event contract for pi-ask-user-question.
 *
 * STABILITY POLICY — applies to every event in the `pi-ask-user-question:*` namespace.
 *
 *   1. Channel names are immutable. Once shipped, never rename.
 *   2. Payload changes are append-only. Listeners MUST tolerate unknown
 *      fields. New fields ship as optional (`?:`).
 *   3. Breaking changes (rename, retype, remove a field; change emission
 *      semantics) require a NEW channel, e.g. `pi-ask-user-question:prompt.v2`,
 *      with dual-emit during a deprecation window.
 *   4. No `version` field inside payloads. Version via channel name only.
 *   5. Payloads must be JSON-safe: primitives, arrays, plain objects.
 *      No Set/Map/Date/class instances — payloads must survive JSON
 *      serialization when listeners forward them across process or
 *      network boundaries.
 *
 * Naming: `pi-ask-user-question:<phase>`, lowercase, hyphen-separated.
 * Aligns with Pi's `"my-extension:status"` example.
 */

export const ASK_USER_PROMPT_EVENT = "pi-ask-user-question:prompt" as const;

export interface AskUserPromptEventPayload {
	questions: ReadonlyArray<AskUserPromptQuestion>;
}

/**
 * Emitted while the questionnaire is awaiting user input (TUI `ui.custom` and
 * RPC dialog walker). Cleared with `{ active: false }` in `finally` so listeners
 * can distinguish blocked-on-human from working.
 */
export const ASK_USER_BLOCKED_EVENT = "pi-ask-user-question:blocked" as const;

export interface AskUserBlockedEventPayload {
	/** True while input is awaited; false when the wait ends (answer, cancel, or error). */
	active: boolean;
}

export interface AskUserPromptQuestion {
	/** The full question text, exactly as the agent authored it. */
	question: string;
	/** The short chip/tag shown next to the question. */
	header: string;
	/** True iff the user may pick multiple options. Normalized from optional. */
	multiSelect: boolean;
	options: ReadonlyArray<AskUserPromptOption>;
}

export interface AskUserPromptOption {
	label: string;
	description: string;
	/** True iff the option carries rich preview content (content not shipped). */
	hasPreview: boolean;
}