#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  charLength,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SUMMARY_MODEL,
  extractTurnId,
  findLatestFinalMessage,
  formatNotificationFields,
  hashText,
  envValue,
  loadConfig,
  logTextMeta,
  logEvent,
  markSent,
  redactText,
  safeJsonParse,
  sendPushDeer,
  summarizeFinalText,
  wasAlreadySent,
} from "./pushdeer-lib.mjs";

const SUMMARY_PROMPT_MARKERS = [
  "你是推送通知摘要器",
  "你是 Codex 完成通知摘要器",
];

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

function isInternalSummaryNotification(notification) {
  if (envValue("AGENTPING_SUPPRESS_NOTIFY", "CODEX_PUSHDEER_SUPPRESS_NOTIFY") === "1") return true;
  const inputText = inputMessagesText(notification);
  return SUMMARY_PROMPT_MARKERS.some((marker) => inputText.includes(marker));
}

function isInternalSummaryText(text) {
  return SUMMARY_PROMPT_MARKERS.some((marker) => String(text || "").includes(marker));
}

function summarizeWithCodex({ finalText, notification }) {
  if (!finalText || envValue("AGENTPING_DISABLE_LLM_SUMMARY", "CODEX_PUSHDEER_DISABLE_LLM_SUMMARY")) {
    return {
      text: "",
      elapsedMs: 0,
      error: "disabled",
    };
  }

  const config = loadConfig();
  const model = config.summaryModel || DEFAULT_SUMMARY_MODEL;
  const timeoutMs = config.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const summaryMinChars = config.summaryMinChars;
  const summaryMaxChars = config.summaryMaxChars;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentping-summary-"));
  const outputFile = path.join(tempDir, "summary.txt");
  const prompt = [
    "你是 Codex 完成通知摘要器。根据用户问题和助手最终回答，生成一条中文推送摘要。",
    `期望长度：${summaryMinChars}到${summaryMaxChars}个汉字。`,
    "写法：用一句完整的话概括本轮最终结果，优先包含结论、已完成事项、是否修改代码/配置、是否需要用户继续行动。",
    "不要描述过程，不要说“我查看了/我会/正在”，除非过程本身就是最终结果；不要截取开头；不要输出标题、引号、编号、解释、密钥、token、完整长路径或长 URL。",
    "完整性优先：不要以半句话、顿号、连接词或省略号结尾；如果长度和完整性冲突，宁可略超也不要截断。",
  ].join("\n");
  const input = [
    "用户问题：",
    redactText(inputMessagesText(notification)) || "未提供",
    "",
    "助手完整回答：",
    redactText(finalText),
  ].join("\n");
  const startedAt = Date.now();

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
          AGENTPING_DISABLE_LLM_SUMMARY: "1",
          AGENTPING_SUPPRESS_NOTIFY: "1",
          CODEX_PUSHDEER_DISABLE_LLM_SUMMARY: "1",
          CODEX_PUSHDEER_SUPPRESS_NOTIFY: "1",
        },
      },
    );
    const elapsedMs = Date.now() - startedAt;

    if (result.status !== 0) {
      logEvent("warn", "LLM summary command failed", {
        model,
        status: result.status,
        signal: result.signal,
        elapsedMs,
        ...logTextMeta("stderr", result.stderr, { config, maxChars: 1000 }),
      });
      return {
        text: "",
        elapsedMs,
        error: result.signal || `exit_${result.status}`,
      };
    }

    const summary = normalizeSummary(fs.readFileSync(outputFile, "utf8"));
    if (!summary) {
      return {
        text: "",
        elapsedMs,
        error: "empty",
      };
    }
    const summaryChars = charLength(summary);
    if (summaryChars < summaryMinChars || summaryChars > summaryMaxChars) {
      logEvent("info", "LLM summary outside configured length range", {
        model,
        summaryChars,
        summaryMinChars,
        summaryMaxChars,
      });
    }
    return {
      text: summary,
      elapsedMs,
      error: "",
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logEvent("warn", "LLM summary command errored", {
      model,
      elapsedMs,
      error: error?.message || String(error),
    });
    return {
      text: "",
      elapsedMs,
      error: error?.message || String(error),
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}

function notificationModeDecision(config, sessionFinal) {
  const mode = config.notifyMode || "always";
  if (mode === "off") {
    return {
      send: false,
      reason: `notify mode ${mode}`,
    };
  }

  if (mode === "long_only") {
    const durationMs = Number.isFinite(sessionFinal.durationMs) ? sessionFinal.durationMs : null;
    if (durationMs === null || durationMs < config.minDurationMs) {
      return {
        send: false,
        reason: "duration below threshold",
        durationMs,
      };
    }
  }

  if (mode === "errors_only") {
    const terminalType = sessionFinal.terminalType || "";
    if (!terminalType || terminalType === "task_complete") {
      return {
        send: false,
        reason: "normal completion in errors_only mode",
      };
    }
  }

  return {
    send: true,
    reason: "matched notification mode",
  };
}

async function main() {
  const notification = loadNotificationArg();
  if (notification.type !== "agent-turn-complete") {
    return;
  }

  if (isInternalSummaryNotification(notification)) {
    logEvent("info", "Skipping internal PushDeer summary notify event");
    return;
  }

  const turnId =
    notification["turn-id"] ||
    notification.turnId ||
    extractTurnId(notification);

  const config = loadConfig();
  const sessionFinal = await findLatestFinalMessage({
    cwd: process.cwd(),
    turnId,
    timeoutMs: config.finalWaitMs,
    requireTaskComplete: config.notifyMode !== "errors_only",
  });

  if (!sessionFinal?.finalText) {
    logEvent("info", "Skipping non-final PushDeer notify event", {
      turnId,
      finalWaitMs: config.finalWaitMs,
    });
    return;
  }

  if (isInternalSummaryText(sessionFinal.userText)) {
    logEvent("info", "Skipping internal PushDeer summary session", {
      turnId: sessionFinal.turnId || turnId,
    });
    return;
  }

  const modeDecision = notificationModeDecision(config, sessionFinal);
  if (!modeDecision.send) {
    logEvent("info", "Skipping PushDeer notify event by mode", {
      turnId: sessionFinal.turnId || turnId,
      notifyMode: config.notifyMode,
      minDurationMs: config.minDurationMs,
      terminalType: sessionFinal.terminalType,
      durationMs: sessionFinal.durationMs,
      reason: modeDecision.reason,
    });
    return;
  }

  const finalText = sessionFinal.finalText;
  const sendId = sessionFinal.turnId || turnId || hashText(JSON.stringify(notification)).slice(0, 24);
  if (wasAlreadySent(sendId)) {
    logEvent("info", "Skipping duplicate PushDeer notify event", { sendId });
    return;
  }

  const fallbackSummary = summarizeFinalText(finalText, config);
  const llmSummary = summarizeWithCodex({ finalText, notification });
  const summarySource = llmSummary.text ? "llm" : "fallback";
  const summaryText = llmSummary.text || fallbackSummary.desp;
  const { title: pushText, desp: pushDesp } = formatNotificationFields({
    summary: summaryText,
    finalText,
    config,
    turnId: sessionFinal.turnId || turnId,
    terminalType: sessionFinal.terminalType,
    durationMs: sessionFinal.durationMs,
    summarySource,
    summaryModel: config.summaryModel || DEFAULT_SUMMARY_MODEL,
    summaryElapsedMs: llmSummary.elapsedMs,
  });

  await sendPushDeer({
    title: pushText,
    desp: pushDesp,
    endpoint: config.endpoint,
    pushkey: config.pushkey,
    dryRun: Boolean(envValue("AGENTPING_DRY_RUN", "CODEX_PUSHDEER_DRY_RUN")),
  });

  markSent(sendId);
  logEvent("info", "PushDeer notify event sent", {
    sendId,
    ...logTextMeta("title", pushText, { config }),
    despChars: charLength(pushDesp),
    despMaxChars: config.despMaxChars,
    finalWaitMs: config.finalWaitMs,
    notifyMode: config.notifyMode,
    terminalType: sessionFinal.terminalType,
    durationMs: sessionFinal.durationMs,
    summarySource,
    summaryModel: config.summaryModel || DEFAULT_SUMMARY_MODEL,
    summaryElapsedMs: llmSummary.elapsedMs,
    summaryError: llmSummary.error,
  });
}

main().catch((error) => {
  logEvent("error", "PushDeer notify event failed", {
    error: error?.message || String(error),
  });
  process.exit(0);
});
