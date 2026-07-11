import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  charLength,
  codexSummaryExecArgs,
  codexTransportDiagnostics,
  DEFAULT_CLAUDE_SUMMARY_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SUMMARY_FALLBACK_TEXT,
  DEFAULT_SUMMARY_MODEL,
  envValue,
  formatNotificationFields,
  loadConfig,
  logEvent,
  logTextMeta,
  markSent,
  pushkeyForPlatform,
  redactText,
  sendPushDeer,
  wasAlreadySent,
} from "./pushdeer-lib.mjs";

export const SUMMARY_PROMPT_MARKERS = [
  "你是 AI 编程助手完成通知摘要器",
  "你是 Codex 完成通知摘要器",
  "你是推送通知摘要器",
];

export function isInternalSummaryText(text) {
  return SUMMARY_PROMPT_MARKERS.some((marker) => String(text || "").includes(marker));
}

function normalizeSummary(value) {
  return redactText(value)
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .replace(/^(?:摘要|描述|推送描述)[:：]\s*/u, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarySafetyMaxChars(summaryMaxChars) {
  return Math.max(summaryMaxChars + 50, summaryMaxChars * 2);
}

function copiedFinalAnswerReason(summary, finalText, summaryMaxChars) {
  if (charLength(summary) <= summaryMaxChars) return "";
  const normalizedFinal = normalizeSummary(finalText);
  if (!normalizedFinal) return "";
  if (summary === normalizedFinal) return "copied_final";
  const prefix = Array.from(normalizedFinal).slice(0, 80).join("");
  return charLength(prefix) >= 40 && summary.startsWith(prefix) ? "copied_final" : "";
}

function summaryPrompt({ platform, summaryMinChars, summaryMaxChars }) {
  const platformName = platform === "claude" ? "Claude Code" : "Codex";
  return [
    `你是 AI 编程助手完成通知摘要器。根据用户问题和 ${platformName} 最终回答，生成一条中文推送摘要。`,
    `期望长度：${summaryMinChars}到${summaryMaxChars}个汉字。`,
    "写法：用一句完整的话概括本轮最终结果，优先包含结论、已完成事项、是否修改代码/配置、是否需要用户继续行动。",
    "不要描述过程，不要说“我查看了/我会/正在”，除非过程本身就是最终结果；不要截取开头；不要输出标题、引号、编号、解释、密钥、token、完整长路径或长 URL。",
    "完整性优先：不要以半句话、顿号、连接词或省略号结尾；如果长度和完整性冲突，宁可略超也不要截断。",
  ].join("\n");
}

function summaryInput({ userText, finalText }) {
  return [
    "用户问题：",
    redactText(userText) || "未提供",
    "",
    "助手完整回答：",
    redactText(finalText),
  ].join("\n");
}

function runCodexSummary({ model, outputFile, prompt, input, cwd, timeoutMs }) {
  const result = spawnSync("codex", codexSummaryExecArgs({ model, outputFile, prompt }), {
    cwd,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      AGENTPING_DISABLE_LLM_SUMMARY: "1",
      AGENTPING_SUPPRESS_NOTIFY: "1",
      CODEX_PUSHDEER_DISABLE_LLM_SUMMARY: "1",
      CODEX_PUSHDEER_SUPPRESS_NOTIFY: "1",
    },
  });
  return {
    result,
    text: result.status === 0 && fs.existsSync(outputFile)
      ? fs.readFileSync(outputFile, "utf8")
      : "",
    diagnostics: codexTransportDiagnostics(result.stderr, {
      timedOut: result.signal === "SIGTERM",
    }),
  };
}

function runClaudeSummary({ model, prompt, input, cwd, timeoutMs }) {
  const result = spawnSync(
    "claude",
    [
      "--print",
      "--safe-mode",
      "--no-session-persistence",
      "--tools", "",
      "--model", model,
      "--output-format", "text",
      "--system-prompt", prompt,
    ],
    {
      cwd,
      input,
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        AGENTPING_DISABLE_LLM_SUMMARY: "1",
        AGENTPING_SUPPRESS_NOTIFY: "1",
        CODEX_PUSHDEER_DISABLE_LLM_SUMMARY: "1",
        CODEX_PUSHDEER_SUPPRESS_NOTIFY: "1",
      },
    },
  );
  return {
    result,
    text: result.status === 0 ? result.stdout : "",
    diagnostics: {
      transport: "claude-cli",
      transportRetries: 0,
      timeoutStage: result.signal === "SIGTERM" ? "response_wait" : "",
    },
  };
}

