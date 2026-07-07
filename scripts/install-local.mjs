#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const installScript = path.join(path.dirname(__filename), "install.mjs");
const result = spawnSync(process.execPath, [installScript, ...process.argv.slice(2)], {
  stdio: "inherit",
});

process.exit(result.status || 0);
