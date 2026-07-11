#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CLAUDE_SUMMARY_MODEL,
  DEFAULT_DESP_MAX_CHARS,
  DEFAULT_DESP_SEPARATOR,
  DEFAULT_DESP_TEMPLATE,
  DEFAULT_FINAL_WAIT_MS,
  DEFAULT_DEBUG_LOGS,
  DEFAULT_LOG_KEEP_FILES,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_MIN_DURATION_MS,
  DEFAULT_NOTIFY_MODE,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_FALLBACK_TEXT,
  DEFAULT_SUMMARY_MIN_CHARS,
  DEFAULT_TITLE_TEMPLATE,
  MAX_DESP_MAX_CHARS,
  NOTIFY_MODES,
  configPath as agentpingConfigPath,
  configSourcePath,
  loadConfig,
  redactText,
  statePath,
  takeChars,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";
import {
  claudeHookStatus,
  claudeSettingsPath,
  readClaudeSettings,
} from "./claude-hooks.mjs";
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
const claudeNotifyScript = path.join(
  projectRoot,
  "plugins",
  "agentping",
  "scripts",
  "claude-notify-launcher.mjs",
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
  const stat = fs.statSync(logFile);
  const lines = fs.readFileSync(logFile, "utf8").trim().split(/\n+/).slice(-100);
  const entries = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const counts = entries.reduce((acc, entry) => {
    const level = entry.level || "unknown";
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});
  const latest = [...entries].reverse().find((entry) => entry.message);
  const lastProblem = [...entries].reverse().find((entry) => entry.level === "warn" || entry.level === "error");
  const parts = [
    `${stat.size} bytes`,
    `${entries.length} recent entries`,
    `levels ${Object.entries(counts).map(([level, count]) => `${level}:${count}`).join(", ") || "none"}`,
  ];
  if (latest) {
    parts.push(`latest ${latest.ts || "unknown"} ${latest.message}`);
  }
  if (lastProblem) {
    parts.push(`last problem ${lastProblem.ts || "unknown"} ${lastProblem.message}`);
  }
  return {
    ok: true,
    detail: takeChars(redactText(parts.join("; ")), 1000),
  };
}

function legacyShimStatus() {
  if (!fs.existsSync(legacyNotifyMultiplexer)) {
    return {
      ok: true,
      detail: "not installed",
    };
  }
  const contents = fs.readFileSync(legacyNotifyMultiplexer, "utf8");
  const managed = /AgentPing managed notify multiplexer|agentping/iu.test(contents);
  return {
    ok: managed,
    detail: managed ? `${legacyNotifyMultiplexer} is AgentPing-compatible` : `${legacyNotifyMultiplexer} exists but is not recognized`,
  };
}

function claudeHooksStatus() {
  const settingsFile = claudeSettingsPath();
  try {
    return claudeHookStatus(readClaudeSettings(settingsFile), {
      notifyScript: claudeNotifyScript,
    });
  } catch (error) {
    return { ok: false, detail: `${settingsFile} could not be parsed: ${error?.message || String(error)}` };
  }
}

const config = loadConfig();
const modelSelection = chooseSummaryModel({ preferredModel: config.summaryModel });
const codexCommand = checkCommand("codex");
const claudeCommand = checkCommand("claude");
const hasSupportedAgent = codexCommand.ok || claudeCommand.ok;
const checks = {
  node: checkCommand("node"),
  codex: codexCommand.ok
    ? codexCommand
    : { ok: hasSupportedAgent, detail: "not installed (optional when Claude Code is available)" },
  claude: claudeCommand.ok
    ? claudeCommand
    : { ok: hasSupportedAgent, detail: "not installed (optional when Codex is available)" },
  marketplace: codexCommand.ok ? marketplaceStatus() : { ok: true, detail: "skipped without Codex" },
  plugin: codexCommand.ok ? pluginStatus() : { ok: true, detail: "skipped without Codex" },
  notify: codexCommand.ok ? notifyStatus() : { ok: true, detail: "skipped without Codex" },
  claudeHooks: claudeCommand.ok ? claudeHooksStatus() : { ok: true, detail: "skipped without Claude Code" },
  legacyShim: legacyShimStatus(),
  agentpingConfig: {
    ok: (codexCommand.ok ? Boolean(config.pushkey) : true) &&
      (claudeCommand.ok ? Boolean(config.claudePushkey) : true),
    detail: `${agentpingConfigPath()} Codex key ${config.pushkey ? "configured" : "missing"}, Claude key ${config.claudePushkey ? "configured" : "missing"}; source ${configSourcePath()}`,
  },
  summaryModel: {
    ok: codexCommand.ok ? Boolean(modelSelection.model) : true,
    detail: codexCommand.ok ? `${modelSelection.model || "none"} (${modelSelection.source})` : "skipped without Codex",
  },
  claudeSummaryModel: {
    ok: claudeCommand.ok ? Boolean(config.claudeSummaryModel) : true,
    detail: claudeCommand.ok
      ? `${config.claudeSummaryModel || "none"}, default ${DEFAULT_CLAUDE_SUMMARY_MODEL}`
      : "skipped without Claude Code",
  },
  summaryLength: {
    ok: config.summaryMinChars >= 0 && config.summaryMaxChars >= config.summaryMinChars,
    detail: `${config.summaryMinChars}-${config.summaryMaxChars} chars, default ${DEFAULT_SUMMARY_MIN_CHARS}-${DEFAULT_SUMMARY_MAX_CHARS}`,
  },
  summaryFallbackText: {
    ok: Boolean(config.summaryFallbackText),
    detail: `${JSON.stringify(config.summaryFallbackText)}, default ${JSON.stringify(DEFAULT_SUMMARY_FALLBACK_TEXT)}`,
  },
  despMaxChars: {
    ok: config.despMaxChars >= -1 && config.despMaxChars <= MAX_DESP_MAX_CHARS,
    detail: config.despMaxChars < 0 ? "unlimited" : `${config.despMaxChars} chars`,
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
  debugLogs: {
    ok: typeof config.debugLogs === "boolean",
    detail: `${config.debugLogs ? "on" : "off"}, default ${DEFAULT_DEBUG_LOGS ? "on" : "off"}`,
  },
  templates: {
    ok: typeof config.titleTemplate === "string" && typeof config.despTemplate === "string",
    detail: `title ${JSON.stringify(config.titleTemplate || DEFAULT_TITLE_TEMPLATE)}, desp ${JSON.stringify(config.despTemplate || DEFAULT_DESP_TEMPLATE)}, preview ${config.finalTextPreviewHeadChars}/${config.finalTextPreviewTailChars}`,
  },
  projectConfig: {
    ok: true,
    detail: config.projectConfigPath || "none",
  },
  notifierLog: logStatus(),
};

const summary = {
  ok: Object.values(checks).every((item) => item.ok),
  codexConfigPath: codexConfigPath(),
  claudeSettingsPath: claudeSettingsPath(),
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