export function summarizeWithLlm({ platform, finalText, userText, config, cwd = process.cwd() }) {
  if (!finalText || envValue("AGENTPING_DISABLE_LLM_SUMMARY", "CODEX_PUSHDEER_DISABLE_LLM_SUMMARY")) {
    return { text: "", elapsedMs: 0, error: "disabled" };
  }

  const model = platform === "claude"
    ? config.claudeSummaryModel || DEFAULT_CLAUDE_SUMMARY_MODEL
    : config.summaryModel || DEFAULT_SUMMARY_MODEL;
  const timeoutMs = Number.isFinite(config.llmTimeoutMs) && config.llmTimeoutMs > 0
    ? config.llmTimeoutMs
    : DEFAULT_LLM_TIMEOUT_MS;
  const prompt = summaryPrompt({
    platform,
    summaryMinChars: config.summaryMinChars,
    summaryMaxChars: config.summaryMaxChars,
  });
  const input = summaryInput({ userText, finalText });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentping-summary-"));
  const outputFile = path.join(tempDir, "summary.txt");
  const startedAt = Date.now();

  try {
    const command = platform === "claude"
      ? runClaudeSummary({ model, prompt, input, cwd, timeoutMs })
      : runCodexSummary({ model, outputFile, prompt, input, cwd, timeoutMs });
    const elapsedMs = Date.now() - startedAt;
    const { result, diagnostics } = command;
    if (result.status !== 0) {
      logEvent("warn", "LLM summary command failed", {
        platform,
        model,
        status: result.status,
        signal: result.signal,
        elapsedMs,
        inputChars: charLength(input),
        ...diagnostics,
        ...logTextMeta("stderr", result.stderr, { config, maxChars: 1000 }),
      });
      return { text: "", elapsedMs, error: result.signal || `exit_${result.status}` };
    }

    const summary = normalizeSummary(command.text);
    if (!summary) return { text: "", elapsedMs, error: "empty" };
    const summaryChars = charLength(summary);
    const hardMaxChars = summarySafetyMaxChars(config.summaryMaxChars);
    const invalidReason = summaryChars > hardMaxChars
      ? `too_long_${summaryChars}`
      : copiedFinalAnswerReason(summary, finalText, config.summaryMaxChars);
    if (invalidReason) {
      logEvent("warn", "LLM summary rejected as invalid", {
        platform,
        model,
        elapsedMs,
        inputChars: charLength(input),
        summaryChars,
        summaryMaxChars: config.summaryMaxChars,
        hardMaxChars,
        reason: invalidReason,
        ...diagnostics,
      });
      return { text: "", elapsedMs, error: invalidReason };
    }
    logEvent("info", "LLM summary generated", {
      platform,
      model,
      elapsedMs,
      inputChars: charLength(input),
      summaryChars,
      ...diagnostics,
    });
    if (summaryChars < config.summaryMinChars || summaryChars > config.summaryMaxChars) {
      logEvent("info", "LLM summary outside configured length range", {
        platform,
        model,
        summaryChars,
        summaryMinChars: config.summaryMinChars,
        summaryMaxChars: config.summaryMaxChars,
      });
    }
    return { text: summary, elapsedMs, error: "" };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logEvent("warn", "LLM summary command errored", {
      platform,
      model,
      elapsedMs,
      error: error?.message || String(error),
    });
    return { text: "", elapsedMs, error: error?.message || String(error) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function notificationModeDecision(config, completion) {
  const mode = config.notifyMode;
  if (mode === "off") return { send: false, reason: `notify mode ${mode}` };
  if (mode === "long_only") {
    const durationMs = Number.isFinite(completion.durationMs) ? completion.durationMs : null;
    if (durationMs === null || durationMs < config.minDurationMs) {
      return { send: false, reason: "duration below threshold", durationMs };
    }
  }
  if (mode === "errors_only" && completion.terminalType === "task_complete") {
    return { send: false, reason: "normal completion in errors_only mode" };
  }
  return { send: true, reason: "matched notification mode" };
}

export async function sendCompletionNotification({
  platform,
  finalText,
  userText = "",
  sendId,
  turnId = "",
  terminalType = "task_complete",
  durationMs = null,
  cwd = process.cwd(),
} = {}) {
  const config = loadConfig({ cwd });
  const decision = notificationModeDecision(config, { durationMs, terminalType });
  if (!decision.send) {
    logEvent("info", "Skipping PushDeer notify event by mode", {
      platform,
      sendId,
      notifyMode: config.notifyMode,
      minDurationMs: config.minDurationMs,
      terminalType,
      durationMs,
      reason: decision.reason,
    });
    return { sent: false, reason: decision.reason };
  }

  if (wasAlreadySent(sendId)) {
    logEvent("info", "Skipping duplicate PushDeer notify event", { platform, sendId });
    return { sent: false, reason: "duplicate" };
  }

  const pushkey = pushkeyForPlatform(config, platform);
  if (!pushkey) {
    logEvent("warn", "Skipping PushDeer notify event without platform key", { platform, sendId });
    return { sent: false, reason: "missing_platform_key" };
  }

  const llmSummary = summarizeWithLlm({ platform, finalText, userText, config, cwd });
  const summarySource = llmSummary.text ? "llm" : "fallback";
  const summaryText = llmSummary.text || config.summaryFallbackText || DEFAULT_SUMMARY_FALLBACK_TEXT;
  const summaryModel = platform === "claude"
    ? config.claudeSummaryModel || DEFAULT_CLAUDE_SUMMARY_MODEL
    : config.summaryModel || DEFAULT_SUMMARY_MODEL;
  const { title, desp } = formatNotificationFields({
    summary: summaryText,
    finalText,
    config,
    turnId,
    terminalType,
    durationMs,
    summarySource,
    summaryModel,
    summaryElapsedMs: llmSummary.elapsedMs,
  });

  await sendPushDeer({
    title,
    desp,
    endpoint: config.endpoint,
    pushkey,
    dryRun: Boolean(envValue("AGENTPING_DRY_RUN", "CODEX_PUSHDEER_DRY_RUN")),
  });
  markSent(sendId);
  logEvent("info", "PushDeer notify event sent", {
    platform,
    sendId,
    ...logTextMeta("title", title, { config }),
    despChars: charLength(desp),
    despMaxChars: config.despMaxChars,
    notifyMode: config.notifyMode,
    terminalType,
    durationMs,
    summarySource,
    summaryModel,
    summaryElapsedMs: llmSummary.elapsedMs,
    summaryError: llmSummary.error,
  });
  return { sent: true, summarySource };
}
