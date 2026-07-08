#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(projectRoot, "plugins", "agentping");
const notifyScript = path.join(pluginRoot, "scripts", "pushdeer-notify-event.mjs");
const legacyNotifyScript = path.join(
  projectRoot,
  "plugins",
  "codex-pushdeer-notifier",
  "scripts",
  "pushdeer-notify-event.mjs",
);
const setupScript = path.join(pluginRoot, "scripts", "setup-pushdeer-key.mjs");
const marketplaceName = "agentping";
const pluginName = "agentping";
const legacyMarketplaceName = "codex-pushdeer";
const legacyPluginName = "codex-pushdeer-notifier";

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    args[item.slice(2)] = true;
  }
  return args;
}

const args = parseArgs();

function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

function run(command, commandArgs, { allowFailure = true } = {}) {
  if (args["dry-run"]) {
    console.log(`[dry-run] ${[command, ...commandArgs].join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }

  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(result.stderr || result.stdout || "");
    process.exit(result.status || 1);
  }

  return result;
}

function removeNotifyLine() {
  const configFile = codexConfigPath();
  if (!fs.existsSync(configFile)) return;

  const desiredLine = `notify = ${JSON.stringify(["node", notifyScript])}`;
  const legacyLine = `notify = ${JSON.stringify(["node", legacyNotifyScript])}`;
  const lines = fs.readFileSync(configFile, "utf8").split(/\r?\n/);
  const next = lines.filter((line) => ![desiredLine, legacyLine].includes(line.trim()));
  if (next.length === lines.length) {
    console.log("Codex notify was not changed because it does not point at this checkout.");
    return;
  }

  if (args["dry-run"]) {
    console.log(`[dry-run] remove AgentPing notify from ${configFile}`);
    return;
  }

  fs.writeFileSync(configFile, next.join("\n").replace(/\n*$/u, "\n"), "utf8");
  console.log(`Removed AgentPing notify from ${configFile}`);
}

run("codex", ["plugin", "remove", `${pluginName}@${marketplaceName}`]);
run("codex", ["plugin", "remove", `${legacyPluginName}@${legacyMarketplaceName}`]);
if (args["remove-marketplace"]) {
  run("codex", ["plugin", "marketplace", "remove", marketplaceName]);
  run("codex", ["plugin", "marketplace", "remove", legacyMarketplaceName]);
}
removeNotifyLine();

if (args["forget-key"]) {
  run(process.execPath, [setupScript, "--unset"], { allowFailure: false });
} else {
  console.log("PushDeer key was left in place. Re-run with --forget-key to remove it.");
}

console.log("Uninstall complete.");
