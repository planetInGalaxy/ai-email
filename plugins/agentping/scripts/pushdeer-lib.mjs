import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatTokenCount,
  formatUsageFooter,
  mergeUsage,
  normalizeUsage,
  normalizeUsageDetail,
  usageDelta,
} from "./usage.mjs";

export const DEFAULT_ENDPOINT = "https://api2.pushdeer.com/message/push";
export const APP_NAME = "agentping";
export const LEGACY_APP_NAME = "codex-pushdeer-notifier";
export const DEFAULT_SUMMARY_MODEL = "gpt-5.4-mini";
export const DEFAULT_CLAUDE_SUMMARY_MODEL = "sonnet";
export const DEFAULT_SUMMARY_MIN_CHARS = 50;
export const DEFAULT_SUMMARY_MAX_CHARS = 100;
export const DEFAULT_SUMMARY_FALLBACK_TEXT = "摘要未生成，请看原回答";
export const DEFAULT_LLM_TIMEOUT_MS = 16_000;
export const DEFAULT_DESP_MAX_CHARS = -1;
export const MAX_DESP_MAX_CHARS = 1000;
export const DEFAULT_DESP_SEPARATOR = "\n***\n";
export const DEFAULT_FINAL_WAIT_MS = 8_000;
export const DEFAULT_NOTIFY_MODE = "long_only";
export const DEFAULT_MIN_DURATION_MS = 10_000;
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LOG_KEEP_FILES = 3;
export const DEFAULT_DEBUG_LOGS = false;
export const DEFAULT_TITLE_TEMPLATE = "### {summary}";
export const DEFAULT_DESP_TEMPLATE = "{separator}>>>> ### 用时: {durationZh}\n### 回答摘录:\n{finalTextPreview}";
export const DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS = 100;
export const DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS = 100;
export const DEFAULT_FINAL_TEXT_PREVIEW_MARKER = "\n\n......\n\n";
export const DEFAULT_USAGE_FOOTER = true;
export const DEFAULT_USAGE_DETAIL = "compact";
export const CODEX_SUMMARY_PROVIDER = "agentping-openai";
export const CODEX_SUMMARY_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const NOTIFY_MODES = ["always", "long_only", "errors_only", "off"];
export const PROJECT_CONFIG_FILES = [".agentping.json", "agentping.config.json"];
export const CONFIG_VERSION = 2;

export function normalizePushDeerEndpoint(value, fallback = DEFAULT_ENDPOINT) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return fallback;
    }
    url.search = "";
    url.hash = "";
    const pathname = url.pathname.replace(/\/+$/u, "");
    url.pathname = pathname || "/message/push";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return fallback;
  }
}

export const DEFAULT_AGENT_CONFIGS = {
  codex: {
    type: "codex",
    enabled: true,
    PushKey: undefined,
    summaryProvider: "codex",
    summaryModel: DEFAULT_SUMMARY_MODEL,
    summaryTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  },
  claude: {
    type: "claude",
    enabled: true,
    PushKey: undefined,
    summaryProvider: "claude",
    summaryModel: DEFAULT_CLAUDE_SUMMARY_MODEL,
    summaryTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  },
  openclaw: {
    type: "openclaw",
    enabled: true,
    PushKey: undefined,
    summaryProvider: "codex",
    summaryModel: DEFAULT_SUMMARY_MODEL,
    summaryTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  },
  hermes: {
    type: "hermes",
    enabled: true,
    PushKey: undefined,
    summaryProvider: "codex",
    summaryModel: DEFAULT_SUMMARY_MODEL,
    summaryTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  },
};

const DEFAULT_STORED_CONFIG = {
  configVersion: CONFIG_VERSION,
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

export const CONFIG_FIELD_COMMENTS = {
  configVersion: "AgentPing 配置结构版本，由程序自动迁移，请勿手动降低。",
  endpoint: "PushDeer 服务端的消息推送接口地址；可使用 agentping config set-endpoint 修改。",
  agents: "各 Agent 实例的独立 Key、摘要 Provider、模型和超时配置。",
  summaryMinChars: "LLM 摘要期望的最少汉字数，会动态写入摘要 Prompt。",
  summaryMaxChars: "LLM 摘要期望的最多汉字数，会动态写入摘要 Prompt；为保证语句完整不会强制截断。",
  summaryFallbackText: "LLM 摘要超时、失败、为空或明显无效时使用的固定标题。",
  despMaxChars: "PushDeer desp 正文的最大字符数，-1 表示不限制总长度，0 表示不发送 desp，正数最大允许 1000。",
  despSeparator: "摘要标题与原始回答正文之间使用的分隔符。",
  finalWaitMs: "收到 Codex 通知事件后，等待会话写入完整最终回答的最长毫秒数。",
  notifyMode: "通知模式：always 总是通知、long_only 仅耗时任务、errors_only 仅错误、off 关闭。",
  minDurationMs: "notifyMode 为 long_only 时，达到该耗时毫秒数才发送通知。",
  logMaxBytes: "单个本地日志文件的最大字节数，0 表示不轮转。",
  logKeepFiles: "日志轮转后保留的历史文件数量。",
  debugLogs: "是否在本地日志中记录已脱敏的文本预览和错误输出，排查问题时再开启。",
  titleTemplate: "PushDeer 标题模板，可使用 AgentPing 支持的模板变量。",
  despTemplate: "PushDeer desp 正文模板，可使用 AgentPing 支持的模板变量。",
  finalTextPreviewHeadChars: "{finalTextPreview} 保留原始回答开头的字符数。",
  finalTextPreviewTailChars: "{finalTextPreview} 保留原始回答末尾的字符数。",
  finalTextPreviewMarker: "{finalTextPreview} 省略中间内容时插入的标记。",
  usageFooter: "是否在通知末尾显示本轮模型和可用的 Token 用量；没有可靠数据时自动省略对应字段。",
  usageDetail: "运行信息详细程度：compact 紧凑、detailed 详细。",
};

const LEGACY_AGENT_FIELDS = {
  codex: {
    PushKey: ["CodexPushKey", "pushkey", "pushKey", "pushdeerKey"],
    summaryModel: ["CodexSummaryModel", "summaryModel", "summary_model"],
  },
  claude: {
    PushKey: ["ClaudePushKey", "claudePushkey", "claudePushKey", "claude_pushkey"],
    summaryModel: ["ClaudeSummaryModel", "claudeSummaryModel", "claude_summary_model"],
  },
};

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(objectValue(config)));
}

function firstStoredValue(config, names) {
  const name = names.find((item) => Object.prototype.hasOwnProperty.call(config, item));
  return name ? config[name] : undefined;
}

function mergeAgents(...sources) {
  const output = {};
  for (const source of sources) {
    for (const [agentId, value] of Object.entries(objectValue(source))) {
      output[agentId] = { ...objectValue(output[agentId]), ...objectValue(value) };
    }
  }
  return output;
}

