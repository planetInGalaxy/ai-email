#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DESP_MAX_CHARS,
  DEFAULT_DESP_SEPARATOR,
  configPath as pushdeerConfigPath,
  DEFAULT_LLM_TIMEOUT_MS,
  loadConfig as loadPushdeerConfig,
  normalizeDespMaxChars,
  normalizeDespSeparator,
  saveConfigPatch,
} from "../plugins/codex-pushdeer-notifier/scripts/pushdeer-lib.mjs";
import { chooseSummaryModel } from "./model-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(projectRoot, "plugins", "codex-pushdeer-notifier");
const notifyScript = path.join(pluginRoot, "scripts", "pushdeer-notify-event.mjs");
const setupScript = path.join(pluginRoot, "scripts", "setup-pushdeer-key.mjs");
const marketplaceName = "codex-pushdeer";
const pluginName = "codex-pushdeer-notifier";

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    if (eq > 2) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs();

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codexConfigPath() {
  return path.join(codexHome(), "config.toml");
}

function run(command, commandArgs, { allowFailure = false } = {}) {
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

function ensureCommand(command, versionArgs = ["--version"]) {
  const result = spawnSync(command, versionArgs, {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`Missing required command: ${command}`);
    process.exit(1);
  }
}

async function confirm(question) {
  if (args.yes) return true;
  if (!input.isTTY) return false;

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function desiredNotifyLine() {
  return `notify = ${JSON.stringify(["node", notifyScript])}`;
}

function replaceTopLevelNotify(contents, replacementLine, force) {
  const lines = contents.split(/\r?\n/);
  let firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTableIndex === -1) firstTableIndex = lines.length;

  for (let i = 0; i < firstTableIndex; i += 1) {
    const line = lines[i];
    if (!/^\s*notify\s*=/.test(line)) continue;
    if (line.trim() === replacementLine) {
      return { contents, changed: false, reason: "notify already configured" };
    }
    if (!force) {
      return {
        contents,
        changed: false,
        conflict: line.trim(),
      };
    }
    lines[i] = replacementLine;
    return {
      contents: lines.join("\n").replace(/\n*$/u, "\n"),
      changed: true,
      reason: "notify replaced",
    };
  }

  lines.splice(firstTableIndex, 0, replacementLine, "");
  return {
    contents: lines.join("\n").replace(/\n*$/u, "\n"),
    changed: true,
    reason: "notify inserted",
  };
}

async function configureNotify() {
  if (args["skip-notify"]) {
    console.log("Skipped Codex notify configuration.");
    return;
  }

  const configFile = codexConfigPath();
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  let force = Boolean(args["force-notify"]);
  let result = replaceTopLevelNotify(existing, desiredNotifyLine(), force);

  if (result.conflict) {
    console.log(`Existing top-level notify found: ${result.conflict}`);
    const ok = await confirm("Replace it with the PushDeer notifier?");
    if (!ok) {
      console.error("Refusing to overwrite existing notify. Re-run with --force-notify to replace it.");
      process.exit(2);
    }
    force = true;
    result = replaceTopLevelNotify(existing, desiredNotifyLine(), force);
  }

  if (!result.changed) {
    console.log(`Codex notify unchanged: ${result.reason}`);
    return;
  }

  if (args["dry-run"]) {
    console.log(`[dry-run] write ${configFile}`);
    return;
  }

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, result.contents, "utf8");
  console.log(`Configured Codex notify in ${configFile}`);
}

