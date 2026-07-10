#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_DEBUG_LOGS,
  DEFAULT_DESP_MAX_CHARS,
  DEFAULT_DESP_SEPARATOR,
  DEFAULT_ENDPOINT,
  DEFAULT_FINAL_WAIT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LOG_KEEP_FILES,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_MIN_DURATION_MS,
  DEFAULT_NOTIFY_MODE,
  DEFAULT_DESP_TEMPLATE,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_MIN_CHARS,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_TITLE_TEMPLATE,
  NOTIFY_MODES,
  PROJECT_CONFIG_FILES,
  configPath,
  configSourcePath,
  loadConfig,
  normalizeBoolean,
  normalizeDespMaxChars,
  normalizeDespSeparator,
  normalizeFinalWaitMs,
  normalizeLogKeepFiles,
  normalizeLogMaxBytes,
  normalizeMinDurationMs,
  normalizeNotifyMode,
  normalizeSummaryCharBounds,
  normalizeTemplate,
  parseArgs,
  projectConfigSourcePath,
  readStdin,
  saveConfigPatch,
  writeJson0600,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";

const args = parseArgs();
const command = args._[0] || "show";

function usage() {
  console.log([
    "Usage: agentping config <command> [options]",
    "",
    "Commands:",
    "  show                         Show effective config without revealing the PushDeer key",
    "  path                         Print config file path",
    "  set-key --key <key>          Save PushDeer key",
    "  set-key --stdin              Read PushDeer key from stdin",
    "  unset-key                    Remove stored PushDeer key",
    "  set-summary-range <min> <max> Configure LLM summary length",
    "  set-timeout <ms>             Configure LLM summary timeout",
    "  set-desp-max <chars>         Configure desp truncation length, 0 disables desp",
    "  set-separator <text>         Configure desp separator, supports \\n",
    "  disable-separator            Disable desp separator",
    "  set-final-wait <ms>          Configure final answer wait window",
    "  set-mode <mode>              Configure notification mode",
    "  set-min-duration <ms>        Configure long_only threshold",
    "  set-log-max-bytes <bytes>    Configure log rotation size, 0 disables rotation",
    "  set-log-keep-files <count>   Configure number of rotated logs to keep",
    "  set-debug-logs <on|off>      Include text/stderr previews in local logs",
    "  set-title-template <text>    Configure PushDeer title template",
    "  set-desp-template <text>     Configure PushDeer desp template",
    "  reset-templates              Restore default notification templates",
    "  init-project [path]          Create a project-level .agentping.json without secrets",
    "  reset [--forget-key]         Reset runtime options to defaults",
    "",
    `Modes: ${NOTIFY_MODES.join(", ")}`,
    `Template placeholders: {summary}, {finalText}, {separator}, {duration}, {turnId}, {terminalType}, {summarySource}, {summaryModel}, {summaryElapsedMs}`,
  ].join("\n"));
}

function showConfig() {
  const config = loadConfig();
  console.log(JSON.stringify({
    configPath: configPath(),
    configSourcePath: configSourcePath(),
    projectConfigPath: config.projectConfigPath || projectConfigSourcePath(),
    endpoint: config.endpoint || DEFAULT_ENDPOINT,
    hasPushkey: Boolean(config.pushkey),
    summaryModel: config.summaryModel || DEFAULT_SUMMARY_MODEL,
    summaryMinChars: config.summaryMinChars,
    summaryMaxChars: config.summaryMaxChars,
    llmTimeoutMs: config.llmTimeoutMs,
    despMaxChars: config.despMaxChars,
    despSeparator: config.despSeparator,
    finalWaitMs: config.finalWaitMs,
    notifyMode: config.notifyMode,
    minDurationMs: config.minDurationMs,
    logMaxBytes: config.logMaxBytes,
    logKeepFiles: config.logKeepFiles,
    debugLogs: config.debugLogs,
    titleTemplate: config.titleTemplate,
    despTemplate: config.despTemplate,
  }, null, 2));
}

function rawValue(position, ...names) {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return args._[position];
}

function numberValue(position, label, ...names) {
  const value = rawValue(position, ...names);
  if (value === undefined) {
    console.error(`${label} is required.`);
    process.exit(2);
  }
  return value;
}

function savePatch(patch, message) {
  saveConfigPatch(patch);
  console.log(`${message} (${configPath()})`);
}

