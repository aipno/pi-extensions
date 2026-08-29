/**
 * i18n bridge for pi-ask-user-question — single thin import surface so every
 * call site routes through one place.
 *
 * - `t(key, fallback)` returns the canonical English fallback at every call
 *   site. The signature mirrors the rpiv-i18n `scope(namespace)` style so a
 *   live locale provider can be swapped in later without touching call sites.
 * - `displayLabel(kind)` resolves a sentinel kind to its (English) label via
 *   `ROW_INTENT_META[kind].label` — single source of truth.
 *
 * The key set is documented in `locales/en.json`. Call sites MUST use this
 * module at render time — never bake the result into a top-level
 * `const X = displayLabel(...)`.
 *
 * Reserved-label validation stays English-locked: `RESERVED_LABEL_SET` checks
 * the canonical `ROW_INTENT_META[kind].label`, never `displayLabel(kind)`.
 */

import { ROW_INTENT_META, type SentinelKind } from "./row-intent.ts";

export const I18N_NAMESPACE = "pi-ask-user-question";

type ScopeFn = (key: string, fallback: string) => string;

export const t: ScopeFn = (_key, fallback) => fallback;

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}