function canonicalizeStoredConfig(config, { fillAgentDefaults = false } = {}) {
  const output = cloneConfig(config);
  delete output._说明;
  for (const key of Object.keys(output)) {
    if (key.endsWith("__说明")) delete output[key];
  }

  const explicitAgents = mergeAgents(output.agents);
  const agents = mergeAgents(fillAgentDefaults ? DEFAULT_AGENT_CONFIGS : {}, explicitAgents);
  for (const [agentId, fields] of Object.entries(LEGACY_AGENT_FIELDS)) {
    const patch = {};
    for (const [target, aliases] of Object.entries(fields)) {
      const legacyValue = firstStoredValue(output, aliases);
      if (legacyValue !== undefined && explicitAgents[agentId]?.[target] === undefined) patch[target] = legacyValue;
      for (const alias of aliases) delete output[alias];
    }
    if (Object.keys(patch).length > 0) agents[agentId] = { ...objectValue(agents[agentId]), ...patch };
  }
  if (Object.prototype.hasOwnProperty.call(output, "llmTimeoutMs") || Object.prototype.hasOwnProperty.call(output, "llm_timeout_ms")) {
    const timeout = output.llmTimeoutMs ?? output.llm_timeout_ms;
    for (const agentId of ["codex", "claude"]) {
      if (agents[agentId]?.summaryTimeoutMs === undefined) {
        agents[agentId] = { ...objectValue(agents[agentId]), summaryTimeoutMs: timeout };
      }
    }
  }
  delete output.llmTimeoutMs;
  delete output.llm_timeout_ms;
  for (const obsoleteField of [
    "costMode",
    "cost_mode",
    "costCurrency",
    "cost_currency",
    "modelPricing",
    "model_pricing",
  ]) {
    delete output[obsoleteField];
  }
  output.agents = agents;
  if (fillAgentDefaults || output.configVersion !== undefined) output.configVersion = CONFIG_VERSION;
  return output;
}

function mergeStoredConfigs(...sources) {
  const normalized = sources.map((source) => canonicalizeStoredConfig(source));
  return {
    ...normalized.reduce((result, source) => ({ ...result, ...source }), {}),
    agents: mergeAgents(...normalized.map((source) => source.agents)),
  };
}

export function configWithChineseComments(config) {
  const output = canonicalizeStoredConfig(config);
  const comments = [];
  for (const [key, value] of Object.entries(output)) {
    if (value === undefined) delete output[key];
  }
  for (const key of Object.keys(output)) {
    if (CONFIG_FIELD_COMMENTS[key]) comments.push(`${key}：${CONFIG_FIELD_COMMENTS[key]}`);
  }
  for (const [agentId, agent] of Object.entries(objectValue(output.agents))) {
    comments.push(`agents.${agentId}.type：适配器类型，内置可选 codex、claude、openclaw、hermes。`);
    comments.push(`agents.${agentId}.enabled：是否接收该 Agent 的完成事件并发送通知。`);
    comments.push(`agents.${agentId}.PushKey：${agent.type || agentId} 专用 PushDeer Key；项目配置中的 Key 会被忽略。`);
    comments.push(`agents.${agentId}.summaryProvider：生成摘要的后端，可选 codex、claude 或 none。`);
    comments.push(`agents.${agentId}.summaryModel：该 Agent 通知使用的摘要模型。`);
    comments.push(`agents.${agentId}.summaryTimeoutMs：该 Agent 等待摘要生成的最长毫秒数。`);
  }
  if (comments.length > 0) output._说明 = comments;
  return output;
}

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

export function codexSummaryExecArgs({ model, outputFile, prompt }) {
  return [
    "exec",
    "--ignore-user-config",
    "-c", `model_provider="${CODEX_SUMMARY_PROVIDER}"`,
    "-c", `model_providers.${CODEX_SUMMARY_PROVIDER}.name="OpenAI"`,
    "-c", `model_providers.${CODEX_SUMMARY_PROVIDER}.base_url="${CODEX_SUMMARY_BASE_URL}"`,
    "-c", `model_providers.${CODEX_SUMMARY_PROVIDER}.wire_api="responses"`,
    "-c", `model_providers.${CODEX_SUMMARY_PROVIDER}.requires_openai_auth=true`,
    "-c", `model_providers.${CODEX_SUMMARY_PROVIDER}.supports_websockets=false`,
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--disable", "hooks",
    "--disable", "plugins",
    "--ephemeral",
    "-m", model,
    "--output-last-message", outputFile,
    prompt,
  ];
}

export function codexTransportDiagnostics(stderr, { timedOut = false } = {}) {
  const text = String(stderr || "");
  const retryMatches = text.match(/stream disconnected - retrying/gu) || [];
  const usedHttp = text.includes("falling back to HTTP") || text.includes("HTTPS transport");
  const providerMatch = text.match(/^provider:\s*(.+)$/mu);
  return {
    transport: usedHttp || providerMatch?.[1]?.trim() === CODEX_SUMMARY_PROVIDER ? "https" : "unknown",
    transportRetries: retryMatches.length,
    timeoutStage: timedOut
      ? (retryMatches.length > 0 ? "transport_retry" : "response_wait")
      : "",
  };
}

function defaultConfigPath(appName) {
  return path.join(os.homedir(), ".config", appName, "config.json");
}

export function configPath() {
  return expandHome(
    envValue("AGENTPING_CONFIG", "CODEX_PUSHDEER_CONFIG") ||
      defaultConfigPath(APP_NAME),
  );
}

export function legacyConfigPath() {
  return expandHome(defaultConfigPath(LEGACY_APP_NAME));
}

export function configSourcePath() {
  if (envValue("AGENTPING_CONFIG", "CODEX_PUSHDEER_CONFIG")) return configPath();
  if (fs.existsSync(configPath())) return configPath();
  if (fs.existsSync(legacyConfigPath())) return legacyConfigPath();
  return configPath();
}

