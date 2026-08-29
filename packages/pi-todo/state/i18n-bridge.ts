/**
 * i18n bridge for pi-todo — single thin import surface so every call site
 * routes through one module.
 *
 * - `t(key, fallback)` looks up `locales/en.json` and returns the fallback
 *   when the key is missing. The signature mirrors the rpiv-i18n
 *   `scope(namespace)` style so a live locale provider can be swapped in later
 *   without touching call sites (the reference `@juicesharp/rpiv-todo` ships
 *   nine locales via its `@juicesharp/rpiv-i18n` peer; this port stays
 *   English-only).
 * - `formatStatusLabel(status)` resolves a TaskStatus to its label via the
 *   canonical `status.*` keys, with the English literal as fallback. This is
 *   the SINGLE point of localization for status words — overlay, /todos
 *   header, /todos render-call all route through here.
 *
 * The key set is documented in `locales/en.json`. Call sites MUST use this
 * module at render time — never bake the result into a top-level
 * `const X = formatStatusLabel(...)`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskStatus } from "../tool/types.ts";

export const I18N_NAMESPACE = "pi-todo";

type ScopeFn = (key: string, fallback: string) => string;

function loadEnglishLocale(): Record<string, string> {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return JSON.parse(readFileSync(join(here, "..", "locales", "en.json"), "utf-8")) as Record<string, string>;
	} catch {
		return {};
	}
}

const EN = loadEnglishLocale();

export const t: ScopeFn = (key, fallback) => EN[key] ?? fallback;

const STATUS_LABEL_PENDING = "pending";
const STATUS_LABEL_IN_PROGRESS = "in progress";
const STATUS_LABEL_COMPLETED = "completed";
const STATUS_LABEL_DELETED = "deleted";

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return t("status.pending", STATUS_LABEL_PENDING);
		case "in_progress":
			return t("status.in_progress", STATUS_LABEL_IN_PROGRESS);
		case "completed":
			return t("status.completed", STATUS_LABEL_COMPLETED);
		case "deleted":
			return t("status.deleted", STATUS_LABEL_DELETED);
	}
}