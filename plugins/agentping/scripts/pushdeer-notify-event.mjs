#!/usr/bin/env node
import {
  envValue,
  extractTurnId,
  findLatestFinalMessage,
  hashText,
  loadConfig,
  logEvent,
  safeJsonParse,
} from "./pushdeer-lib.mjs";
import { isInternalSummaryText } from "./completion-notify.mjs";
import { submitCompletionEvent } from "./submit-completion-event.mjs";

function loadNotificationArg() {
  return safeJsonParse(process.argv[2] || "") || {};
}

function inputMessagesText(notification) {
  const messages = notification["input-messages"] || notification.inputMessages || [];
  if (!Array.isArray(messages)) return String(messages || "");
  return messages
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.text || item.content || item.message || "";
    })
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const notification = loadNotificationArg();
  if (notification.type !== "agent-turn-complete") return;
  if (envValue("AGENTPING_SUPPRESS_NOTIFY", "CODEX_PUSHDEER_SUPPRESS_NOTIFY") === "1") return;

  const notificationInput = inputMessagesText(notification);
  if (isInternalSummaryText(notificationInput)) {
    logEvent("info", "Skipping internal PushDeer summary notify event", { platform: "codex" });
    return;
  }

  const turnId = notification["turn-id"] || notification.turnId || extractTurnId(notification);
  const config = loadConfig();
  const sessionFinal = await findLatestFinalMessage({
    cwd: process.cwd(),
    turnId,
    timeoutMs: config.finalWaitMs,
    requireTaskComplete: config.notifyMode !== "errors_only",
  });
  if (!sessionFinal?.finalText) {
    logEvent("info", "Skipping non-final PushDeer notify event", {
      platform: "codex",
      turnId,
      finalWaitMs: config.finalWaitMs,
    });
    return;
  }
  if (isInternalSummaryText(sessionFinal.userText)) {
    logEvent("info", "Skipping internal PushDeer summary session", {
      platform: "codex",
      turnId: sessionFinal.turnId || turnId,
    });
    return;
  }
  if (sessionFinal.isSubagent) {
    logEvent("info", "Skipping Codex subagent completion event", {
      platform: "codex",
      turnId: sessionFinal.turnId || turnId,
      sessionId: sessionFinal.sessionId,
      parentSessionId: sessionFinal.parentSessionId,
      threadSource: sessionFinal.threadSource,
    });
    return;
  }

  const resolvedTurnId = sessionFinal.turnId || turnId;
  const eventIdentity = resolvedTurnId || hashText(JSON.stringify(notification)).slice(0, 24);
  await submitCompletionEvent({
    agentId: "codex",
    agentType: "codex",
    eventId: `codex-${eventIdentity}`,
    sessionId: resolvedTurnId,
    status: sessionFinal.terminalType === "task_complete" ? "success" : "failed",
    finalText: sessionFinal.finalText,
    userText: sessionFinal.userText || notificationInput,
    terminalType: sessionFinal.terminalType,
    startedAt: sessionFinal.startedTimestamp,
    completedAt: sessionFinal.terminalTimestamp,
    durationMs: sessionFinal.durationMs,
    model: sessionFinal.model,
    provider: sessionFinal.provider,
    usage: sessionFinal.usage,
    cwd: process.cwd(),
  });
}

main().catch((error) => {
  logEvent("error", "PushDeer notify event failed", {
    platform: "codex",
    error: error?.message || String(error),
  });
  process.exit(0);
});