export function findProjectConfigPath(startDir = process.cwd()) {
  if (envValue("AGENTPING_DISABLE_PROJECT_CONFIG") === "1") return "";

  let current = path.resolve(expandHome(startDir || process.cwd()));
  try {
    const stat = fs.statSync(current);
    if (!stat.isDirectory()) current = path.dirname(current);
  } catch {
    current = process.cwd();
  }

  const root = path.parse(current).root;
  while (true) {
    for (const fileName of PROJECT_CONFIG_FILES) {
      const candidate = path.join(current, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (current === root) return "";
    current = path.dirname(current);
  }
}

export function projectConfigSourcePath(startDir = process.cwd()) {
  return envValue("AGENTPING_PROJECT_CONFIG")
    ? expandHome(envValue("AGENTPING_PROJECT_CONFIG"))
    : findProjectConfigPath(startDir);
}

export function stateDir() {
  return expandHome(
    envValue("AGENTPING_STATE_DIR", "CODEX_PUSHDEER_STATE_DIR") ||
      path.join(os.homedir(), ".local", "state", APP_NAME),
  );
}

export function statePath(fileName) {
  return path.join(stateDir(), fileName);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson0600(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort only; some filesystems do not support chmod.
  }
}

export function logEvent(level, message, meta = {}) {
  try {
    ensureDir(stateDir());
    rotateLogIfNeeded();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...redactObject(meta),
    });
    fs.appendFileSync(statePath("notifier.log"), `${line}\n`, { mode: 0o600 });
  } catch {
    // Hooks must never fail just because logging failed.
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
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

export async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function safeJsonParse(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function stripProjectSecrets(config) {
  if (!config || typeof config !== "object") return {};
  const output = canonicalizeStoredConfig(config);
  output.agents = Object.fromEntries(
    Object.entries(objectValue(output.agents)).map(([agentId, agent]) => {
      const sanitized = { ...objectValue(agent) };
      delete sanitized.PushKey;
      delete sanitized.pushKey;
      delete sanitized.pushkey;
      return [agentId, sanitized];
    }),
  );
  return output;
}

function rawConfigForCwd(cwd = process.cwd()) {
  const userConfig = canonicalizeStoredConfig(readJsonIfExists(configSourcePath(), {}), { fillAgentDefaults: true });
  const projectPath = projectConfigSourcePath(cwd);
  const projectConfig = projectPath
    ? stripProjectSecrets(readJsonIfExists(projectPath, {}))
    : {};
  return {
    config: mergeStoredConfigs(userConfig, projectConfig),
    projectPath,
  };
}

function resolveAgentConfig(agents, agentId, agentType = "") {
  const stored = objectValue(agents?.[agentId]);
  const type = String(stored.type || agentType || agentId || "codex").trim().toLowerCase();
  const defaults = objectValue(DEFAULT_AGENT_CONFIGS[type]);
  const summaryTimeoutMs = Number.parseInt(stored.summaryTimeoutMs ?? defaults.summaryTimeoutMs, 10);
  const requestedProvider = String(stored.summaryProvider || defaults.summaryProvider || "codex").trim().toLowerCase();
  const summaryProvider = ["codex", "claude", "none"].includes(requestedProvider)
    ? requestedProvider
    : String(defaults.summaryProvider || "codex");
  return {
    ...defaults,
    ...stored,
    type,
    enabled: normalizeBoolean(stored.enabled ?? defaults.enabled, true),
    PushKey: String(stored.PushKey || stored.pushKey || stored.pushkey || ""),
    summaryProvider,
    summaryModel: String(stored.summaryModel || defaults.summaryModel || DEFAULT_SUMMARY_MODEL).trim(),
    summaryTimeoutMs: Number.isFinite(summaryTimeoutMs) && summaryTimeoutMs > 0
      ? summaryTimeoutMs
      : DEFAULT_LLM_TIMEOUT_MS,
  };
}

function agentEnvPrefix(agentType) {
  return String(agentType || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function loadConfig({ cwd = process.cwd(), agentId = "codex", agentType = "" } = {}) {
  const { config, projectPath } = rawConfigForCwd(cwd);
  const resolvedAgentId = String(agentId || agentType || "codex").trim().toLowerCase();
  const agentConfig = resolveAgentConfig(config.agents, resolvedAgentId, agentType);
  const envPrefix = agentEnvPrefix(agentConfig.type);
  const endpoint = normalizePushDeerEndpoint(
    envValue("AGENTPING_PUSHDEER_ENDPOINT", "AGENTPING_ENDPOINT", "PUSHDEER_ENDPOINT", "CODEX_PUSHDEER_ENDPOINT") ||
    config.pushdeerEndpoint ||
    config.endpoint ||
    DEFAULT_ENDPOINT,
  );
  const codexConfig = resolveAgentConfig(config.agents, "codex", "codex");
  const claudeConfig = resolveAgentConfig(config.agents, "claude", "claude");
  const pushkey =
    envValue("AGENTPING_PUSHDEER_KEY", "AGENTPING_KEY", "PUSHDEER_KEY", "CODEX_PUSHDEER_KEY") ||
    codexConfig.PushKey ||
    "";
  const claudePushkey =
    envValue("AGENTPING_CLAUDE_PUSHDEER_KEY", "CLAUDE_PUSHDEER_KEY") ||
    claudeConfig.PushKey ||
    "";
  const summaryModel =
    envValue("AGENTPING_SUMMARY_MODEL", "CODEX_PUSHDEER_SUMMARY_MODEL") ||
    codexConfig.summaryModel ||
    DEFAULT_SUMMARY_MODEL;
  const claudeSummaryModel =
    envValue("AGENTPING_CLAUDE_SUMMARY_MODEL") ||
    claudeConfig.summaryModel ||
    DEFAULT_CLAUDE_SUMMARY_MODEL;
  const summaryMinChars = Number.parseInt(
    envValue("AGENTPING_SUMMARY_MIN_CHARS", "CODEX_PUSHDEER_SUMMARY_MIN_CHARS") ??
      config.summaryMinChars ??
      config.summary_min_chars ??
      String(DEFAULT_SUMMARY_MIN_CHARS),
    10,
  );
  const summaryMaxChars = Number.parseInt(
    envValue("AGENTPING_SUMMARY_MAX_CHARS", "CODEX_PUSHDEER_SUMMARY_MAX_CHARS") ??
      config.summaryMaxChars ??
      config.summary_max_chars ??
      String(DEFAULT_SUMMARY_MAX_CHARS),
    10,
  );
  const summaryFallbackText =
    envValue("AGENTPING_SUMMARY_FALLBACK_TEXT", "CODEX_PUSHDEER_SUMMARY_FALLBACK_TEXT") ??
    config.summaryFallbackText ??
    config.summary_fallback_text ??
    DEFAULT_SUMMARY_FALLBACK_TEXT;
  const agentSummaryTimeoutMs = Number.parseInt(
    envValue(`AGENTPING_${envPrefix}_SUMMARY_TIMEOUT_MS`, "AGENTPING_LLM_TIMEOUT_MS", "CODEX_PUSHDEER_LLM_TIMEOUT_MS") ||
      agentConfig.summaryTimeoutMs ||
      String(DEFAULT_LLM_TIMEOUT_MS),
    10,
  );
  const agentPushKey =
    envValue(`AGENTPING_${envPrefix}_PUSHDEER_KEY`) ||
    (agentConfig.type === "codex" ? pushkey : agentConfig.type === "claude" ? claudePushkey : agentConfig.PushKey) ||
    "";
  const agentSummaryModel =
    envValue(`AGENTPING_${envPrefix}_SUMMARY_MODEL`) ||
    (agentConfig.type === "codex" ? summaryModel : agentConfig.type === "claude" ? claudeSummaryModel : agentConfig.summaryModel) ||
    DEFAULT_SUMMARY_MODEL;
  const despMaxChars = Number.parseInt(
    envValue("AGENTPING_DESP_MAX_CHARS", "CODEX_PUSHDEER_DESP_MAX_CHARS") ??
      config.despMaxChars ??
      config.desp_max_chars ??
      String(DEFAULT_DESP_MAX_CHARS),
    10,
  );
  const despSeparator =
    envValue("AGENTPING_DESP_SEPARATOR", "CODEX_PUSHDEER_DESP_SEPARATOR") ??
    config.despSeparator ??
    config.desp_separator ??
    DEFAULT_DESP_SEPARATOR;
  const finalWaitMs = Number.parseInt(
    envValue("AGENTPING_FINAL_WAIT_MS", "CODEX_PUSHDEER_FINAL_WAIT_MS") ??
      config.finalWaitMs ??
      config.final_wait_ms ??
      String(DEFAULT_FINAL_WAIT_MS),
    10,
  );
  const notifyMode =
    envValue("AGENTPING_NOTIFY_MODE", "CODEX_PUSHDEER_NOTIFY_MODE") ??
    config.notifyMode ??
    config.notify_mode ??
    DEFAULT_NOTIFY_MODE;
  const minDurationMs = Number.parseInt(
    envValue("AGENTPING_MIN_DURATION_MS", "CODEX_PUSHDEER_MIN_DURATION_MS") ??
      config.minDurationMs ??
      config.min_duration_ms ??
      String(DEFAULT_MIN_DURATION_MS),
    10,
  );
  const logMaxBytes = Number.parseInt(
    envValue("AGENTPING_LOG_MAX_BYTES", "CODEX_PUSHDEER_LOG_MAX_BYTES") ??
      config.logMaxBytes ??
      config.log_max_bytes ??
      String(DEFAULT_LOG_MAX_BYTES),
    10,
  );
  const logKeepFiles = Number.parseInt(
    envValue("AGENTPING_LOG_KEEP_FILES", "CODEX_PUSHDEER_LOG_KEEP_FILES") ??
      config.logKeepFiles ??
      config.log_keep_files ??
      String(DEFAULT_LOG_KEEP_FILES),
    10,
  );
  const debugLogs = envValue("AGENTPING_DEBUG_LOGS", "CODEX_PUSHDEER_DEBUG_LOGS") ??
    config.debugLogs ??
    config.debug_logs ??
    DEFAULT_DEBUG_LOGS;
  const titleTemplate =
    envValue("AGENTPING_TITLE_TEMPLATE", "CODEX_PUSHDEER_TITLE_TEMPLATE") ??
    config.titleTemplate ??
    config.title_template ??
    DEFAULT_TITLE_TEMPLATE;
  const despTemplate =
    envValue("AGENTPING_DESP_TEMPLATE", "CODEX_PUSHDEER_DESP_TEMPLATE") ??
    config.despTemplate ??
    config.desp_template ??
    DEFAULT_DESP_TEMPLATE;
  const finalTextPreviewHeadChars = Number.parseInt(
    envValue("AGENTPING_FINAL_TEXT_PREVIEW_HEAD_CHARS", "CODEX_PUSHDEER_FINAL_TEXT_PREVIEW_HEAD_CHARS") ??
      config.finalTextPreviewHeadChars ??
      config.final_text_preview_head_chars ??
      String(DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS),
    10,
  );
  const finalTextPreviewTailChars = Number.parseInt(
    envValue("AGENTPING_FINAL_TEXT_PREVIEW_TAIL_CHARS", "CODEX_PUSHDEER_FINAL_TEXT_PREVIEW_TAIL_CHARS") ??
      config.finalTextPreviewTailChars ??
      config.final_text_preview_tail_chars ??
      String(DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS),
    10,
  );
  const finalTextPreviewMarker =
    envValue("AGENTPING_FINAL_TEXT_PREVIEW_MARKER", "CODEX_PUSHDEER_FINAL_TEXT_PREVIEW_MARKER") ??
    config.finalTextPreviewMarker ??
    config.final_text_preview_marker ??
    DEFAULT_FINAL_TEXT_PREVIEW_MARKER;
  const usageFooter = envValue("AGENTPING_USAGE_FOOTER") ??
    config.usageFooter ??
    config.usage_footer ??
    DEFAULT_USAGE_FOOTER;
  const usageDetail = envValue("AGENTPING_USAGE_DETAIL") ??
    config.usageDetail ??
    config.usage_detail ??
    DEFAULT_USAGE_DETAIL;
  const summaryBounds = normalizeSummaryCharBounds(summaryMinChars, summaryMaxChars);

  return {
    ...config,
    configVersion: CONFIG_VERSION,
    agents: config.agents,
    projectConfigPath: projectPath,
    agentId: resolvedAgentId,
    agentType: agentConfig.type,
    agentConfig: {
      ...agentConfig,
      PushKey: agentPushKey,
      summaryProvider: envValue(`AGENTPING_${envPrefix}_SUMMARY_PROVIDER`) || agentConfig.summaryProvider,
      summaryModel: agentSummaryModel,
      summaryTimeoutMs: Number.isFinite(agentSummaryTimeoutMs) && agentSummaryTimeoutMs > 0
        ? agentSummaryTimeoutMs
        : DEFAULT_LLM_TIMEOUT_MS,
    },
    agentEnabled: agentConfig.enabled !== false,
    agentPushKey,
    agentSummaryProvider: envValue(`AGENTPING_${envPrefix}_SUMMARY_PROVIDER`) || agentConfig.summaryProvider,
    agentSummaryModel,
    agentSummaryTimeoutMs: Number.isFinite(agentSummaryTimeoutMs) && agentSummaryTimeoutMs > 0
      ? agentSummaryTimeoutMs
      : DEFAULT_LLM_TIMEOUT_MS,
    endpoint,
    pushkey,
    claudePushkey,
    summaryModel,
    claudeSummaryModel,
    ...summaryBounds,
    summaryFallbackText: normalizeTemplate(summaryFallbackText, DEFAULT_SUMMARY_FALLBACK_TEXT),
    llmTimeoutMs: Number.isFinite(agentSummaryTimeoutMs) && agentSummaryTimeoutMs > 0
      ? agentSummaryTimeoutMs
      : DEFAULT_LLM_TIMEOUT_MS,
    despMaxChars: normalizeDespMaxChars(despMaxChars),
    despSeparator: normalizeDespSeparator(despSeparator),
    finalWaitMs: normalizeFinalWaitMs(finalWaitMs),
    notifyMode: normalizeNotifyMode(notifyMode),
    minDurationMs: normalizeMinDurationMs(minDurationMs),
    logMaxBytes: normalizeLogMaxBytes(logMaxBytes),
    logKeepFiles: normalizeLogKeepFiles(logKeepFiles),
    debugLogs: normalizeBoolean(debugLogs, DEFAULT_DEBUG_LOGS),
    titleTemplate: normalizeTemplate(titleTemplate, DEFAULT_TITLE_TEMPLATE),
    despTemplate: normalizeTemplate(despTemplate, DEFAULT_DESP_TEMPLATE),
    finalTextPreviewHeadChars: normalizePreviewChars(finalTextPreviewHeadChars, DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS),
    finalTextPreviewTailChars: normalizePreviewChars(finalTextPreviewTailChars, DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS),
    finalTextPreviewMarker: normalizeDespSeparator(finalTextPreviewMarker),
    usageFooter: normalizeBoolean(usageFooter, DEFAULT_USAGE_FOOTER),
    usageDetail: normalizeUsageDetail(usageDetail, DEFAULT_USAGE_DETAIL),
  };
}

export function pushkeyForPlatform(config, platform = "codex") {
  if (config?.agentPushKey && (!platform || config.agentType === platform || config.agentId === platform)) {
    return String(config.agentPushKey);
  }
  const agent = config?.agents?.[platform];
  if (agent?.PushKey) return String(agent.PushKey);
  if (platform === "codex") return String(config?.pushkey || "");
  if (platform === "claude") return String(config?.claudePushkey || "");
  return "";
}

export function saveConfigPatch(patch) {
  const current = readJsonIfExists(configPath(), null) ?? readJsonIfExists(configSourcePath(), {});
  const canonicalCurrent = canonicalizeStoredConfig(current, { fillAgentDefaults: true });
  const canonicalPatch = canonicalizeStoredConfig(patch);
  writeJson0600(configPath(), configWithChineseComments({
    ...mergeStoredConfigs(DEFAULT_STORED_CONFIG, canonicalCurrent, canonicalPatch),
    configVersion: CONFIG_VERSION,
  }));
}

export function saveAgentConfigPatch(agentId, patch, { agentType = "" } = {}) {
  const id = String(agentId || agentType || "").trim().toLowerCase();
  if (!id) throw new Error("agentId is required");
  const currentRaw = readJsonIfExists(configPath(), null) ?? readJsonIfExists(configSourcePath(), {});
  const current = canonicalizeStoredConfig(currentRaw, { fillAgentDefaults: true });
  const nextAgent = {
    ...objectValue(current.agents?.[id]),
    ...(agentType ? { type: agentType } : {}),
  };
  for (const [key, value] of Object.entries(objectValue(patch))) {
    if (value === undefined) delete nextAgent[key];
    else nextAgent[key] = value;
  }
  const next = mergeStoredConfigs(DEFAULT_STORED_CONFIG, {
    ...current,
    agents: { ...objectValue(current.agents), [id]: nextAgent },
  });
  writeJson0600(configPath(), configWithChineseComments({ ...next, configVersion: CONFIG_VERSION }));
}

export function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function redactText(value) {
  return String(value || "")
    .replace(/PDU[A-Za-z0-9_-]{12,}/g, "[PUSHDEER_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[OPENAI_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [TOKEN]")
    .replace(/([?&](?:token|key|secret|pushkey|access_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/\S{80,}/g, "[LONG_URL]");
}

function redactObject(value) {
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const numericTokenCount = /tokens?$/i.test(key) && typeof item === "number";
    if (!numericTokenCount && /key|secret|token|pushkey/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactObject(item);
    }
  }
  return output;
}

export function charLength(value) {
  return Array.from(String(value || "")).length;
}

export function takeChars(value, maxChars) {
  return Array.from(String(value || "")).slice(0, maxChars).join("");
}

export function normalizeSummaryCharBounds(minValue, maxValue) {
  let summaryMinChars = Number.parseInt(minValue, 10);
  let summaryMaxChars = Number.parseInt(maxValue, 10);
  if (!Number.isFinite(summaryMinChars) || summaryMinChars < 0) {
    summaryMinChars = DEFAULT_SUMMARY_MIN_CHARS;
  }
  if (!Number.isFinite(summaryMaxChars) || summaryMaxChars <= 0) {
    summaryMaxChars = DEFAULT_SUMMARY_MAX_CHARS;
  }
  summaryMinChars = Math.min(summaryMinChars, 500);
  summaryMaxChars = Math.min(summaryMaxChars, 500);
  if (summaryMaxChars < summaryMinChars) {
    summaryMaxChars = summaryMinChars;
  }
  return {
    summaryMinChars,
    summaryMaxChars,
  };
}

export function normalizeDespMaxChars(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DESP_MAX_CHARS;
  if (parsed < 0) return -1;
  return Math.min(parsed, MAX_DESP_MAX_CHARS);
}

export function normalizeDespSeparator(value) {
  if (value === false || value === null) return "";
  return String(value ?? DEFAULT_DESP_SEPARATOR).replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

export function normalizeFinalWaitMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FINAL_WAIT_MS;
  return Math.min(parsed, 60_000);
}

export function normalizeNotifyMode(value) {
  const mode = String(value || DEFAULT_NOTIFY_MODE).trim().toLowerCase();
  if (mode === "manual") return "off";
  return NOTIFY_MODES.includes(mode) ? mode : DEFAULT_NOTIFY_MODE;
}

export function normalizeMinDurationMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_DURATION_MS;
  return Math.min(parsed, 24 * 60 * 60 * 1000);
}

export function normalizeLogMaxBytes(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOG_MAX_BYTES;
  return Math.min(parsed, 100 * 1024 * 1024);
}

export function normalizeLogKeepFiles(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOG_KEEP_FILES;
  return Math.min(parsed, 20);
}

export function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "on", "enabled"].includes(text)) return true;
  if (["false", "no", "off", "disabled"].includes(text)) return false;
  return Boolean(fallback);
}

export function normalizeTemplate(value, fallback) {
  const template = String(value ?? "");
  return template ? template : fallback;
}

export function normalizePreviewChars(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, 2000);
}

function logSettings() {
  const config = readJsonIfExists(configSourcePath(), {});
  return {
    logMaxBytes: normalizeLogMaxBytes(
      envValue("AGENTPING_LOG_MAX_BYTES", "CODEX_PUSHDEER_LOG_MAX_BYTES") ??
        config.logMaxBytes ??
        config.log_max_bytes ??
        DEFAULT_LOG_MAX_BYTES,
    ),
    logKeepFiles: normalizeLogKeepFiles(
      envValue("AGENTPING_LOG_KEEP_FILES", "CODEX_PUSHDEER_LOG_KEEP_FILES") ??
        config.logKeepFiles ??
        config.log_keep_files ??
        DEFAULT_LOG_KEEP_FILES,
    ),
    debugLogs: normalizeBoolean(
      envValue("AGENTPING_DEBUG_LOGS", "CODEX_PUSHDEER_DEBUG_LOGS") ??
        config.debugLogs ??
        config.debug_logs ??
        DEFAULT_DEBUG_LOGS,
      DEFAULT_DEBUG_LOGS,
    ),
  };
}

export function debugLogsEnabled(config = null) {
  if (config && Object.prototype.hasOwnProperty.call(config, "debugLogs")) {
    return normalizeBoolean(config.debugLogs, DEFAULT_DEBUG_LOGS);
  }
  return logSettings().debugLogs;
}

export function logTextMeta(name, value, { config = null, maxChars = 1000 } = {}) {
  const text = String(value || "");
  const meta = {
    [`${name}Chars`]: charLength(text),
  };
  if (debugLogsEnabled(config)) {
    meta[name] = takeChars(redactText(text), maxChars);
  }
  return meta;
}

export function logPath(index = 0) {
  const base = statePath("notifier.log");
  return index > 0 ? `${base}.${index}` : base;
}

export function rotateLogIfNeeded({ force = false } = {}) {
  const { logMaxBytes, logKeepFiles } = logSettings();
  const base = logPath();
  if (logMaxBytes <= 0 || logKeepFiles <= 0) return false;
  try {
    const stat = fs.statSync(base);
    if (!force && stat.size < logMaxBytes) return false;
  } catch {
    return false;
  }

  for (let index = logKeepFiles; index >= 1; index -= 1) {
    const from = logPath(index);
    const to = logPath(index + 1);
    try {
      if (index === logKeepFiles) {
        fs.rmSync(from, { force: true });
      } else if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    } catch {
      // Ignore rotation races; logging must remain best-effort.
    }
  }

  try {
    fs.renameSync(base, logPath(1));
    return true;
  } catch {
    return false;
  }
}

export function truncateDesp(finalText, maxChars = DEFAULT_DESP_MAX_CHARS) {
  const normalizedMax = normalizeDespMaxChars(maxChars);
  if (normalizedMax < 0) return String(finalText || "");
  if (normalizedMax === 0) return "";
  return takeChars(String(finalText || ""), normalizedMax);
}

export function formatDesp(
  finalText,
  {
    maxChars = DEFAULT_DESP_MAX_CHARS,
    separator = DEFAULT_DESP_SEPARATOR,
  } = {},
) {
  const text = String(finalText || "");
  const normalizedMax = normalizeDespMaxChars(maxChars);
  if (!text || normalizedMax === 0) return "";

  const normalizedSeparator = normalizeDespSeparator(separator);
  if (normalizedMax < 0) return `${normalizedSeparator}${text}`;
  if (!normalizedSeparator) return takeChars(text, normalizedMax);

  const separatorText = takeChars(normalizedSeparator, normalizedMax);
  const remainingChars = normalizedMax - charLength(separatorText);
  if (remainingChars <= 0) return separatorText;
  return `${separatorText}${takeChars(text, remainingChars)}`;
}

function formatDurationMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return "";
  if (parsed < 1000) return `${parsed}ms`;
  return `${Math.round(parsed / 100) / 10}s`;
}

