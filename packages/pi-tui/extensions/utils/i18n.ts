/**
 * i18n 双语显示（en/zh）—— pi-tui 插件自身 UI 文案的翻译桥。
 *
 * - `t(key, fallback, vars?)` 按 `config.language` 选择语言表；zh 缺键 → en 兜底 → fallback 兜底。
 *   模板变量用 `{name}` 占位，vars 提供替换；调用点必须依赖渲染路径（渲染时调用），
 *   不可 bake 进顶层 const（语言可在运行期由 /tui-style language= 切换）。
 * - 键集以 `locales/en.json` 为权威；`locales/zh.json` 键集必须与 en 完全一致
 *   （tests/i18n.test.ts 遍历断言，防漏翻）。
 *
 * 依赖方向：utils/i18n → config（读 config.language）；config 不反向依赖 i18n。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config/config.ts";

type LocaleTable = Record<string, string>;

function loadLocale(lang: string): LocaleTable {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return JSON.parse(readFileSync(join(here, "..", "..", "locales", `${lang}.json`), "utf8")) as LocaleTable;
	} catch {
		return {};
	}
}

const EN = loadLocale("en");
const ZH = loadLocale("zh");

export type TranslateVars = Record<string, string | number>;

function substitute(template: string, vars?: TranslateVars): string {
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		vars[name] !== undefined ? String(vars[name]) : match,
	);
}

/**
 * 取当前语言的翻译：`{lang} 表 → en 表 → fallback`。
 * 渲染路径调用；语言切换即时生效。
 */
export function t(key: string, fallback: string, vars?: TranslateVars): string {
	const lang = config.language === "zh" ? "zh" : "en";
	const table = lang === "zh" ? ZH : EN;
	const value = table[key];
	if (value !== undefined) return substitute(value, vars);
	if (lang === "zh" && EN[key] !== undefined) return substitute(EN[key]!, vars);
	return substitute(fallback, vars);
}

/** zh 表缺键时回退 en——多语言的前置断言，测试与调试用。 */
export function hasKey(key: string, lang: "en" | "zh" = "en"): boolean {
	return (lang === "zh" ? ZH : EN)[key] !== undefined;
}