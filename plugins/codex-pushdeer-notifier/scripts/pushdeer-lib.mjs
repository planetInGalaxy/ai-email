import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ENDPOINT = "https://api2.pushdeer.com/message/push";
export const APP_NAME = "codex-pushdeer-notifier";
export const DEFAULT_SUMMARY_MODEL = "gpt-5.4-mini";
export const DEFAULT_LLM_TIMEOUT_MS = 12_000;
export const DEFAULT_DESP_MAX_CHARS = 300;
export const DEFAULT_DESP_SEPARATOR = "\n-----\n";

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function configPath() {
  return expandHome(
    process.env.CODEX_PUSHDEER_CONFIG ||
      path.join(os.homedir(), ".config", APP_NAME, "config.json"),
  );
}

export function stateDir() {
  return expandHome(
    process.env.CODEX_PUSHDEER_STATE_DIR ||
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
  const config = readJsonIfExists(configPath(), {});
  const endpoint =
    process.env.PUSHDEER_ENDPOINT ||
    process.env.CODEX_PUSHDEER_ENDPOINT ||
    config.pushdeerEndpoint ||
    config.endpoint ||
    DEFAULT_ENDPOINT;
  const pushkey =
    process.env.PUSHDEER_KEY ||
    process.env.CODEX_PUSHDEER_KEY ||
    config.pushkey ||
    config.pushKey ||
    "";
  const summaryModel =
    process.env.CODEX_PUSHDEER_SUMMARY_MODEL ||
    config.summaryModel ||
    config.summary_model ||
    DEFAULT_SUMMARY_MODEL;
  const llmTimeoutMs = Number.parseInt(
    process.env.CODEX_PUSHDEER_LLM_TIMEOUT_MS ||
      config.llmTimeoutMs ||
      config.llm_timeout_ms ||
      String(DEFAULT_LLM_TIMEOUT_MS),
    10,
  );
  const despMaxChars = Number.parseInt(
    process.env.CODEX_PUSHDEER_DESP_MAX_CHARS ??
      config.despMaxChars ??
      config.desp_max_chars ??
      String(DEFAULT_DESP_MAX_CHARS),
    10,
  );
  const despSeparator =
    process.env.CODEX_PUSHDEER_DESP_SEPARATOR ??
    config.despSeparator ??
    config.desp_separator ??
    DEFAULT_DESP_SEPARATOR;

  return {
    ...config,
    endpoint,
    pushkey,
    summaryModel,
    llmTimeoutMs: Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
      ? llmTimeoutMs
      : DEFAULT_LLM_TIMEOUT_MS,
    despMaxChars: normalizeDespMaxChars(despMaxChars),
    despSeparator: normalizeDespSeparator(despSeparator),
  };
}

export function saveConfigPatch(patch) {
  const current = readJsonIfExists(configPath(), {});
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

export function fallbackDescription(finalText) {
  const text = normalizeWhitespace(redactText(finalText));
  if (!text) return "未提取到有效回答内容。";
  return takeChars(text, 50);
}

export function summarizeFinalText(finalText) {
  const description = fallbackDescription(finalText);
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

function parseFinalFromSessionFile(filePath, cwd) {
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, "utf8").trim().split(/\n+/);
  } catch {
    return null;
  }

  let latestCwd = "";
  let latestTurnId = "";
  let latestFinal = "";
  let latestTimestamp = "";

  for (const line of lines) {
    const item = safeJsonParse(line);
    if (!item || typeof item !== "object") continue;

    if (item.type === "turn_context" && item.payload) {
      latestCwd = item.payload.cwd || latestCwd;
      latestTurnId = item.payload.turn_id || latestTurnId;
    }

    if (item.type === "response_item" && item.payload) {
      const responsePayload = item.payload;
      const turnId = extractTurnId(responsePayload) || latestTurnId;
      const phase = responsePayload.phase;
      const role = responsePayload.role;
      const text = collectTextFromContent(responsePayload.content);
      if ((phase === "final" || role === "assistant") && text.trim()) {
        latestFinal = text;
        latestTurnId = turnId || latestTurnId;
        latestTimestamp = item.timestamp || latestTimestamp;
      }
    }
  }

  if (!latestFinal) return null;
  if (cwd && latestCwd && path.resolve(cwd) !== path.resolve(latestCwd)) {
    return null;
  }

  return {
    finalText: latestFinal,
    turnId: latestTurnId,
    timestamp: latestTimestamp,
    sessionFile: filePath,
  };
}

export async function findLatestFinalMessage({ cwd = process.cwd(), retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const files = newestJsonlFiles(getSessionRoot());
    for (const filePath of files) {
      const result = parseFinalFromSessionFile(filePath, cwd);
      if (result) return result;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
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
      params: Object.fromEntries(params.entries()),
    };
  }

  if (!pushkey) {
    throw new Error("Missing PushDeer key. Run setup or set PUSHDEER_KEY.");
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
