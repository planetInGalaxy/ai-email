#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const command = process.argv[2] || "help";
const passthrough = process.argv.slice(3);

const scripts = {
  install: "scripts/install.mjs",
  setup: "scripts/install.mjs",
  uninstall: "scripts/uninstall.mjs",
  doctor: "scripts/doctor.mjs",
  "check-models": "scripts/check-models.mjs",
  models: "scripts/check-models.mjs",
  validate: "scripts/validate-plugin.mjs",
};

if (command === "help" || command === "--help" || command === "-h") {
  console.log([
    "Usage: codex-pushdeer <command> [options]",
    "",
    "Commands:",
    "  install       Install plugin, configure Codex notify, and save PushDeer config",
    "  uninstall     Remove plugin and optional local config",
    "  doctor        Diagnose local Codex PushDeer setup",
    "  check-models  Detect Codex summary model and optionally write config",
    "  validate      Validate plugin structure",
  ].join("\n"));
  process.exit(0);
}

const script = scripts[command];
if (!script) {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, [path.join(root, script), ...passthrough], {
  stdio: "inherit",
});
process.exit(result.status || 0);
