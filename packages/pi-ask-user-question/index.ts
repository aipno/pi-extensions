/**
 * pi-ask-user-question — Pi extension. Registers the `ask_user_question`
 * tool: a structured option selector with an automatically appended
 * `Type something.` custom-answer row.
 *
 * Sentinel labels and TUI chrome strings localize at render time via the i18n
 * bridge (`state/i18n-bridge.ts`). Strings are documented in `locales/en.json`
 * (the canonical key set); the bridge's `t(key, fallback)` returns the inline
 * English literal at every call site. The extension stays online without any
 * i18n provider.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";
import { registerAskUserQuestionReconciler } from "./reconcile.ts";

export {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./events.ts";

export default function (pi: ExtensionAPI) {
	registerAskUserQuestionTool(pi);
	registerAskUserQuestionReconciler(pi);
}