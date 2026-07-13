#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  envValue,
  hashText,
  logEvent,
  readStdin,
  safeJsonParse,
} from "./pushdeer-lib.mjs";
import { isInternalSummaryText } from "./completion-notify.mjs";
import { readClaudeTranscriptCompletion } from "./claude-transcript.mjs";
import { submitCompletionEvent } from "./submit-completion-event.mjs";

function allowedTranscriptPath(value) {
  if (!value) return "";
  const resolved = path.resolve(String(value));
  if (envValue("AGENTPING_ALLOW_ANY_CLAUDE_TRANSCRIPT") === "1") return resolved;
  try {
    const root = fs.realpathSync(path.join(os.homedir(), ".claude", "projects"));
    const realPath = fs.realpathSync(resolved);
    const relative = path.relative(root, realPath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? realPath : "";
  } catch {
    return "";
  }
}

function safeWorkingDirectory(value) {
  if (!value || !path.isAbsolute(value)) return process.cwd();
  try {
    return fs.statSync(value).isDirectory() ? value : process.cwd();
  } catch {
    return process.cwd();
  }
}

async function main() {
  if (envValue("AGENTPING_SUPPRESS_NOTIFY", "CODEX_PUSHDEER_SUPPRESS_NOTIFY") === "1") return;
  const hook = safeJsonParse(await readStdin()) || {};
  const hookEvent = String(hook.hook_event_name || "");
  if (hookEvent !== "Stop" && hookEvent !== "StopFailure") return;

  const transcriptPath = allowedTranscriptPath(hook.transcript_path);
  let transcript = {
    userText: "",
    assistantUuid: "",
    durationMs: null,
  };
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    transcript = await readClaudeTranscriptCompletion(transcriptPath);
  }

  if (isInternalSummaryText(transcript.userText)) {
    logEvent("info", "Skipping internal PushDeer summary session", {
      platform: "claude",
      sessionId: hook.session_id,
    });
    return;
  }

  const failed = hookEvent === "StopFailure";
  const errorText = [hook.error, hook.error_details].filter(Boolean).join(": ");
  const finalText = String(
    hook.last_assistant_message ||
    (failed ? `Claude Code 任务失败：${errorText || "未知错误"}` : ""),
  ).trim();
  if (!finalText) {
    logEvent("info", "Skipping Claude notify event without final text", {
      platform: "claude",
      sessionId: hook.session_id,
      hookEvent,
    });
    return;
  }

  const sessionId = String(hook.session_id || "unknown");
  const eventIdentity = transcript.assistantUuid || hashText(`${finalText}\n${errorText}`).slice(0, 24);
  const durationMs = transcript.durationMs ??
    (failed && Number.isFinite(transcript.userStartedAt)
      ? Math.max(0, Date.now() - transcript.userStartedAt)
      : null);
  await submitCompletionEvent({
    agentId: "claude",
    agentType: "claude",
    eventId: `claude-${sessionId}-${failed ? `failure-${hook.error || "unknown"}-` : ""}${eventIdentity}`,
    sessionId,
    status: failed ? "failed" : "success",
    finalText,
    userText: transcript.userText,
    terminalType: failed ? "task_failed" : "task_complete",
    startedAt: transcript.userStartedAt,
    completedAt: transcript.assistantCompletedAt,
    durationMs,
    model: transcript.model,
    provider: transcript.provider,
    usage: transcript.usage,
    cwd: safeWorkingDirectory(hook.cwd),
  });
}

main().catch((error) => {
  logEvent("error", "Claude PushDeer notify event failed", {
    platform: "claude",
    error: error?.message || String(error),
  });
  process.exit(0);
});
