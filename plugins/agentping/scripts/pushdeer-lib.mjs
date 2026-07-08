import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ENDPOINT = "https://api2.pushdeer.com/message/push";
export const APP_NAME = "agentping";
export const LEGACY_APP_NAME = "codex-pushdeer-notifier";
export const DEFAULT_SUMMARY_MODEL = "gpt-5.4-mini";
export const DEFAULT_SUMMARY_MIN_CHARS = 30;
export const DEFAULT_SUMMARY_MAX_CHARS = 60;
export const DEFAULT_LLM_TIMEOUT_MS = 12_000;
export const DEFAULT_DESP_MAX_CHARS = 300;
export const DEFAULT_DESP_SEPARATOR = "\n-----\n";
export const DEFAULT_FINAL_WAIT_MS = 8_000;
export const DEFAULT_NOTIFY_MODE = "always";
export const DEFAULT_MIN_DURATION_MS = 30_000;
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LOG_KEEP_FILES = 3;
export const NOTIFY_MODES = ["always", "long_only", "errors_only", "off"];

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

export function loadConfig() {
  const config = readJsonIfExists(configSourcePath(), {});
  const endpoint =
    envValue("AGENTPING_PUSHDEER_ENDPOINT", "AGENTPING_ENDPOINT", "PUSHDEER_ENDPOINT", "CODEX_PUSHDEER_ENDPOINT") ||
    config.pushdeerEndpoint ||
    config.endpoint ||
    DEFAULT_ENDPOINT;
  const pushkey =
    envValue("AGENTPING_PUSHDEER_KEY", "AGENTPING_KEY", "PUSHDEER_KEY", "CODEX_PUSHDEER_KEY") ||
    config.pushkey ||
    config.pushKey ||
    "";
  const summaryModel =
    envValue("AGENTPING_SUMMARY_MODEL", "CODEX_PUSHDEER_SUMMARY_MODEL") ||
    config.summaryModel ||
    config.summary_model ||
    DEFAULT_SUMMARY_MODEL;
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
  const llmTimeoutMs = Number.parseInt(
    envValue("AGENTPING_LLM_TIMEOUT_MS", "CODEX_PUSHDEER_LLM_TIMEOUT_MS") ||
      config.llmTimeoutMs ||
      config.llm_timeout_ms ||
      String(DEFAULT_LLM_TIMEOUT_MS),
    10,
  );
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
  const summaryBounds = normalizeSummaryCharBounds(summaryMinChars, summaryMaxChars);

  return {
    ...config,
    endpoint,
    pushkey,
    summaryModel,
    ...summaryBounds,
    llmTimeoutMs: Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
      ? llmTimeoutMs
      : DEFAULT_LLM_TIMEOUT_MS,
    despMaxChars: normalizeDespMaxChars(despMaxChars),
    despSeparator: normalizeDespSeparator(despSeparator),
    finalWaitMs: normalizeFinalWaitMs(finalWaitMs),
    notifyMode: normalizeNotifyMode(notifyMode),
    minDurationMs: normalizeMinDurationMs(minDurationMs),
    logMaxBytes: normalizeLogMaxBytes(logMaxBytes),
    logKeepFiles: normalizeLogKeepFiles(logKeepFiles),
  };
}

export function saveConfigPatch(patch) {
  const current = readJsonIfExists(configPath(), null) ?? readJsonIfExists(configSourcePath(), {});
  writeJson0600(configPath(), {
    ...current,
    ...patch,
  });
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
    if (/key|secret|token|pushkey/i.test(key)) {
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
  if (parsed < 0) return 0;
  return Math.min(parsed, DEFAULT_DESP_MAX_CHARS);
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
  };
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
  if (normalizedMax <= 0) return "";
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
  if (!text || normalizedMax <= 0) return "";

  const normalizedSeparator = normalizeDespSeparator(separator);
  if (!normalizedSeparator) return takeChars(text, normalizedMax);

  const separatorText = takeChars(normalizedSeparator, normalizedMax);
  const remainingChars = normalizedMax - charLength(separatorText);
  if (remainingChars <= 0) return separatorText;
  return `${separatorText}${takeChars(text, remainingChars)}`;
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
    });
  }
  return turns.get(turnId);
}

function parseFinalFromSessionFile(filePath, { cwd = "", turnId = "", requireTaskComplete = true } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, "utf8").trim().split(/\n+/);
  } catch {
    return null;
  }

  const turns = new Map();
  let activeTurnId = "";

  for (const line of lines) {
    const item = safeJsonParse(line);
    if (!item || typeof item !== "object") continue;
    const payload = item.payload || {};

    if (item.type === "turn_context" && payload) {
      activeTurnId = payload.turn_id || activeTurnId;
      const record = getTurnRecord(turns, activeTurnId);
      if (record) record.cwd = payload.cwd || record.cwd;
    }

    const itemTurnId = extractTurnId(payload) || activeTurnId;
    const record = getTurnRecord(turns, itemTurnId);
    if (!record) continue;

    if (item.type === "event_msg" && payload.type === "task_started") {
      record.startedTimestamp = item.timestamp || record.startedTimestamp;
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

  const candidates = turnId
    ? [turns.get(turnId)].filter(Boolean)
    : Array.from(turns.values())
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
    sessionFile: filePath,
    taskComplete: result.taskComplete,
    terminalType: result.terminalType,
    startedTimestamp: result.startedTimestamp,
    terminalTimestamp: result.terminalTimestamp,
    durationMs: calculateDurationMs(result.startedTimestamp, result.terminalTimestamp),
    userText: result.userText,
  };
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
      if (result) return result;
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
