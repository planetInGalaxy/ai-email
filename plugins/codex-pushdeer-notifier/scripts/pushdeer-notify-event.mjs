#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  charLength,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SUMMARY_MODEL,
  extractFinalTextFromPayload,
  extractTurnId,
  hashText,
  loadConfig,
  logEvent,
  markSent,
  redactText,
  safeJsonParse,
  sendPushDeer,
  summarizeFinalText,
  takeChars,
  wasAlreadySent,
} from "./pushdeer-lib.mjs";

function loadNotificationArg() {
  const raw = process.argv[2] || "";
  return safeJsonParse(raw) || {};
}

function normalizeSummary(value) {
  return redactText(value)
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .replace(/^(?:摘要|描述|推送描述)[:：]\s*/u, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function summarizeWithCodex({ finalText, notification }) {
  if (!finalText || process.env.CODEX_PUSHDEER_DISABLE_LLM_SUMMARY) {
    return "";
  }

  const config = loadConfig();
  const model = config.summaryModel || DEFAULT_SUMMARY_MODEL;
  const timeoutMs = config.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pushdeer-summary-"));
  const outputFile = path.join(tempDir, "summary.txt");
  const prompt = [
    "你是推送通知摘要器。根据用户问题和助手完整回答，生成一条中文推送描述。",
    "要求：只输出摘要正文，不要标题、引号、编号或解释；必须概括完整回答的结果，不要截取开头；不超过60个汉字；信息越少越短，信息越多越概括；不要输出密钥、token或完整长路径。",
  ].join("\n");
  const input = [
    "用户问题：",
    redactText(inputMessagesText(notification)) || "未提供",
    "",
    "助手完整回答：",
    redactText(finalText),
  ].join("\n");

  try {
    const result = spawnSync(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--disable",
        "hooks",
        "--disable",
        "plugins",
        "--ephemeral",
        "-m",
        model,
        "--output-last-message",
        outputFile,
        prompt,
      ],
      {
        cwd: process.cwd(),
        input,
        encoding: "utf8",
        timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LLM_TIMEOUT_MS,
        env: {
          ...process.env,
          CODEX_PUSHDEER_DISABLE_LLM_SUMMARY: "1",
        },
      },
    );

    if (result.status !== 0) {
      logEvent("warn", "LLM summary command failed", {
        model,
        status: result.status,
        signal: result.signal,
        stderr: result.stderr,
      });
      return "";
    }

    const summary = normalizeSummary(fs.readFileSync(outputFile, "utf8"));
    if (!summary) return "";
    return charLength(summary) > 60 ? takeChars(summary, 60) : summary;
  } catch (error) {
    logEvent("warn", "LLM summary command errored", {
      model,
      error: error?.message || String(error),
    });
    return "";
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}

async function main() {
  const notification = loadNotificationArg();
  if (notification.type !== "agent-turn-complete") {
    return;
  }

  const finalText =
    notification["last-assistant-message"] ||
    notification.lastAssistantMessage ||
    extractFinalTextFromPayload(notification);

  const turnId =
    notification["turn-id"] ||
    notification.turnId ||
    extractTurnId(notification);

  const sendId = turnId || hashText(JSON.stringify(notification)).slice(0, 24);
  if (wasAlreadySent(sendId)) {
    logEvent("info", "Skipping duplicate PushDeer notify event", { sendId });
    return;
  }

  const fallbackSummary = summarizeFinalText(finalText, notification);
  const llmDescription = summarizeWithCodex({ finalText, notification });
  const pushText = llmDescription || fallbackSummary.desp;
  const config = loadConfig();

  await sendPushDeer({
    title: pushText,
    endpoint: config.endpoint,
    pushkey: config.pushkey,
    dryRun: Boolean(process.env.CODEX_PUSHDEER_DRY_RUN),
  });

  markSent(sendId);
  logEvent("info", "PushDeer notify event sent", {
    sendId,
    text: pushText,
    summarySource: llmDescription ? "llm" : "fallback",
    summaryModel: config.summaryModel || DEFAULT_SUMMARY_MODEL,
  });
}

main().catch((error) => {
  logEvent("error", "PushDeer notify event failed", {
    error: error?.message || String(error),
  });
  process.exit(0);
});
