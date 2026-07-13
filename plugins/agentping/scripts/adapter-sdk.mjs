import { hashText } from "./pushdeer-lib.mjs";
import { normalizeUsage } from "./usage.mjs";

export const COMPLETION_EVENT_SCHEMA_VERSION = 1;
export const SUPPORTED_AGENT_TYPES = ["codex", "claude", "openclaw", "hermes"];

function cleanId(value, fallback = "") {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function optionalTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.round(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalDuration(value, startedAt, completedAt) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.round(numeric);
  if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
    return completedAt - startedAt;
  }
  return null;
}

function normalizeStatus(value, terminalType) {
  const status = String(value || "").trim().toLowerCase();
  if (["success", "failed", "cancelled", "timeout", "interrupted"].includes(status)) return status;
  if (terminalType === "task_complete") return "success";
  if (terminalType === "task_cancelled") return "cancelled";
  if (terminalType === "task_interrupted") return "interrupted";
  return "failed";
}

function normalizeTerminalType(value, status) {
  const terminalType = String(value || "").trim();
  if (terminalType) return terminalType;
  if (status === "success") return "task_complete";
  if (status === "cancelled") return "task_cancelled";
  if (status === "interrupted") return "task_interrupted";
  return "task_failed";
}

export function normalizeCompletionEvent(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("completion event must be an object");
  }
  const agentType = cleanId(input.agentType || input.platform);
  if (!agentType) throw new Error("completion event agentType is required");
  const agentId = cleanId(input.agentId, agentType);
  const finalText = String(input.finalText || "").trim();
  if (!finalText) throw new Error("completion event finalText is required");
  const startedAt = optionalTimestamp(input.startedAt);
  const completedAt = optionalTimestamp(input.completedAt) ?? Date.now();
  const provisionalTerminalType = String(input.terminalType || "").trim();
  const status = normalizeStatus(input.status, provisionalTerminalType);
  const terminalType = normalizeTerminalType(provisionalTerminalType, status);
  const sessionId = String(input.sessionId || input.turnId || "").trim();
  const identitySeed = [
    agentId,
    sessionId,
    terminalType,
    input.eventIdentity || "",
    finalText,
  ].join("\n");
  const eventId = cleanId(input.eventId, `${agentId}-${hashText(identitySeed).slice(0, 32)}`);

  const model = String(input.model || "").trim();
  const provider = String(input.provider || "").trim();
  return {
    schemaVersion: COMPLETION_EVENT_SCHEMA_VERSION,
    eventId,
    agentId,
    agentType,
    hostId: cleanId(input.hostId || process.env.AGENTPING_HOST_ID, "local"),
    sessionId,
    parentSessionId: String(input.parentSessionId || "").trim(),
    isSubagent: Boolean(input.isSubagent),
    status,
    terminalType,
    startedAt,
    completedAt,
    durationMs: optionalDuration(input.durationMs, startedAt, completedAt),
    userText: String(input.userText || "").trim(),
    finalText,
    model,
    provider,
    cwd: String(input.cwd || process.cwd()),
    usage: normalizeUsage(input.usage, { model, provider }),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {},
  };
}

export function completionEventSendId(event) {
  return `${event.agentId}:${event.eventId}`;
}

export function defineAdapter(definition) {
  if (!definition || typeof definition !== "object") throw new Error("adapter definition is required");
  const id = cleanId(definition.id);
  const type = cleanId(definition.type, id);
  if (!id || !type || typeof definition.normalize !== "function") {
    throw new Error("adapter requires id, type, and normalize(input)");
  }
  return Object.freeze({ ...definition, id, type });
}