async function setKey() {
  let key = args.key ? String(args.key).trim() : "";
  if (!key && args.stdin) {
    key = (await readStdin()).trim();
  }
  if (!key) {
    console.error("PushDeer key is required. Use --key <key> or --stdin.");
    process.exit(2);
  }
  savePatch({
    pushkey: key,
    endpoint: args.endpoint || DEFAULT_ENDPOINT,
  }, "Saved PushDeer key");
}

function unsetKey() {
  savePatch({
    pushkey: undefined,
    pushKey: undefined,
  }, "Removed stored PushDeer key");
}

function setSummaryRange() {
  const { summaryMinChars, summaryMaxChars } = normalizeSummaryCharBounds(
    numberValue(1, "summary min chars", "min"),
    numberValue(2, "summary max chars", "max"),
  );
  savePatch({
    summaryMinChars,
    summaryMaxChars,
  }, `Configured summary length ${summaryMinChars}-${summaryMaxChars} chars`);
}

function setTimeoutMs() {
  const value = Number.parseInt(numberValue(1, "timeout ms", "ms"), 10);
  const llmTimeoutMs = Number.isFinite(value) && value > 0 ? value : DEFAULT_LLM_TIMEOUT_MS;
  savePatch({ llmTimeoutMs }, `Configured LLM summary timeout ${llmTimeoutMs}ms`);
}

function setDespMax() {
  const despMaxChars = normalizeDespMaxChars(numberValue(1, "desp max chars", "chars"));
  savePatch({ despMaxChars }, `Configured PushDeer desp max length ${despMaxChars} chars`);
}

function setSeparator() {
  const value = rawValue(1, "value", "separator");
  if (value === undefined) {
    console.error("separator text is required.");
    process.exit(2);
  }
  const despSeparator = normalizeDespSeparator(value);
  savePatch({ despSeparator }, `Configured PushDeer desp separator ${JSON.stringify(despSeparator)}`);
}

function setFinalWait() {
  const finalWaitMs = normalizeFinalWaitMs(numberValue(1, "final wait ms", "ms"));
  savePatch({ finalWaitMs }, `Configured final-answer wait ${finalWaitMs}ms`);
}

function setMode() {
  const rawMode = rawValue(1, "mode");
  if (!rawMode) {
    console.error(`mode is required. Valid modes: ${NOTIFY_MODES.join(", ")}`);
    process.exit(2);
  }
  const notifyMode = normalizeNotifyMode(rawMode);
  if (notifyMode !== String(rawMode).trim().toLowerCase()) {
    console.error(`Invalid mode: ${rawMode}. Valid modes: ${NOTIFY_MODES.join(", ")}`);
    process.exit(2);
  }
  const patch = { notifyMode };
  if (args["min-duration-ms"] !== undefined || args["min-duration"] !== undefined) {
    patch.minDurationMs = normalizeMinDurationMs(args["min-duration-ms"] ?? args["min-duration"]);
  }
  savePatch(patch, `Configured notification mode ${notifyMode}`);
}

function setMinDuration() {
  const minDurationMs = normalizeMinDurationMs(numberValue(1, "min duration ms", "ms"));
  savePatch({ minDurationMs }, `Configured long_only threshold ${minDurationMs}ms`);
}

function setLogMaxBytes() {
  const logMaxBytes = normalizeLogMaxBytes(numberValue(1, "log max bytes", "bytes"));
  savePatch({ logMaxBytes }, `Configured log rotation size ${logMaxBytes} bytes`);
}

function setLogKeepFiles() {
  const logKeepFiles = normalizeLogKeepFiles(numberValue(1, "log keep files", "count"));
  savePatch({ logKeepFiles }, `Configured rotated log retention ${logKeepFiles} files`);
}

function setDebugLogs() {
  const value = rawValue(1, "value", "enabled");
  if (value === undefined) {
    console.error("debug log value is required: on or off.");
    process.exit(2);
  }
  const debugLogs = normalizeBoolean(value, DEFAULT_DEBUG_LOGS);
  savePatch({ debugLogs }, `Configured debug logs ${debugLogs ? "on" : "off"}`);
}

function setTitleTemplate() {
  const value = rawValue(1, "value", "template");
  if (value === undefined) {
    console.error("title template is required.");
    process.exit(2);
  }
  const titleTemplate = normalizeTemplate(value, DEFAULT_TITLE_TEMPLATE);
  savePatch({ titleTemplate }, `Configured title template ${JSON.stringify(titleTemplate)}`);
}

