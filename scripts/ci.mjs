#!/usr/bin/env node
/**
 * Cross-platform CI runner for the pi-extensions monorepo.
 *
 * Discovers every package under packages/ and runs, per package:
 *   1. npm install
 *   2. npm run typecheck
 *   3. npm test
 *
 * Runs on Linux, macOS and Windows (uses npm.cmd on win32). No shell
 * scripting is involved, so the same entry point works from bash, pwsh
 * and cmd alike — the GitHub Actions workflow calls this directly.
 *
 * Usage:
 *   node scripts/ci.mjs                     # install + typecheck + test
 *   node scripts/ci.mjs --stages typecheck  # only typecheck
 *   node scripts/ci.mjs --only pi-todo      # only the pi-todo package
 *   node scripts/ci.mjs --pool 1 --timeout 120000
 *
 * Exit code is non-zero if any stage of any package failed.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const STAGES = ["install", "typecheck", "test"];

// --- argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const options = {
    stages: new Set(STAGES),
    only: [],
    pool: 3,
    timeoutMs: 20 * 60 * 1000,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--stages":
        options.stages = new Set(argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--only":
        options.only.push(argv[++i]);
        break;
      case "--pool":
        options.pool = Number(argv[++i]);
        break;
      case "--timeout":
        options.timeoutMs = Number(argv[++i]);
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node scripts/ci.mjs [--stages ${STAGES.join(",")}] [--only <pkg>] [--pool N] [--timeout MS] [--verbose]`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }
  for (const stage of options.stages) {
    if (!STAGES.includes(stage)) {
      console.error(`Unknown stage "${stage}" (expected one of: ${STAGES.join(", ")})`);
      process.exit(2);
    }
  }
  if (options.pool < 1) options.pool = 1;
  return options;
}

// --- package discovery ------------------------------------------------------

function discoverPackages(only) {
  const packages = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(PACKAGES_DIR, entry.name);
    const manifestPath = join(packagePath, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const name = manifest.name ?? entry.name;
    if (only.length > 0 && !only.includes(name) && !only.includes(entry.name)) continue;
    const scripts = manifest.scripts ?? {};
    packages.push({
      name,
      dir: packagePath,
      hasTypecheck: typeof scripts.typecheck === "string",
      hasTest: typeof scripts.test === "string",
    });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

// --- stage execution --------------------------------------------------------

function runCommand(packageInfo, args, options, label) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(NPM, args, {
      cwd: packageInfo.dir,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      windowsHide: true,
    });
    const maxBuffered = 256 * 1024; // keep a rolling tail in memory
    const chunks = [];
    let settled = false;

    const collect = (chunk) => {
      chunks.push(chunk);
      let total = chunks.reduce((sum, c) => sum + c.length, 0);
      while (total > maxBuffered && chunks.length > 0) {
        const dropped = chunks.shift();
        total -= dropped.length;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false, `timed out after ${Math.round(options.timeoutMs / 1000)}s`);
    }, options.timeoutMs);

    const finish = (ok, reason = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[${packageInfo.name}] ${label} ${ok ? "ok" : "FAILED"} (${seconds}s${reason ? `, ${reason}` : ""})`,
      );
      if (!ok) {
        const tail = Buffer.concat(chunks).toString("utf8");
        if (tail.trim().length > 0) {
          const lines = tail.split("\n");
          console.log(lines.slice(-80).join("\n"));
          if (tail.length > maxBuffered) console.log("… (output truncated)");
          console.log("");
        }
      }
      resolvePromise(ok);
    };

    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code) => finish(code === 0 && !settled))
  });
}

async function runStagesForPackage(packageInfo, options) {
  const results = [];
  if (options.stages.has("install")) {
    results.push(["install", await runCommand(packageInfo, ["install"], options, "install")]);
  }
  if (options.stages.has("typecheck")) {
    if (packageInfo.hasTypecheck) {
      results.push(["typecheck", await runCommand(packageInfo, ["run", "typecheck"], options, "typecheck")]);
    } else {
      console.log(`[${packageInfo.name}] typecheck skipped (no script)`);
      results.push(["typecheck", true]);
    }
  }
  if (options.stages.has("test")) {
    if (packageInfo.hasTest) {
      results.push(["test", await runCommand(packageInfo, ["test"], options, "test")]);
    } else {
      console.log(`[${packageInfo.name}] test skipped (no script)`);
      results.push(["test", true]);
    }
  }
  return results;
}

// --- pool -------------------------------------------------------------------

async function runPool(items, worker, poolSize) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(poolSize, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- main -------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packages = discoverPackages(options.only);
  if (packages.length === 0) {
    console.error("No packages found (use --only with a valid package name?)");
    process.exit(2);
  }

  console.log(`pi-extensions CI: ${packages.length} package(s), stages: ${[...options.stages].join(", ")}, pool: ${options.pool}`);
  console.log("");

  const started = Date.now();
  const perPackage = await runPool(packages, (packageInfo) => runStagesForPackage(packageInfo, options), options.pool);

  console.log("");
  console.log("─".repeat(60));
  let failed = 0;
  for (let i = 0; i < packages.length; i++) {
    const failures = perPackage[i].filter(([, ok]) => !ok);
    for (const [stage] of failures) console.log(`FAIL  ${packages[i].name}: ${stage}`);
    if (failures.length > 0) failed++;
  }
  const totalSeconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failed === 0) {
    console.log(`All ${packages.length} package(s) passed in ${totalSeconds}s.`);
    process.exit(0);
  } else {
    console.log(`${failed}/${packages.length} package(s) failed in ${totalSeconds}s.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});