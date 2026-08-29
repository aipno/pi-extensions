import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = process.argv.slice(2);
const __dirname = dirname(fileURLToPath(import.meta.url));

const EXAMPLE_DIR = join(__dirname, "examples", "interactive-visualizer");

function run(script, scriptArgs = [], cwd = process.cwd()) {
  const commandArgs = ["run", script];
  if (scriptArgs.length > 0) commandArgs.push("--", ...scriptArgs);
  const result = spawnSync(npm, commandArgs, {
    cwd,
    stdio: "inherit",
    // npm.cmd is not directly spawnable on Windows (spawn EINVAL);
    // cmd.exe must execute the .cmd shim.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return process.exitCode === 0;
}

/**
 * __tests__/interactive-visualizer-server.test.ts asserts on the example's
 * built artifacts (dist/server.js, dist/app.html), which are gitignored and
 * therefore absent on a fresh checkout/CI runner. Build the example on demand
 * so `npm test` is self-sufficient everywhere.
 */
function ensureExampleBuilt() {
  if (existsSync(join(EXAMPLE_DIR, "dist", "server.js"))) return;
  console.log("interactive-visualizer dist/ missing — installing and building the example…");
  for (const commandArgs of [["install"], ["run", "build"]]) {
    const result = spawnSync(npm, commandArgs, {
      cwd: EXAMPLE_DIR,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  }
}

ensureExampleBuilt();

if (args.length > 0) {
  run("test:vitest", args);
} else if (run("test:vitest")) {
  run("test:public-exports");
}