function setDespTemplate() {
  const value = rawValue(1, "value", "template");
  if (value === undefined) {
    console.error("desp template is required.");
    process.exit(2);
  }
  const despTemplate = normalizeTemplate(value, DEFAULT_DESP_TEMPLATE);
  savePatch({ despTemplate }, `Configured desp template ${JSON.stringify(despTemplate)}`);
}

function resetTemplates() {
  savePatch({
    titleTemplate: DEFAULT_TITLE_TEMPLATE,
    despTemplate: DEFAULT_DESP_TEMPLATE,
  }, "Reset notification templates");
}

function initProjectConfig() {
  const targetDir = path.resolve(rawValue(1, "path") || process.cwd());
  const target = path.join(targetDir, PROJECT_CONFIG_FILES[0]);
  if (fs.existsSync(target) && !args.force) {
    console.error(`${target} already exists. Re-run with --force to overwrite it.`);
    process.exit(2);
  }
  writeJson0600(target, {
    summaryModel: DEFAULT_SUMMARY_MODEL,
    summaryMinChars: DEFAULT_SUMMARY_MIN_CHARS,
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    llmTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    despMaxChars: DEFAULT_DESP_MAX_CHARS,
    despSeparator: DEFAULT_DESP_SEPARATOR,
    finalWaitMs: DEFAULT_FINAL_WAIT_MS,
    notifyMode: DEFAULT_NOTIFY_MODE,
    minDurationMs: DEFAULT_MIN_DURATION_MS,
    titleTemplate: DEFAULT_TITLE_TEMPLATE,
    despTemplate: DEFAULT_DESP_TEMPLATE,
  });
  console.log(`Created project AgentPing config at ${target}`);
}

function resetConfig() {
  const patch = {
    endpoint: DEFAULT_ENDPOINT,
    summaryModel: DEFAULT_SUMMARY_MODEL,
    summaryMinChars: DEFAULT_SUMMARY_MIN_CHARS,
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    llmTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    despMaxChars: DEFAULT_DESP_MAX_CHARS,
    despSeparator: DEFAULT_DESP_SEPARATOR,
    finalWaitMs: DEFAULT_FINAL_WAIT_MS,
    notifyMode: DEFAULT_NOTIFY_MODE,
    minDurationMs: DEFAULT_MIN_DURATION_MS,
    logMaxBytes: DEFAULT_LOG_MAX_BYTES,
    logKeepFiles: DEFAULT_LOG_KEEP_FILES,
    debugLogs: DEFAULT_DEBUG_LOGS,
    titleTemplate: DEFAULT_TITLE_TEMPLATE,
    despTemplate: DEFAULT_DESP_TEMPLATE,
  };
  if (args["forget-key"]) {
    patch.pushkey = undefined;
    patch.pushKey = undefined;
  }
  savePatch(patch, args["forget-key"] ? "Reset config and removed PushDeer key" : "Reset runtime config");
}

switch (command) {
  case "show":
    showConfig();
    break;
  case "path":
    console.log(configPath());
    break;
  case "set-key":
    await setKey();
    break;
  case "unset-key":
    unsetKey();
    break;
  case "set-summary-range":
    setSummaryRange();
    break;
  case "set-timeout":
    setTimeoutMs();
    break;
  case "set-desp-max":
    setDespMax();
    break;
  case "set-separator":
    setSeparator();
    break;
  case "disable-separator":
    savePatch({ despSeparator: "" }, "Disabled PushDeer desp separator");
    break;
  case "set-final-wait":
    setFinalWait();
    break;
  case "set-mode":
    setMode();
    break;
  case "set-min-duration":
    setMinDuration();
    break;
  case "set-log-max-bytes":
    setLogMaxBytes();
    break;
  case "set-log-keep-files":
    setLogKeepFiles();
    break;
  case "set-debug-logs":
    setDebugLogs();
    break;
  case "set-title-template":
    setTitleTemplate();
    break;
  case "set-desp-template":
    setDespTemplate();
    break;
  case "reset-templates":
    resetTemplates();
    break;
  case "init-project":
    initProjectConfig();
    break;
  case "reset":
    resetConfig();
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown config command: ${command}`);
    usage();
    process.exit(2);
}
