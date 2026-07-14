#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_DEBUG_LOGS,
  DEFAULT_AGENT_CONFIGS,
  DEFAULT_CLAUDE_SUMMARY_MODEL,
  DEFAULT_DESP_MAX_CHARS,
  DEFAULT_DESP_SEPARATOR,
  DEFAULT_ENDPOINT,
  DEFAULT_FINAL_WAIT_MS,
  DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS,
  DEFAULT_FINAL_TEXT_PREVIEW_MARKER,
  DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LOG_KEEP_FILES,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_MIN_DURATION_MS,
  DEFAULT_NOTIFY_MODE,
  DEFAULT_DESP_TEMPLATE,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_FALLBACK_TEXT,
  DEFAULT_SUMMARY_MIN_CHARS,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_TITLE_TEMPLATE,
  DEFAULT_USAGE_FOOTER,
  DEFAULT_USAGE_DETAIL,
  NOTIFY_MODES,
  PROJECT_CONFIG_FILES,
  configPath,
  configWithChineseComments,
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
  normalizePushDeerEndpoint,
  normalizeSummaryCharBounds,
  normalizeTemplate,
  parseArgs,
  projectConfigSourcePath,
  readStdin,
  saveConfigPatch,
  saveAgentConfigPatch,
  writeJson0600,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";
import {
  USAGE_DETAIL_MODES,
  normalizeUsageDetail,
} from "../plugins/agentping/scripts/usage.mjs";

const args = parseArgs();
const command = args._[0] || "show";

function usage() {
  console.log([
    "Usage: agentping config <command> [options]",
    "",
    "Commands:",
    "  show                         Show effective config without revealing the PushDeer key",
    "  path                         Print config file path",
    "  set-key --key <key>          Save PushDeer key; use --agent <agentId>",
    "  set-key --stdin              Read PushDeer key from stdin",
    "  unset-key                    Remove stored PushDeer key",
    "  set-endpoint <url>           Configure PushDeer API endpoint",
    "  reset-endpoint               Restore the public PushDeer endpoint",
    "  set-enabled <on|off>         Enable or disable one agent config",
    "  set-summary-range <min> <max> Configure LLM summary length",
    "  set-summary-provider <name>  Configure agent summary provider: codex|claude|none",
    "  set-summary-model <model>    Configure agent summary model",
    "  set-summary-fallback <text>   Configure fixed title used when LLM summary is unavailable",
    "  set-timeout <ms>             Configure LLM summary timeout",
    "  set-desp-max <chars>         Configure desp length; -1 unlimited, 0 disables desp",
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
    "  set-usage-footer <on|off>    Show or hide model/token footer",
    "  set-usage-detail <mode>      Configure usage detail: compact|detailed",
    "  reset-templates              Restore default notification templates",
    "  init-project [path]          Create a project-level .agentping.json without secrets",
    "  reset [--forget-key]         Reset runtime options to defaults",
    "",
    `Modes: ${NOTIFY_MODES.join(", ")}`,
    `Template placeholders: {summary}, {finalText}, {finalTextPreview}, {separator}, {duration}, {durationZh}, {turnId}, {terminalType}, {summarySource}, {summaryModel}, {summaryElapsedMs}, {taskModel}, {taskProvider}, {inputTokens}, {cachedInputTokens}, {cacheCreationInputTokens}, {outputTokens}, {reasoningTokens}, {totalTokens}, {usageFooter}`,
  ].join("\n"));
}

