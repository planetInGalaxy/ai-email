#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DESP_MAX_CHARS,
  DEFAULT_DESP_SEPARATOR,
  DEFAULT_FINAL_WAIT_MS,
  DEFAULT_LOG_KEEP_FILES,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_MIN_DURATION_MS,
  DEFAULT_NOTIFY_MODE,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_MIN_CHARS,
  NOTIFY_MODES,
  configPath as agentpingConfigPath,
  configSourcePath,
  loadConfig,
  redactText,
  statePath,
  takeChars,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";
import { chooseSummaryModel, codexConfigPath } from "./model-utils.mjs";
import {
  notifyCommandForScript,
  notifyConfigStatus,
} from "./notify-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const notifyScript = path.join(
  projectRoot,
  "plugins",
  "agentping",
  "scripts",
  "pushdeer-notify-event.mjs",
);
const legacyNotifyScript = path.join(
  projectRoot,
  "plugins",
  "codex-pushdeer-notifier",
  "scripts",
  "pushdeer-notify-event.mjs",
);
const legacyNotifyMultiplexer = path.join(os.homedir(), ".codex", "notify-multiplexer.mjs");
const marketplaceName = "agentping";
const pluginId = "agentping@agentping";
const legacyPathFragments = [
  legacyNotifyScript,
  "/plugins/codex-pushdeer-notifier/scripts/pushdeer-notify-event.mjs",
  legacyNotifyMultiplexer,
  "/.codex/notify-multiplexer.mjs",
];

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes("--json"),
  };
}

const args = parseArgs();

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: "pipe",
    encoding: "utf8",
    timeout: options.timeout || 15_000,
    env: {
      ...process.env,
      AGENTPING_DISABLE_LLM_SUMMARY: "1",
      AGENTPING_SUPPRESS_NOTIFY: "1",
      CODEX_PUSHDEER_DISABLE_LLM_SUMMARY: "1",
      CODEX_PUSHDEER_SUPPRESS_NOTIFY: "1",
    },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function checkCommand(command, argsForVersion = ["--version"]) {
  const result = run(command, argsForVersion);
  return {
    ok: result.ok,
    detail: result.ok
      ? (result.stdout || result.stderr).split(/\n/)[0].trim()
      : (result.stderr || result.stdout || "not found").trim(),
  };
}

function notifyStatus() {
  const configFile = codexConfigPath();
  if (!fs.existsSync(configFile)) {
    return { ok: false, detail: `${configFile} does not exist` };
  }
  const contents = fs.readFileSync(configFile, "utf8");
  return notifyConfigStatus(contents, {
    desiredCommand: notifyCommandForScript(notifyScript),
    notifyScript,
    legacyCommands: [notifyCommandForScript(legacyNotifyScript)],
    legacyPathFragments,
  });
}

function marketplaceStatus() {
  const result = run("codex", ["plugin", "marketplace", "list"]);
  return {
    ok: result.ok && result.stdout.includes(marketplaceName),
    detail: result.ok ? (result.stdout.includes(marketplaceName) ? "registered" : "not registered") : result.stderr,
  };
}

function pluginStatus() {
  const result = run("codex", ["plugin", "list"]);
  return {
    ok: result.ok && result.stdout.includes(pluginId) && result.stdout.includes("enabled"),
    detail: result.ok
      ? (result.stdout.includes(pluginId) ? "installed" : "not installed")
      : result.stderr,
  };
}

function logStatus() {
  const logFile = statePath("notifier.log");
  if (!fs.existsSync(logFile)) return { ok: true, detail: "no notifier log yet" };
  const lines = fs.readFileSync(logFile, "utf8").trim().split(/\n+/).slice(-3);
  return {
    ok: true,
    detail: lines
      .map((line) => takeChars(redactText(line), 1000))
      .join("\n"),
  };
}

const config = loadConfig();
const modelSelection = chooseSummaryModel({ preferredModel: config.summaryModel });
const checks = {
  node: checkCommand("node"),
  codex: checkCommand("codex"),
  marketplace: marketplaceStatus(),
  plugin: pluginStatus(),
  notify: notifyStatus(),
  agentpingConfig: {
    ok: Boolean(config.pushkey),
    detail: `${agentpingConfigPath()} ${config.pushkey ? "has key" : "missing key"}; source ${configSourcePath()}`,
  },
  summaryModel: {
    ok: Boolean(modelSelection.model),
    detail: `${modelSelection.model || "none"} (${modelSelection.source})`,
  },
  summaryLength: {
    ok: config.summaryMinChars >= 0 && config.summaryMaxChars >= config.summaryMinChars,
    detail: `${config.summaryMinChars}-${config.summaryMaxChars} chars, default ${DEFAULT_SUMMARY_MIN_CHARS}-${DEFAULT_SUMMARY_MAX_CHARS}`,
  },
  despMaxChars: {
    ok: config.despMaxChars >= 0 && config.despMaxChars <= DEFAULT_DESP_MAX_CHARS,
    detail: `${config.despMaxChars} chars`,
  },
  despSeparator: {
    ok: typeof config.despSeparator === "string",
    detail: config.despSeparator
      ? JSON.stringify(config.despSeparator)
      : `disabled, default would be ${JSON.stringify(DEFAULT_DESP_SEPARATOR)}`,
  },
  finalWaitMs: {
    ok: config.finalWaitMs >= 0 && config.finalWaitMs <= 60_000,
    detail: `${config.finalWaitMs}ms, default ${DEFAULT_FINAL_WAIT_MS}ms`,
  },
  notifyMode: {
    ok: NOTIFY_MODES.includes(config.notifyMode),
    detail: `${config.notifyMode}, default ${DEFAULT_NOTIFY_MODE}`,
  },
  minDurationMs: {
    ok: config.minDurationMs >= 0,
    detail: `${config.minDurationMs}ms, default ${DEFAULT_MIN_DURATION_MS}ms`,
  },
  logRotation: {
    ok: config.logMaxBytes >= 0 && config.logKeepFiles >= 0,
    detail: `${config.logMaxBytes} bytes, keep ${config.logKeepFiles}; default ${DEFAULT_LOG_MAX_BYTES} bytes, keep ${DEFAULT_LOG_KEEP_FILES}`,
  },
  notifierLog: logStatus(),
};

const summary = {
  ok: Object.values(checks).every((item) => item.ok),
  codexConfigPath: codexConfigPath(),
  agentpingConfigPath: agentpingConfigPath(),
  configSourcePath: configSourcePath(),
  stateLogPath: statePath("notifier.log"),
  checks,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`AgentPing doctor (${os.platform()} ${os.arch()})`);
  for (const [name, check] of Object.entries(checks)) {
    console.log(`${check.ok ? "OK " : "ERR"} ${name}: ${check.detail}`);
  }
  console.log(summary.ok ? "Overall: OK" : "Overall: issues found");
}

process.exit(summary.ok ? 0 : 1);
