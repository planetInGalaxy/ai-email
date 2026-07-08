#!/usr/bin/env node
import {
  DEFAULT_DESP_MAX_CHARS,
  DEFAULT_DESP_SEPARATOR,
  DEFAULT_ENDPOINT,
  DEFAULT_FINAL_WAIT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LOG_KEEP_FILES,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_MIN_DURATION_MS,
  DEFAULT_NOTIFY_MODE,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_MIN_CHARS,
  DEFAULT_SUMMARY_MODEL,
  NOTIFY_MODES,
  configPath,
  configSourcePath,
  loadConfig,
  normalizeDespMaxChars,
  normalizeDespSeparator,
  normalizeFinalWaitMs,
  normalizeLogKeepFiles,
  normalizeLogMaxBytes,
  normalizeMinDurationMs,
  normalizeNotifyMode,
  normalizeSummaryCharBounds,
  parseArgs,
  readStdin,
  saveConfigPatch,
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
    "  reset [--forget-key]         Reset runtime options to defaults",
    "",
    `Modes: ${NOTIFY_MODES.join(", ")}`,
  ].join("\n"));
}

function showConfig() {
  const config = loadConfig();
  console.log(JSON.stringify({
    configPath: configPath(),
    configSourcePath: configSourcePath(),
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