function showConfig() {
  const config = loadConfig();
  const agents = Object.fromEntries(Object.entries(config.agents || {}).map(([agentId, agent]) => [agentId, {
    type: agent.type || agentId,
    enabled: agent.enabled !== false,
    hasPushKey: Boolean(agent.PushKey),
    summaryProvider: agent.summaryProvider,
    summaryModel: agent.summaryModel,
    summaryTimeoutMs: agent.summaryTimeoutMs,
  }]));
  console.log(JSON.stringify({
    configPath: configPath(),
    configSourcePath: configSourcePath(),
    projectConfigPath: config.projectConfigPath || projectConfigSourcePath(),
    endpoint: config.endpoint || DEFAULT_ENDPOINT,
    hasCodexPushKey: Boolean(config.pushkey),
    hasClaudePushKey: Boolean(config.claudePushkey),
    agents,
    CodexSummaryModel: config.summaryModel || DEFAULT_SUMMARY_MODEL,
    ClaudeSummaryModel: config.claudeSummaryModel || DEFAULT_CLAUDE_SUMMARY_MODEL,
    summaryMinChars: config.summaryMinChars,
    summaryMaxChars: config.summaryMaxChars,
    summaryFallbackText: config.summaryFallbackText,
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
    finalTextPreviewHeadChars: config.finalTextPreviewHeadChars,
    finalTextPreviewTailChars: config.finalTextPreviewTailChars,
    finalTextPreviewMarker: config.finalTextPreviewMarker,
    usageFooter: config.usageFooter,
    usageDetail: config.usageDetail,
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

function selectedAgentId() {
  return String(args.agent || args.platform || "codex").trim().toLowerCase();
}

function selectedAgentType(agentId = selectedAgentId()) {
  return String(args.type || configAgentType(agentId)).trim().toLowerCase();
}

function configAgentType(agentId) {
  return loadConfig({ agentId }).agents?.[agentId]?.type || agentId;
}

function saveAgentPatch(patch, message) {
  const agentId = selectedAgentId();
  saveAgentConfigPatch(agentId, patch, { agentType: selectedAgentType(agentId) });
  console.log(`${message} for ${agentId} (${configPath()})`);
}

async function setKey() {
  const agentId = selectedAgentId();
  let key = args.key ? String(args.key).trim() : "";
  if (!key && args.stdin) {
    key = (await readStdin()).trim();
  }
  if (!key) {
    console.error("PushDeer key is required. Use --key <key> or --stdin.");
    process.exit(2);
  }
  if (args.endpoint) savePatch({ endpoint: args.endpoint }, "Configured PushDeer endpoint");
  saveAgentPatch({ PushKey: key }, "Saved PushDeer key");
}

function unsetKey() {
  saveAgentPatch({ PushKey: undefined }, "Removed stored PushDeer key");
}

function setEndpoint() {
  const value = rawValue(1, "url", "endpoint");
  if (value === undefined) {
    console.error("PushDeer endpoint is required.");
    process.exit(2);
  }
  const endpoint = normalizePushDeerEndpoint(value, "");
  if (!endpoint) {
    console.error("PushDeer endpoint must be an http(s) URL without embedded credentials.");
    process.exit(2);
  }
  savePatch({ endpoint }, `Configured PushDeer endpoint ${endpoint}`);
}

function setAgentEnabled() {
  const value = rawValue(1, "value", "enabled");
  if (value === undefined) {
    console.error("enabled value is required: on or off.");
    process.exit(2);
  }
  const enabled = normalizeBoolean(value, true);
  saveAgentPatch({ enabled }, `${enabled ? "Enabled" : "Disabled"} agent notifications`);
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

function setSummaryFallback() {
  const value = rawValue(1, "text", "value");
  if (value === undefined) {
    console.error("summary fallback text is required.");
    process.exit(2);
  }
  const summaryFallbackText = normalizeTemplate(value, DEFAULT_SUMMARY_FALLBACK_TEXT);
  savePatch({ summaryFallbackText }, `Configured summary fallback ${JSON.stringify(summaryFallbackText)}`);
}

function setTimeoutMs() {
  const value = Number.parseInt(numberValue(1, "timeout ms", "ms"), 10);
  const llmTimeoutMs = Number.isFinite(value) && value > 0 ? value : DEFAULT_LLM_TIMEOUT_MS;
  saveAgentPatch({ summaryTimeoutMs: llmTimeoutMs }, `Configured LLM summary timeout ${llmTimeoutMs}ms`);
}

function setSummaryProvider() {
  const summaryProvider = String(rawValue(1, "provider") || "").trim().toLowerCase();
  if (!new Set(["codex", "claude", "none"]).has(summaryProvider)) {
    console.error("summary provider must be codex, claude, or none");
    process.exit(2);
  }
  saveAgentPatch({ summaryProvider }, `Configured summary provider ${summaryProvider}`);
}

function setSummaryModel() {
  const summaryModel = String(rawValue(1, "model") || "").trim();
  if (!summaryModel) {
    console.error("summary model is required.");
    process.exit(2);
  }
  saveAgentPatch({ summaryModel }, `Configured summary model ${summaryModel}`);
}

function setDespMax() {
  const despMaxChars = normalizeDespMaxChars(numberValue(1, "desp max chars", "chars"));
  savePatch(
    { despMaxChars },
    despMaxChars < 0
      ? "Configured PushDeer desp without a total length limit"
      : `Configured PushDeer desp max length ${despMaxChars} chars`,
  );
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

function setUsageFooter() {
  const value = rawValue(1, "value", "enabled");
  if (value === undefined) {
    console.error("usage footer value is required: on or off.");
    process.exit(2);
  }
  const usageFooter = normalizeBoolean(value, DEFAULT_USAGE_FOOTER);
  savePatch({ usageFooter }, `Configured usage footer ${usageFooter ? "on" : "off"}`);
}

function setUsageDetail() {
  const rawMode = String(rawValue(1, "mode") || "").trim().toLowerCase();
  if (!USAGE_DETAIL_MODES.includes(rawMode)) {
    console.error(`usage detail must be one of: ${USAGE_DETAIL_MODES.join(", ")}`);
    process.exit(2);
  }
  savePatch({ usageDetail: normalizeUsageDetail(rawMode) }, `Configured usage detail ${rawMode}`);
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
  writeJson0600(target, configWithChineseComments({
    agents: Object.fromEntries(Object.entries(DEFAULT_AGENT_CONFIGS).map(([agentId, agent]) => [agentId, {
      type: agent.type,
      enabled: agent.enabled,
      summaryProvider: agent.summaryProvider,
      summaryModel: agent.summaryModel,
      summaryTimeoutMs: agent.summaryTimeoutMs,
    }])),
    summaryMinChars: DEFAULT_SUMMARY_MIN_CHARS,
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    summaryFallbackText: DEFAULT_SUMMARY_FALLBACK_TEXT,
    llmTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    despMaxChars: DEFAULT_DESP_MAX_CHARS,
    despSeparator: DEFAULT_DESP_SEPARATOR,
    finalWaitMs: DEFAULT_FINAL_WAIT_MS,
    notifyMode: DEFAULT_NOTIFY_MODE,
    minDurationMs: DEFAULT_MIN_DURATION_MS,
    titleTemplate: DEFAULT_TITLE_TEMPLATE,
    despTemplate: DEFAULT_DESP_TEMPLATE,
    finalTextPreviewHeadChars: DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS,
    finalTextPreviewTailChars: DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS,
    finalTextPreviewMarker: DEFAULT_FINAL_TEXT_PREVIEW_MARKER,
    usageFooter: DEFAULT_USAGE_FOOTER,
    usageDetail: DEFAULT_USAGE_DETAIL,
  }));
  console.log(`Created project AgentPing config at ${target}`);
}

function resetConfig() {
  const patch = {
    endpoint: DEFAULT_ENDPOINT,
    agents: DEFAULT_AGENT_CONFIGS,
    summaryMinChars: DEFAULT_SUMMARY_MIN_CHARS,
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    summaryFallbackText: DEFAULT_SUMMARY_FALLBACK_TEXT,
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
    finalTextPreviewHeadChars: DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS,
    finalTextPreviewTailChars: DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS,
    finalTextPreviewMarker: DEFAULT_FINAL_TEXT_PREVIEW_MARKER,
    usageFooter: DEFAULT_USAGE_FOOTER,
    usageDetail: DEFAULT_USAGE_DETAIL,
  };
  if (args["forget-key"]) {
    for (const agentId of Object.keys(loadConfig().agents || {})) {
      saveAgentConfigPatch(agentId, { PushKey: undefined });
    }
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
  case "set-endpoint":
    setEndpoint();
    break;
  case "reset-endpoint":
    savePatch({ endpoint: DEFAULT_ENDPOINT }, `Restored PushDeer endpoint ${DEFAULT_ENDPOINT}`);
    break;
  case "set-enabled":
    setAgentEnabled();
    break;
  case "set-summary-range":
    setSummaryRange();
    break;
  case "set-summary-provider":
    setSummaryProvider();
    break;
  case "set-summary-model":
    setSummaryModel();
    break;
  case "set-summary-fallback":
    setSummaryFallback();
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
  case "set-usage-footer":
    setUsageFooter();
    break;
  case "set-usage-detail":
    setUsageDetail();
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
