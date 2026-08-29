/**
 * 回归测试：#issue — panel 模式下 Language 切换未持久化。
 *
 * 根因：onSettingChange 的 switch 缺失 `case "language"`，落入 default 直接 return，
 * updateConfig 从未被调用（仅 SettingsList 显示层改了 currentValue）。
 *
 * 本测试驱动真实 showCcstylePanel 交互链路：
 * Tab×3 切到 UI 页签 → Enter 选中 Language 项 → 断言 config.language 与磁盘配置同步。
 * 磁盘配置在测试前后备份/恢复，避免污染用户全局配置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { config } from "../extensions/config/config.ts";
import { showCcstylePanel } from "../extensions/config/panel.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "pi-tui.json");

initTheme("dark");

test("panel UI 页签 Language 项切换：updateConfig 生效并持久化到 pi-tui.json", async () => {
	const existed = existsSync(CONFIG_PATH);
	const backup = existed ? readFileSync(CONFIG_PATH, "utf8") : null;
	const previousLanguage = config.language;
	let component: { handleInput?: (data: string) => void } | undefined;

	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				component = factory(
					{ terminal: { columns: 80, rows: 30 }, requestRender() {} },
					{ fg: (s: string) => s, bold: (s: string) => s, dim: (s: string) => s },
					null,
					() => {},
				);
			},
			notify: () => {},
			requestRender: () => {},
		},
	};
	const hooks = { applyStyleMode: () => {}, refreshCurrentTranscript: () => {} };

	try {
		const done = showCcstylePanel(ctx as any, hooks as any, undefined, undefined);
		assert.ok(component, "panel 工厂已捕获");
		// style → diff → thinking → UI（4 个页签，目标索引 3）。
		for (let i = 0; i < 3; i++) component!.handleInput!("\t");
		// Enter 激活 Language 项：values ["en","zh"] 从 en 循环到 zh。
		component!.handleInput!("\r");

		assert.equal(config.language, "zh", "config.language 应即时更新");
		const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
		assert.equal(onDisk.language, "zh", "pi-tui.json 应持久化 language=zh");

		// 再切一次（zh → en），验证继续可保存。
		component!.handleInput!("\r");
		assert.equal(config.language, "en");
		assert.equal(
			(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>).language,
			"en",
		);
		await done;
	} finally {
		config.language = previousLanguage;
		if (existed) {
			writeFileSync(CONFIG_PATH, backup!);
		} else {
			try {
				unlinkSync(CONFIG_PATH);
			} catch {
				// 原本不存在，无需清理。
			}
		}
	}
});