function installPlugin() {
  ensureCommand("node");
  ensureCommand("codex");

  const listBefore = run("codex", ["plugin", "marketplace", "list"], { allowFailure: true });
  if (!listBefore.stdout.includes(marketplaceName)) {
    const added = run("codex", ["plugin", "marketplace", "add", projectRoot], {
      allowFailure: true,
    });
    if (added.status !== 0) {
      const outputText = `${added.stdout}\n${added.stderr}`;
      if (!/already|exists|duplicate/i.test(outputText)) {
        process.stderr.write(outputText);
        process.exit(added.status || 1);
      }
    }
  }

  run("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`]);
  console.log(`Installed ${pluginName}@${marketplaceName}`);
}

function configurePushDeerKey() {
  if (args["skip-key"]) {
    console.log("Skipped PushDeer key configuration.");
    return;
  }

  const current = loadPushdeerConfig();
  const hasExplicitKey = args.key || args.stdin || process.env.PUSHDEER_KEY || process.env.CODEX_PUSHDEER_KEY;
  if (current.pushkey && !args["force-key"] && !hasExplicitKey) {
    console.log(`PushDeer key already configured in ${pushdeerConfigPath()}`);
    return;
  }

  const setupArgs = [setupScript];
  if (args.key) setupArgs.push("--key", String(args.key));
  if (args.stdin) setupArgs.push("--stdin");
  if (args.test) setupArgs.push("--test");
  if (args["dry-run"]) setupArgs.push("--dry-run");

  run(process.execPath, setupArgs);
}

function configureSummaryModel() {
  if (args["skip-model-check"]) {
    console.log("Skipped summary model detection.");
    return;
  }

  const current = loadPushdeerConfig();
  const timeoutMs = Number.parseInt(
    args["llm-timeout-ms"] || args.timeout || current.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS,
    10,
  );
  const selection = chooseSummaryModel({
    preferredModel: args["summary-model"] || args.model || current.summaryModel || "",
  });
  const summaryModel = selection.model;
  const llmTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_LLM_TIMEOUT_MS;

  if (!summaryModel) {
    console.log("No summary model was detected; runtime fallback will use the built-in default.");
    return;
  }

  if (args["dry-run"]) {
    console.log(`[dry-run] write summaryModel=${summaryModel}, llmTimeoutMs=${llmTimeoutMs} to ${pushdeerConfigPath()}`);
    return;
  }

  saveConfigPatch({
    summaryModel,
    llmTimeoutMs,
  });
  console.log(`Configured summary model ${summaryModel} (${llmTimeoutMs}ms timeout)`);
  if (selection.catalogError) {
    console.log(`Model detection warning: ${selection.catalogError}`);
  }
}

function configureDespMaxChars() {
  const hasExplicitValue =
    args["desp-max-chars"] !== undefined ||
    args["desp-max"] !== undefined ||
    args["max-desp-chars"] !== undefined ||
    args["no-desp"];

  if (!hasExplicitValue) {
    return;
  }

  const rawValue = args["no-desp"]
    ? 0
    : args["desp-max-chars"] ?? args["desp-max"] ?? args["max-desp-chars"] ?? DEFAULT_DESP_MAX_CHARS;
  const despMaxChars = normalizeDespMaxChars(rawValue);

  if (args["dry-run"]) {
    console.log(`[dry-run] write despMaxChars=${despMaxChars} to ${pushdeerConfigPath()}`);
    return;
  }

  saveConfigPatch({ despMaxChars });
  console.log(`Configured PushDeer desp max length ${despMaxChars} chars`);
}

function configureDespSeparator() {
  const hasExplicitValue =
    args["desp-separator"] !== undefined ||
    args.separator !== undefined ||
    args["no-desp-separator"];

  if (!hasExplicitValue) {
    return;
  }

  const rawValue = args["no-desp-separator"]
    ? ""
    : args["desp-separator"] ?? args.separator ?? DEFAULT_DESP_SEPARATOR;
  const despSeparator = normalizeDespSeparator(rawValue);

  if (args["dry-run"]) {
    console.log(`[dry-run] write despSeparator=${JSON.stringify(despSeparator)} to ${pushdeerConfigPath()}`);
    return;
  }

  saveConfigPatch({ despSeparator });
  console.log(`Configured PushDeer desp separator ${JSON.stringify(despSeparator)}`);
}

installPlugin();
await configureNotify();
configureSummaryModel();
configureDespMaxChars();
configureDespSeparator();
configurePushDeerKey();

console.log("");
console.log("Installation complete.");
console.log("Start a new Codex thread or restart Codex to make sure the updated plugin and notify setting are active.");
console.log("Use `npm run doctor` to check local setup.");