function formatDurationZh(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return "";
  const totalSeconds = Math.max(0, Math.round(parsed / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分 ${seconds}秒`;
}

export function formatFinalTextPreview(finalText, {
  headChars = DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS,
  tailChars = DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS,
  marker = DEFAULT_FINAL_TEXT_PREVIEW_MARKER,
} = {}) {
  const text = String(finalText || "");
  if (!text) return "";
  const chars = Array.from(text);
  const normalizedHead = normalizePreviewChars(headChars, DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS);
  const normalizedTail = normalizePreviewChars(tailChars, DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS);
  if (chars.length <= normalizedHead + normalizedTail) return balanceMarkdownPreviewSegment(text);
  const headEnd = previewHeadBoundary(chars, normalizedHead);
  const tailStart = previewTailBoundary(chars, normalizedTail);
  if (headEnd >= tailStart) return balanceMarkdownPreviewSegment(text);
  const head = chars.slice(0, headEnd).join("");
  const tail = chars.slice(tailStart).join("");
  const tailFence = markdownFenceState(chars.slice(0, tailStart).join(""));
  return [
    balanceMarkdownPreviewSegment(head),
    normalizeDespSeparator(marker),
    balanceMarkdownPreviewSegment(tail, tailFence, Boolean(tailFence)),
  ].join("");
}

function markdownFenceState(text, initialFence = null) {
  let fence = initialFence ? { ...initialFence } : null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!match) continue;
    const marker = match[1];
    if (!fence) {
      fence = { character: marker[0], length: marker.length };
      continue;
    }
    if (marker[0] === fence.character && marker.length >= fence.length && !match[2].trim()) {
      fence = null;
    }
  }
  return fence;
}

function balanceMarkdownPreviewSegment(text, initialFence = null, reopenInitialFence = false) {
  const value = String(text || "");
  const openingMarker = initialFence
    ? initialFence.character.repeat(initialFence.length)
    : "";
  const prefix = reopenInitialFence && openingMarker ? `${openingMarker}\n` : "";
  const endingFence = markdownFenceState(value, initialFence);
  if (!endingFence) return `${prefix}${value}`;
  const separator = value.endsWith("\n") || !value ? "" : "\n";
  return `${prefix}${value}${separator}${endingFence.character.repeat(endingFence.length)}`;
}

const STRONG_PREVIEW_BOUNDARIES = new Set(["。", "！", "？", "；", ".", "!", "?", ";", "\n"]);
const WEAK_PREVIEW_BOUNDARIES = new Set(["，", "、", "：", ",", ":"]);

function previewBoundaryOvershoot(targetChars) {
  return Math.max(20, Math.min(80, Math.round(targetChars * 0.25)));
}

function previewHeadBoundary(chars, targetChars) {
  if (targetChars <= 0) return 0;
  const target = Math.min(targetChars, chars.length);
  const limit = Math.min(chars.length, target + previewBoundaryOvershoot(targetChars));
  for (const boundaries of [STRONG_PREVIEW_BOUNDARIES, WEAK_PREVIEW_BOUNDARIES]) {
    for (let index = target - 1; index < limit; index += 1) {
      if (boundaries.has(chars[index])) return index + 1;
    }
  }
  return target;
}

function previewTailBoundary(chars, targetChars) {
  if (targetChars <= 0) return chars.length;
  const target = Math.max(0, chars.length - targetChars);
  const limit = Math.max(0, target - previewBoundaryOvershoot(targetChars));
  for (const boundaries of [STRONG_PREVIEW_BOUNDARIES, WEAK_PREVIEW_BOUNDARIES]) {
    for (let index = target - 1; index >= limit; index -= 1) {
      if (boundaries.has(chars[index])) return index + 1;
    }
  }
  return target;
}

export function renderTemplate(template, context = {}) {
  return String(template || "").replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name) => {
    if (name === "duration") return formatDurationMs(context.durationMs);
    if (name === "durationZh") return formatDurationZh(context.durationMs);
    if (!Object.prototype.hasOwnProperty.call(context, name)) return match;
    return String(context[name] ?? "");
  });
}

export function formatNotificationFields({
  summary,
  finalText,
  config = {},
  turnId = "",
  terminalType = "",
  durationMs = null,
  summarySource = "",
  summaryModel = "",
  summaryElapsedMs = null,
  model = "",
  provider = "",
  usage = null,
} = {}) {
  const normalizedConfig = {
    despMaxChars: normalizeDespMaxChars(config.despMaxChars),
    despSeparator: normalizeDespSeparator(config.despSeparator),
    titleTemplate: normalizeTemplate(config.titleTemplate, DEFAULT_TITLE_TEMPLATE),
    despTemplate: normalizeTemplate(config.despTemplate, DEFAULT_DESP_TEMPLATE),
    finalTextPreviewHeadChars: normalizePreviewChars(config.finalTextPreviewHeadChars, DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS),
    finalTextPreviewTailChars: normalizePreviewChars(config.finalTextPreviewTailChars, DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS),
    finalTextPreviewMarker: normalizeDespSeparator(config.finalTextPreviewMarker ?? DEFAULT_FINAL_TEXT_PREVIEW_MARKER),
    usageFooter: normalizeBoolean(config.usageFooter, DEFAULT_USAGE_FOOTER),
    usageDetail: normalizeUsageDetail(config.usageDetail, DEFAULT_USAGE_DETAIL),
  };
  const normalizedUsage = normalizeUsage(usage, { model, provider });
  const usageFooter = formatUsageFooter(normalizedUsage, {
    usageFooter: normalizedConfig.usageFooter,
    usageDetail: normalizedConfig.usageDetail,
    model,
    provider,
  });
  const context = {
    summary,
    finalText,
    finalTextPreview: formatFinalTextPreview(finalText, {
      headChars: normalizedConfig.finalTextPreviewHeadChars,
      tailChars: normalizedConfig.finalTextPreviewTailChars,
      marker: normalizedConfig.finalTextPreviewMarker,
    }),
    separator: normalizedConfig.despSeparator,
    turnId,
    terminalType,
    durationMs,
    summarySource,
    summaryModel,
    summaryElapsedMs,
    taskModel: model,
    taskProvider: provider,
    inputTokens: formatTokenCount(normalizedUsage?.inputTokens),
    cachedInputTokens: formatTokenCount(normalizedUsage?.cachedInputTokens),
    cacheCreationInputTokens: formatTokenCount(normalizedUsage?.cacheCreationInputTokens),
    outputTokens: formatTokenCount(normalizedUsage?.outputTokens),
    reasoningTokens: formatTokenCount(normalizedUsage?.reasoningTokens),
    totalTokens: formatTokenCount(normalizedUsage?.totalTokens),
    usageFooter,
  };
  const title = normalizeWhitespace(renderTemplate(normalizedConfig.titleTemplate, context)) ||
    normalizeWhitespace(summary);
  if (normalizedConfig.despMaxChars === 0) {
    return {
      title,
      desp: "",
    };
  }
  const templateHasUsageFooter = normalizedConfig.despTemplate.includes("{usageFooter}");
  let renderedDesp = renderTemplate(normalizedConfig.despTemplate, context);
  if (usageFooter && !templateHasUsageFooter) {
    renderedDesp = `${renderedDesp.trimEnd()}\n\n${usageFooter}`;
  }
  const desp = normalizedConfig.despMaxChars < 0
    ? renderedDesp
    : takeChars(renderedDesp, normalizedConfig.despMaxChars);
  return {
    title,
    desp,
  };
}

function firstCompleteSegment(text, maxChars) {
  const chars = Array.from(String(text || ""));
  let bestEnd = -1;
  const punctuation = new Set(["。", "！", "？", "；", ".", "!", "?", ";"]);
  for (let i = 0; i < chars.length && i < maxChars; i += 1) {
    if (punctuation.has(chars[i])) bestEnd = i + 1;
  }
  if (bestEnd <= 0) return "";
  return chars.slice(0, bestEnd).join("").trim();
}

export function fallbackDescription(finalText, options = {}) {
  const text = normalizeWhitespace(redactText(finalText));
  if (!text) return "未提取到有效回答内容。";
  const { summaryMinChars, summaryMaxChars } = normalizeSummaryCharBounds(
    options.summaryMinChars,
    options.summaryMaxChars,
  );
  if (charLength(text) <= summaryMaxChars) return text;
  const sentence = firstCompleteSegment(text, summaryMaxChars);
  if (sentence && charLength(sentence) >= Math.min(summaryMinChars, summaryMaxChars)) {
    return sentence;
  }
  return "回答已完成，但摘要模型未能及时生成；请查看下方原始回答内容。";
}

export function summarizeFinalText(finalText, options = {}) {
  const description = fallbackDescription(finalText, options);
  return {
    title: description,
    desp: description,
  };
}

function collectTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.text || item.output_text || item.content || "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractFinalTextFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";

  const directKeys = [
    "final_message",
    "finalMessage",
    "assistant_output",
    "assistantOutput",
    "assistant_message",
    "assistantMessage",
    "last_message",
    "lastMessage",
    "message",
    "text",
    "output",
  ];

  for (const key of directKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  if (payload.content) {
    const contentText = collectTextFromContent(payload.content);
    if (contentText.trim()) return contentText;
  }

  if (payload.payload && typeof payload.payload === "object") {
    const nested = extractFinalTextFromPayload(payload.payload);
    if (nested) return nested;
  }

  if (Array.isArray(payload.messages)) {
    for (let i = payload.messages.length - 1; i >= 0; i -= 1) {
      const item = payload.messages[i];
      if (item?.role === "assistant") {
        const text = collectTextFromContent(item.content) || item.text || item.message;
        if (text) return text;
      }
    }
  }

  return "";
}

export function extractTurnId(payload) {
  if (!payload || typeof payload !== "object") return "";
  return (
    payload.turn_id ||
    payload.turnId ||
    payload.id ||
    payload.payload?.turn_id ||
    payload.payload?.turnId ||
    payload.internal_chat_message_metadata_passthrough?.turn_id ||
    payload.payload?.internal_chat_message_metadata_passthrough?.turn_id ||
    ""
  );
}

function getSessionRoot() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

function newestJsonlFiles(root, limit = 8) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(fullPath);
          files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore files that disappear while scanning.
        }
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => item.filePath);
}

function isFinalPhase(phase) {
  return phase === "final_answer" || phase === "final";
}

function payloadMessageText(payload) {
  if (!payload || typeof payload !== "object") return "";
  return (
    collectTextFromContent(payload.content) ||
    payload.last_agent_message ||
    payload.message ||
    payload.text ||
    payload.output ||
    ""
  );
}

function getTurnRecord(turns, turnId) {
  if (!turnId) return null;
  if (!turns.has(turnId)) {
    turns.set(turnId, {
      turnId,
      cwd: "",
      finalText: "",
      finalTimestamp: "",
      startedTimestamp: "",
      terminalTimestamp: "",
      terminalType: "",
      durationMs: null,
      taskComplete: false,
      userText: "",
      model: "",
      provider: "",
      usage: null,
    });
  }
  return turns.get(turnId);
}

function parseCodexSessionFile(filePath) {
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, "utf8").trim().split(/\n+/);
  } catch {
    return null;
  }

  const turns = new Map();
  let activeTurnId = "";
  let sessionId = "";
  let parentSessionId = "";
  let threadSource = "";
  let isSubagent = false;
  let provider = "";
  let previousTotalUsage = null;

  for (const line of lines) {
    const item = safeJsonParse(line);
    if (!item || typeof item !== "object") continue;
    const payload = item.payload || {};

    if (item.type === "session_meta") {
      sessionId = String(payload.id || payload.session_id || "").trim();
      parentSessionId = String(
        payload.parent_thread_id || payload.source?.subagent?.thread_spawn?.parent_thread_id || "",
      ).trim();
      threadSource = String(payload.thread_source || "").trim().toLowerCase();
      isSubagent = threadSource === "subagent" || Boolean(parentSessionId) || Boolean(payload.source?.subagent);
      provider = String(payload.model_provider || "").trim();
    }

    if (item.type === "event_msg" && payload.type === "task_started" && payload.turn_id) {
      activeTurnId = payload.turn_id;
    }

    if (item.type === "turn_context" && payload) {
      activeTurnId = payload.turn_id || activeTurnId;
      const record = getTurnRecord(turns, activeTurnId);
      if (record) {
        record.cwd = payload.cwd || record.cwd;
        record.model = String(payload.model || record.model || "").trim();
        record.provider = provider || record.provider;
      }
    }

    const itemTurnId = extractTurnId(payload) || activeTurnId;
    const record = getTurnRecord(turns, itemTurnId);
    if (!record) continue;
    record.provider ||= provider;

    if (item.type === "event_msg" && payload.type === "task_started") {
      record.startedTimestamp = item.timestamp || record.startedTimestamp;
    }

    if (item.type === "event_msg" && payload.type === "thread_settings_applied" && payload.model) {
      record.model = String(payload.model).trim() || record.model;
    }

    if (item.type === "event_msg" && payload.type === "token_count" && payload.info) {
      const currentTotalUsage = payload.info.total_token_usage || null;
      const fallbackUsage = payload.info.last_token_usage || null;
      const delta = usageDelta(currentTotalUsage, previousTotalUsage, fallbackUsage, {
        model: record.model,
        provider: record.provider,
      });
      const tokenComponents = delta?.breakdown?.[0];
      if ((tokenComponents?.inputTokens || 0) > 0 || (tokenComponents?.outputTokens || 0) > 0) {
        record.usage = mergeUsage(record.usage, delta);
      }
      if (currentTotalUsage) previousTotalUsage = currentTotalUsage;
    }

    if (item.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const text = payloadMessageText(payload);
      if (text.trim()) record.userText = `${record.userText}\n${text}`.trim();
    }

    if (item.type === "response_item" && payload.type === "message" && payload.role === "assistant" && isFinalPhase(payload.phase)) {
      const text = payloadMessageText(payload);
      if (text.trim()) {
        record.finalText = text;
        record.finalTimestamp = item.timestamp || record.finalTimestamp;
      }
    }

    if (item.type === "event_msg" && payload.type === "agent_message" && isFinalPhase(payload.phase)) {
      const text = payloadMessageText(payload);
      if (text.trim()) {
        record.finalText = text;
        record.finalTimestamp = item.timestamp || record.finalTimestamp;
      }
    }

    if (item.type === "event_msg" && payload.type === "user_message") {
      const text = payloadMessageText(payload);
      if (text.trim()) record.userText = `${record.userText}\n${text}`.trim();
    }

    if (item.type === "event_msg" && payload.type === "task_complete") {
      record.taskComplete = true;
      record.terminalType = payload.type;
      record.terminalTimestamp = item.timestamp || record.terminalTimestamp;
      const text = payloadMessageText(payload);
      if (text.trim()) {
        record.finalText = text;
        record.finalTimestamp = item.timestamp || record.finalTimestamp;
      }
    }

    if (item.type === "event_msg" && ["task_failed", "task_cancelled", "task_interrupted"].includes(payload.type)) {
      record.terminalType = payload.type;
      record.terminalTimestamp = item.timestamp || record.terminalTimestamp;
      const text = payloadMessageText(payload);
      if (text.trim()) {
        record.finalText = text;
        record.finalTimestamp = item.timestamp || record.finalTimestamp;
      }
    }
  }

  return {
    filePath,
    sessionId,
    parentSessionId,
    threadSource,
    isSubagent,
    provider,
    turns: Array.from(turns.values()),
  };
}

function parseFinalFromSessionFile(filePath, { cwd = "", turnId = "", requireTaskComplete = true } = {}) {
  const session = parseCodexSessionFile(filePath);
  if (!session) return null;

  const candidates = turnId
    ? session.turns.filter((record) => record.turnId === turnId)
    : session.turns
      .filter((record) => {
        if (!record.finalText) return false;
        if (cwd && record.cwd && path.resolve(cwd) !== path.resolve(record.cwd)) return false;
        return true;
      })
      .sort((a, b) => String(b.finalTimestamp).localeCompare(String(a.finalTimestamp)));

  const result = candidates[0];
  if (!result?.finalText) return null;
  if (requireTaskComplete && !result.taskComplete) return null;

  return {
    finalText: result.finalText,
    turnId: result.turnId,
    timestamp: result.finalTimestamp,
    sessionFile: session.filePath,
    taskComplete: result.taskComplete,
    terminalType: result.terminalType,
    startedTimestamp: result.startedTimestamp,
    terminalTimestamp: result.terminalTimestamp,
    durationMs: calculateDurationMs(result.startedTimestamp, result.terminalTimestamp),
    userText: result.userText,
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    threadSource: session.threadSource,
    isSubagent: session.isSubagent,
    model: result.model,
    provider: result.provider || session.provider,
    usage: normalizeUsage(result.usage, {
      model: result.model,
      provider: result.provider || session.provider,
    }),
  };
}

function timestampInRange(value, start, end) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return false;
  return (!Number.isFinite(start) || timestamp >= start) && (!Number.isFinite(end) || timestamp <= end);
}

function parseCodexSessionMetadata(filePath, maxBytes = 256 * 1024) {
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const size = Math.min(fs.fstatSync(handle).size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(handle, buffer, 0, size, 0);
    for (const line of buffer.toString("utf8").split("\n")) {
      const item = safeJsonParse(line);
      if (item?.type !== "session_meta") continue;
      const payload = item.payload || {};
      const sessionId = String(payload.id || payload.session_id || "").trim();
      if (!sessionId) return null;
      return {
        filePath,
        sessionId,
        parentSessionId: String(
          payload.parent_thread_id ||
          payload.parentThreadId ||
          payload.source?.subagent?.parent_thread_id ||
          "",
        ).trim(),
      };
    }
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Ignore a close race on a session file that changed while being read.
      }
    }
  }
  return null;
}

function aggregateCodexDescendantUsage(result, files) {
  if (!result?.sessionId || result.isSubagent) return result?.usage || null;
  const start = Date.parse(result.startedTimestamp || "");
  const candidateFiles = Number.isFinite(start)
    ? files.filter((filePath) => {
        try {
          return fs.statSync(filePath).mtimeMs >= start - 60_000;
        } catch {
          return false;
        }
      })
    : files;
  const sessions = candidateFiles
    .map((filePath) => parseCodexSessionMetadata(filePath))
    .filter(Boolean);
  const descendants = new Set([result.sessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (session.sessionId && descendants.has(session.parentSessionId) && !descendants.has(session.sessionId)) {
        descendants.add(session.sessionId);
        changed = true;
      }
    }
  }
  const end = Date.parse(result.terminalTimestamp || "");
  const childUsage = [];
  for (const metadata of sessions) {
    if (metadata.sessionId === result.sessionId || !descendants.has(metadata.sessionId)) continue;
    const session = parseCodexSessionFile(metadata.filePath);
    if (!session) continue;
    for (const turn of session.turns) {
      const completedInRange = timestampInRange(turn.terminalTimestamp || turn.finalTimestamp, start, end);
      const startedBeforeEnd = !Number.isFinite(end) || !turn.startedTimestamp || Date.parse(turn.startedTimestamp) <= end;
      if (completedInRange && startedBeforeEnd && turn.usage) childUsage.push(turn.usage);
    }
  }
  return mergeUsage(result.usage, childUsage);
}

function calculateDurationMs(startedTimestamp, terminalTimestamp) {
  const start = Date.parse(startedTimestamp || "");
  const end = Date.parse(terminalTimestamp || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export async function findLatestFinalMessage({
  cwd = process.cwd(),
  turnId = "",
  retries = null,
  timeoutMs = null,
  intervalMs = 250,
  requireTaskComplete = true,
} = {}) {
  const waitMs = timeoutMs == null
    ? (retries == null ? DEFAULT_FINAL_WAIT_MS : Math.max(0, retries) * intervalMs)
    : timeoutMs;
  const deadline = Date.now() + Math.max(0, waitMs);
  let attempt = 0;

  while (Date.now() <= deadline || attempt === 0) {
    const files = newestJsonlFiles(getSessionRoot());
    for (const filePath of files) {
      const result = parseFinalFromSessionFile(filePath, {
        cwd,
        turnId,
        requireTaskComplete,
      });
      if (result) {
        if (!result.isSubagent) {
          result.usage = aggregateCodexDescendantUsage(
            result,
            newestJsonlFiles(getSessionRoot(), 200),
          );
        }
        return result;
      }
    }
    attempt += 1;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export function wasAlreadySent(id) {
  if (!id) return false;
  const state = readJsonIfExists(statePath("sent.json"), { sent: [] });
  return Array.isArray(state.sent) && state.sent.includes(id);
}

export function markSent(id) {
  if (!id) return;
  const state = readJsonIfExists(statePath("sent.json"), { sent: [] });
  const sent = Array.isArray(state.sent) ? state.sent : [];
  const next = [id, ...sent.filter((item) => item !== id)].slice(0, 200);
  writeJson0600(statePath("sent.json"), { sent: next });
}

export async function sendPushDeer({ title, desp, endpoint, pushkey, dryRun = false }) {
  const params = new URLSearchParams({
    pushkey,
    text: title,
  });
  if (desp) params.set("desp", desp);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      title,
      desp,
      endpoint,
      params: redactObject(Object.fromEntries(params.entries())),
    };
  }

  if (!pushkey) {
    throw new Error("Missing PushDeer key. Run setup or set AGENTPING_PUSHDEER_KEY.");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const url = `${endpoint}?${params.toString()}`;
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      const body = await response.text();
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`PushDeer HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      return {
        ok: true,
        status: response.status,
        body,
      };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  throw lastError || new Error("PushDeer request failed");
}
