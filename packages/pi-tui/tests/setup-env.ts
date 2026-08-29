/**
 * 测试环境 setup：node --test 通过 `--import` 预加载（对每个测试子进程生效）。
 *
 * 测试断言大量英文 UI 文案（"Ran for 9s" / "Thought for" / "Working..." 等），
 * 而 config.language 初始来自用户的 ~/.pi/agent/pi-tui.json —— 用户切到 zh 后
 * 这些测试会在中文文案上失败。这里把语言钉死为 en，与磁盘配置解耦。
 * i18n 语言行为本身由 tests/i18n.test.ts / agent-summary.test.ts 的双语用例覆盖。
 */
import { config } from "../extensions/config/config.ts";

config.language = "en";