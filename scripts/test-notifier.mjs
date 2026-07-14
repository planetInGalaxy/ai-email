#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeHookStatus,
  installClaudeHooks,
  removeClaudeHooks,
} from "./claude-hooks.mjs";
import {
  DEFAULT_CLAUDE_SUMMARY_MODEL,
  DEFAULT_DESP_TEMPLATE,
  DEFAULT_DESP_SEPARATOR,
  DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS,
  DEFAULT_FINAL_TEXT_PREVIEW_MARKER,
  DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS,
  DEFAULT_TITLE_TEMPLATE,
  DEFAULT_USAGE_FOOTER,
  DEFAULT_USAGE_DETAIL,
  charLength,
  codexSummaryExecArgs,
  codexTransportDiagnostics,
  configWithChineseComments,
  fallbackDescription,
  formatFinalTextPreview,
  formatNotificationFields,
  formatDesp,
  loadConfig,
  logEvent,
  logPath,
  normalizeNotifyMode,
  normalizePushDeerEndpoint,
  normalizeSummaryCharBounds,
  pushkeyForPlatform,
  saveConfigPatch,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";
import {
  formatUsageFooter,
  mergeUsage,
  normalizeUsage,
  usageDelta,
} from "../plugins/agentping/scripts/usage.mjs";
import { readClaudeTranscriptCompletion } from "../plugins/agentping/scripts/claude-transcript.mjs";
import {
  notifyCommandForScript,
  notifyConfigStatus,
  notifyLineForCommand,
  replaceTopLevelNotify,
} from "./notify-config.mjs";
import {
  acquireQueueLock,
  claimNextEvent,
  completeClaim,
  enqueueCompletionEvent,
  failClaim,
  queuePaths,
  queueStatus,
  requeueFailedEvents,
  releaseQueueLock,
} from "../plugins/agentping/scripts/event-queue.mjs";
import { drainCompletionQueue } from "../plugins/agentping/scripts/queue-worker.mjs";
import { normalizeCompletionEvent } from "../plugins/agentping/scripts/adapter-sdk.mjs";
import { openClawCompletionEvent } from "../integrations/openclaw/adapter.mjs";
import { installRuntime, rollbackRuntime, runtimeStatus } from "./runtime-install.mjs";
import {
  hermesIntegrationStatus,
  installHermesIntegration,
  installOpenClawIntegration,
  openClawIntegrationStatus,
} from "./platform-integrations.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(projectRoot, "plugins", "agentping");
const eventScript = path.join(pluginRoot, "scripts", "pushdeer-notify-event.mjs");
const claudeEventScript = path.join(pluginRoot, "scripts", "claude-notify-event.mjs");
const claudeLauncherScript = path.join(pluginRoot, "scripts", "claude-notify-launcher.mjs");
const notifyScript = path.join(pluginRoot, "scripts", "pushdeer-notify.mjs");
const command = process.argv[2] || "all";
const flags = new Set(process.argv.slice(3));

async function test(name, fn) {
  try {
    await fn();
    console.log(`OK ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}

function makeTempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentping-test-"));
  const codexHome = path.join(root, "codex-home");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "08");
  const stateDir = path.join(root, "state");
  const cwd = path.join(root, "work");
  const configPath = path.join(root, "config.json");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    pushkey: "test-codex-key",
    claudePushkey: "test-claude-key",
    endpoint: "https://api2.pushdeer.com/message/push",
    summaryMinChars: 50,
    summaryMaxChars: 100,
    usageFooter: true,
    llmTimeoutMs: 3000,
    despMaxChars: 300,
    despSeparator: DEFAULT_DESP_SEPARATOR,
    finalWaitMs: 0,
    notifyMode: "always",
    minDurationMs: 30000,
    logMaxBytes: 2097152,
    logKeepFiles: 3,
    debugLogs: false,
    titleTemplate: DEFAULT_TITLE_TEMPLATE,
    despTemplate: DEFAULT_DESP_TEMPLATE,
    finalTextPreviewHeadChars: 150,
    finalTextPreviewTailChars: 50,
    finalTextPreviewMarker: "\n......\n",
  }, null, 2));
  return {
    root,
    codexHome,
    sessionDir,
    stateDir,
    cwd,
    configPath,
  };
}

function cleanupTempWorkspace(workspace) {
  if (!workspace?.root) return;
  fs.rmSync(workspace.root, { recursive: true, force: true });
}

function writeSession(workspace, {
  turnId = "turn-test",
  sessionId = `session-${turnId}`,
  parentThreadId = "",
  threadSource = "user",
  model = "",
  provider = "openai",
  usageSequence = [],
  includeFinal = true,
  startedAt = "2026-07-08T09:00:00.000Z",
  completedAt = "2026-07-08T09:02:00.000Z",
  userText = "请总结这个回答",
  finalText = "已经完成本地通知自测，确认只在完整最终回答后触发，并且摘要来自完整输出。",
} = {}) {
  const filePath = path.join(workspace.sessionDir, `${turnId}.jsonl`);
  const lines = [
    {
      timestamp: startedAt,
      type: "session_meta",
      payload: {
        id: sessionId,
        session_id: parentThreadId || sessionId,
        ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
        thread_source: threadSource,
        model_provider: provider,
        ...(threadSource === "subagent" ? {
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentThreadId,
                depth: 1,
              },
            },
          },
        } : {}),
      },
    },
    {
      timestamp: startedAt,
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: workspace.cwd,
        model,
      },
    },
    {
      timestamp: startedAt,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
      },
    },
    {
      timestamp: startedAt,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        turn_id: turnId,
        content: [
          {
            text: userText,
          },
        ],
      },
    },
  ];

  const cumulativeUsage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  for (const usage of usageSequence) {
    const lastUsage = {
      input_tokens: Number(usage.input_tokens || 0),
      cached_input_tokens: Number(usage.cached_input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
      reasoning_output_tokens: Number(usage.reasoning_output_tokens || 0),
    };
    lastUsage.total_tokens = lastUsage.input_tokens + lastUsage.output_tokens;
    for (const field of Object.keys(cumulativeUsage)) cumulativeUsage[field] += lastUsage[field];
    lines.push({
      timestamp: startedAt,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { ...cumulativeUsage },
          last_token_usage: lastUsage,
        },
      },
    });
  }

  if (includeFinal) {
    lines.push(
      {
        timestamp: completedAt,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          turn_id: turnId,
          content: [
            {
              text: finalText,
            },
          ],
        },
      },
      {
        timestamp: completedAt,
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          message: finalText,
        },
      },
    );
  }

  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return filePath;
}

function runEvent(workspace, notification, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [eventScript, JSON.stringify(notification)],
    {
      cwd: workspace.cwd,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        CODEX_HOME: workspace.codexHome,
        AGENTPING_STATE_DIR: workspace.stateDir,
        AGENTPING_CONFIG: workspace.configPath,
        AGENTPING_DRY_RUN: "1",
        AGENTPING_FINAL_WAIT_MS: "0",
        AGENTPING_QUEUE_SYNC: "1",
        ...extraEnv,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `event script exited ${result.status}`);
  }
  return result;
}

function writeClaudeTranscript(workspace, {
  sessionId = "claude-session-test",
  startedAt = "2026-07-08T09:00:00.000Z",
  completedAt = "2026-07-08T09:00:12.500Z",
  userText = "请让 Claude 完成这个任务并总结结果",
  finalText = "Claude 已经完成任务，代码和测试均已验证通过。",
  model = "",
  usage = null,
} = {}) {
  const transcriptPath = path.join(workspace.root, `${sessionId}.jsonl`);
  const lines = [
    {
      type: "user",
      userType: "external",
      sessionId,
      timestamp: startedAt,
      uuid: `${sessionId}-user`,
      message: { role: "user", content: [{ type: "text", text: userText }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: completedAt,
      uuid: `${sessionId}-assistant`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
      },
    },
  ];
  fs.writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return transcriptPath;
}

function makeStubClaude(workspace, summary) {
  const binDir = path.join(workspace.root, "claude-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const stubPath = path.join(binDir, "claude");
  const source = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const input = fs.readFileSync(0, 'utf8');",
    "if (process.env.STUB_CLAUDE_CAPTURE) fs.writeFileSync(process.env.STUB_CLAUDE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), input }));",
    "process.stdout.write(process.env.STUB_CLAUDE_SUMMARY || '');",
  ].join("\n");
  fs.writeFileSync(stubPath, source, { mode: 0o755 });
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    STUB_CLAUDE_SUMMARY: summary,
    STUB_CLAUDE_CAPTURE: path.join(workspace.root, "claude-capture.json"),
  };
}

function runClaudeEvent(workspace, hook, extraEnv = {}) {
  const result = spawnSync(process.execPath, [claudeEventScript], {
    cwd: workspace.cwd,
    input: JSON.stringify(hook),
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      AGENTPING_STATE_DIR: workspace.stateDir,
      AGENTPING_CONFIG: workspace.configPath,
      AGENTPING_DRY_RUN: "1",
      AGENTPING_ALLOW_ANY_CLAUDE_TRANSCRIPT: "1",
      AGENTPING_QUEUE_SYNC: "1",
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Claude event script exited ${result.status}`);
  }
  return result;
}

function readLog(workspace) {
  const filePath = path.join(workspace.stateDir, "notifier.log");
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function testFormatHelpers() {
  assert.equal(DEFAULT_CLAUDE_SUMMARY_MODEL, "sonnet");
  assert.equal(DEFAULT_DESP_SEPARATOR, "\n***\n");
  assert.equal(DEFAULT_TITLE_TEMPLATE, "### {summary}");
  assert.equal(DEFAULT_DESP_TEMPLATE, "{separator}>>>> ### 用时: {durationZh}\n### 回答摘录:\n{finalTextPreview}");
  assert.equal(DEFAULT_FINAL_TEXT_PREVIEW_HEAD_CHARS, 100);
  assert.equal(DEFAULT_FINAL_TEXT_PREVIEW_TAIL_CHARS, 100);
  assert.equal(DEFAULT_FINAL_TEXT_PREVIEW_MARKER, "\n\n......\n\n");
  assert.equal(DEFAULT_USAGE_FOOTER, true);
  assert.equal(DEFAULT_USAGE_DETAIL, "compact");
  const documentedConfig = configWithChineseComments({
    pushkey: "codex-key",
    claudePushkey: "claude-key",
    summaryModel: "gpt-5.4-mini",
    claudeSummaryModel: "sonnet",
    summaryMinChars: 50,
    summaryMaxChars: 100,
    usageFooter: true,
  });
  assert.equal(documentedConfig.agents.codex.PushKey, "codex-key");
  assert.equal(documentedConfig.agents.claude.PushKey, "claude-key");
  assert.equal(documentedConfig.agents.codex.summaryModel, "gpt-5.4-mini");
  assert.equal(documentedConfig.agents.claude.summaryModel, "sonnet");
  assert.equal(documentedConfig.pushkey, undefined);
  assert.ok(Array.isArray(documentedConfig._说明));
  assert.ok(documentedConfig._说明.some((line) => /summaryMinChars.*Prompt/u.test(line)));
  assert.ok(documentedConfig._说明.some((line) => /summaryMaxChars.*不会强制截断/u.test(line)));
  assert.ok(documentedConfig._说明.some((line) => /usageFooter.*Token/u.test(line)));
  assert.equal(pushkeyForPlatform({ pushkey: "codex-key", claudePushkey: "claude-key" }, "codex"), "codex-key");
  assert.equal(pushkeyForPlatform({ pushkey: "codex-key", claudePushkey: "claude-key" }, "claude"), "claude-key");
  const { summaryMinChars, summaryMaxChars } = normalizeSummaryCharBounds(60, 30);
  assert.equal(summaryMinChars, 60);
  assert.equal(summaryMaxChars, 60);
  assert.equal(normalizeNotifyMode("manual"), "off");
  assert.equal(
    normalizePushDeerEndpoint("https://push.example.com"),
    "https://push.example.com/message/push",
  );
  assert.equal(
    normalizePushDeerEndpoint("http://127.0.0.1:8800/message/push/?ignored=1#ignored"),
    "http://127.0.0.1:8800/message/push",
  );
  assert.equal(normalizePushDeerEndpoint("ftp://push.example.com", ""), "");
  assert.equal(normalizePushDeerEndpoint("https://user:pass@push.example.com", ""), "");
  const desp = formatDesp("这是一段原始回答内容，用来验证 desp 分隔符和长度限制。", {
    maxChars: 12,
    separator: "\n-----\n",
  });
  assert.ok(charLength(desp) <= 12);
  assert.ok(desp.startsWith("\n-----\n"));
  const fallback = fallbackDescription("第一句话完整。第二句话会被省略。", {
    summaryMinChars: 4,
    summaryMaxChars: 8,
  });
  assert.equal(fallback, "第一句话完整。");
  const fields = formatNotificationFields({
    summary: "任务完成",
    finalText: "完整回答内容",
    config: {
      despMaxChars: 20,
      despSeparator: "\n---\n",
      titleTemplate: "[{summarySource}] {summary}",
      despTemplate: "{separator}{durationZh} {finalText}",
    },
    durationMs: 12345,
    summarySource: "llm",
  });
  assert.equal(fields.title, "[llm] 任务完成");
  assert.ok(fields.desp.includes("0分 12秒"));
  assert.ok(charLength(fields.desp) <= 20);
  const longText = Array.from({ length: 260 }, (_, index) => String(index % 10)).join("");
  const preview = formatFinalTextPreview(longText, {
    headChars: 150,
    tailChars: 50,
    marker: "\n......\n",
  });
  assert.equal(charLength(preview), 208);
  assert.equal(preview.slice(0, 10), "0123456789");
  assert.match(preview, /\n\.\.\.\.\.\.\n/u);
  assert.equal(preview.slice(-10), "0123456789");

  const punctuatedText = "开头内容一。开头内容二继续补充。中间内容会被省略，因为这里足够长。结尾部分从完整句子开始。最后结论完整保留。";
  const punctuatedPreview = formatFinalTextPreview(punctuatedText, {
    headChars: 8,
    tailChars: 8,
    marker: "\n......\n",
  });
  assert.equal(punctuatedPreview, "开头内容一。开头内容二继续补充。\n......\n最后结论完整保留。");

  const fencedText = [
    "已经完成修改，下面展示通知格式。",
    "",
    "```md",
    "***",
    "",
    "**运行信息**: `gpt-test` · 输入 10k (缓存 8k) · 输出 1k",
    "```",
    "这里是会被省略的中间说明。".repeat(20),
    "最终结论完整保留。",
  ].join("\n");
  const fencedPreview = formatFinalTextPreview(fencedText, {
    headChars: 60,
    tailChars: 20,
    marker: "\n......\n",
  });
  const fencedMarkerIndex = fencedPreview.indexOf("\n......\n");
  assert.ok(fencedMarkerIndex > 0);
  assert.ok(fencedPreview.slice(0, fencedMarkerIndex).trimEnd().endsWith("```"));
  assert.equal((fencedPreview.match(/^```/gmu) || []).length % 2, 0);

  const tailInsideFence = [
    "开头说明。".repeat(40),
    "```js",
    "const value = 1;".repeat(20),
    "```",
  ].join("\n");
  const tailInsideFencePreview = formatFinalTextPreview(tailInsideFence, {
    headChars: 20,
    tailChars: 80,
    marker: "\n......\n",
  });
  assert.equal((tailInsideFencePreview.match(/^```/gmu) || []).length % 2, 0);

  const unlimitedFields = formatNotificationFields({
    summary: "任务完成",
    finalText: punctuatedText,
    config: {
      despMaxChars: -1,
      despSeparator: "\n---\n",
      despTemplate: "{separator}{finalTextPreview}",
      finalTextPreviewHeadChars: 8,
      finalTextPreviewTailChars: 8,
      finalTextPreviewMarker: "\n......\n",
    },
  });
  assert.equal(unlimitedFields.desp, `\n---\n${punctuatedPreview}`);
  assert.ok(charLength(unlimitedFields.desp) > 8 + 8);

  const execArgs = codexSummaryExecArgs({
    model: "gpt-5.4-mini",
    outputFile: "/tmp/summary.txt",
    prompt: "测试摘要",
  });
  assert.ok(execArgs.includes("model_provider=\"agentping-openai\""));
  assert.ok(execArgs.includes("model_providers.agentping-openai.supports_websockets=false"));
  assert.deepEqual(
    codexTransportDiagnostics("stream disconnected - retrying\nfalling back to HTTP", { timedOut: true }),
    { transport: "https", transportRetries: 1, timeoutStage: "transport_retry" },
  );

  const openAiUsage = normalizeUsage({
    input_tokens: 10_000,
    cached_input_tokens: 8_000,
    output_tokens: 1_000,
    reasoning_output_tokens: 200,
  }, { model: "gpt-test", provider: "openai" });
  assert.equal(openAiUsage.inputTokens, 10_000);
  assert.equal(openAiUsage.cachedInputTokens, 8_000);
  const anthropicUsage = normalizeUsage({
    input_tokens: 2,
    cache_read_input_tokens: 1_000,
    cache_creation_input_tokens: 100,
    output_tokens: 50,
  }, { model: "claude-test", provider: "anthropic" });
  assert.equal(anthropicUsage.inputTokens, 1_102);
  assert.equal(anthropicUsage.cacheCreationInputTokens, 100);
  const deltaUsage = usageDelta(
    { input_tokens: 15_000, cached_input_tokens: 12_000, output_tokens: 1_500 },
    { input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 1_000 },
    null,
    { model: "gpt-test", provider: "openai" },
  );
  assert.equal(deltaUsage.inputTokens, 5_000);
  assert.equal(deltaUsage.outputTokens, 500);
  const multiModelUsage = mergeUsage(openAiUsage, anthropicUsage);
  assert.equal(multiModelUsage.breakdown.length, 2);
  const footer = formatUsageFooter(openAiUsage, {
    usageFooter: true,
    usageDetail: "detailed",
  });
  assert.equal(footer, "***\n\n**运行信息**: `gpt-test` · 输入 10k (缓存 8.0k) · 输出 1.0k · 推理 200");
  const fieldsWithUsage = formatNotificationFields({
    summary: "任务完成",
    finalText: "完整回答",
    model: "gpt-test",
    provider: "openai",
    usage: openAiUsage,
    config: {
      despMaxChars: -1,
      despTemplate: "{finalText}",
      usageFooter: true,
    },
  });
  assert.match(fieldsWithUsage.desp, /完整回答\n\n\*\*\*\n\n\*\*运行信息\*\*: `gpt-test`/u);
  assert.equal((fieldsWithUsage.desp.match(/运行信息/gu) || []).length, 1);
  const fieldsWithoutUsage = formatNotificationFields({
    summary: "任务完成",
    finalText: "完整回答",
    model: "gpt-test",
    usage: openAiUsage,
    config: {
      despMaxChars: -1,
      despTemplate: "{finalText}",
      usageFooter: false,
    },
  });
  assert.equal(fieldsWithoutUsage.desp, "完整回答");
}

function testConfigFieldMigration() {
  const workspace = makeTempWorkspace();
  const previousAgentConfig = process.env.AGENTPING_CONFIG;
  const previousLegacyConfig = process.env.CODEX_PUSHDEER_CONFIG;

  try {
    fs.writeFileSync(workspace.configPath, `${JSON.stringify({
      pushkey: "legacy-codex-key",
      claudePushkey: "legacy-claude-key",
      summaryModel: "legacy-codex-model",
      claudeSummaryModel: "legacy-claude-model",
      summaryMinChars: 40,
      summaryMinChars__说明: "旧格式说明",
      costMode: "reported_or_estimated",
      costCurrency: "USD",
      modelPricing: { "openai/gpt-test": { inputPerMillion: 1 } },
    }, null, 2)}\n`);
    process.env.AGENTPING_CONFIG = workspace.configPath;
    delete process.env.CODEX_PUSHDEER_CONFIG;

    saveConfigPatch({ summaryMaxChars: 90 });
    const stored = JSON.parse(fs.readFileSync(workspace.configPath, "utf8"));
    assert.equal(stored.configVersion, 2);
    assert.equal(stored.agents.codex.PushKey, "legacy-codex-key");
    assert.equal(stored.agents.claude.PushKey, "legacy-claude-key");
    assert.equal(stored.agents.codex.summaryModel, "legacy-codex-model");
    assert.equal(stored.agents.claude.summaryModel, "legacy-claude-model");
    assert.equal(stored.agents.codex.summaryTimeoutMs, 16_000);
    assert.equal(stored.agents.claude.summaryTimeoutMs, 16_000);
    assert.equal(stored.pushkey, undefined);
    assert.equal(stored.claudePushkey, undefined);
    assert.equal(stored.summaryModel, undefined);
    assert.equal(stored.claudeSummaryModel, undefined);
    assert.equal(stored.summaryMinChars__说明, undefined);
    assert.ok(Array.isArray(stored._说明));
    assert.equal(stored.llmTimeoutMs, undefined);
    assert.equal(stored.summaryFallbackText, "摘要未生成，请看原回答");
    assert.equal(stored.notifyMode, "long_only");
    assert.equal(stored.logMaxBytes, 2 * 1024 * 1024);
    assert.equal(stored.debugLogs, false);
    assert.equal(stored.usageFooter, true);
    assert.equal(stored.usageDetail, "compact");
    assert.equal(stored.costMode, undefined);
    assert.equal(stored.costCurrency, undefined);
    assert.equal(stored.modelPricing, undefined);

    const loaded = loadConfig();
    assert.equal(loaded.pushkey, "legacy-codex-key");
    assert.equal(loaded.claudePushkey, "legacy-claude-key");
    assert.equal(loaded.summaryModel, "legacy-codex-model");
    assert.equal(loaded.claudeSummaryModel, "legacy-claude-model");
    assert.equal(loaded.summaryMaxChars, 90);
    assert.equal(loaded.usageFooter, true);
  } finally {
    if (previousAgentConfig === undefined) delete process.env.AGENTPING_CONFIG;
    else process.env.AGENTPING_CONFIG = previousAgentConfig;
    if (previousLegacyConfig === undefined) delete process.env.CODEX_PUSHDEER_CONFIG;
    else process.env.CODEX_PUSHDEER_CONFIG = previousLegacyConfig;
    cleanupTempWorkspace(workspace);
  }
}

function testFinalOnlyNotification() {
  const workspace = makeTempWorkspace();
  try {
    const turnId = "turn-final-only";
    writeSession(workspace, { turnId, includeFinal: false });
    runEvent(workspace, {
      type: "agent-turn-complete",
      "turn-id": turnId,
      "input-messages": [{ text: "阶段性事件" }],
    }, {
      AGENTPING_DISABLE_LLM_SUMMARY: "1",
    });
    assert.doesNotMatch(readLog(workspace), /PushDeer notify event sent/u);

    writeSession(workspace, { turnId, includeFinal: true });
    runEvent(workspace, {
      type: "agent-turn-complete",
      "turn-id": turnId,
      "input-messages": [{ text: "最终事件" }],
    }, {
      AGENTPING_DISABLE_LLM_SUMMARY: "1",
    });
    assert.match(readLog(workspace), /PushDeer notify event sent/u);
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function testSubagentNotificationSuppressed() {
  const workspace = makeTempWorkspace();
  try {
    const turnId = "turn-subagent-complete";
    writeSession(workspace, {
      turnId,
      sessionId: "child-agent-session",
      parentThreadId: "top-level-user-session",
      threadSource: "subagent",
      userText: "检查候选稿并返回审阅结果",
      finalText: "子 Agent 已完成候选稿审阅，但主任务仍在继续。",
    });
    runEvent(workspace, {
      type: "agent-turn-complete",
      "turn-id": turnId,
      "input-messages": [{ text: "子 Agent 完成事件" }],
    }, {
      AGENTPING_DISABLE_LLM_SUMMARY: "1",
    });

    const log = readLog(workspace);
    assert.match(log, /Skipping Codex subagent completion event/u);
    assert.match(log, /"parentSessionId":"top-level-user-session"/u);
    assert.doesNotMatch(log, /AgentPing completion event queued/u);
    assert.doesNotMatch(log, /PushDeer notify event sent/u);
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function testCodexUsageIncludesSubagents() {
  const workspace = makeTempWorkspace();
  try {
    const parentSessionId = "top-level-usage-session";
    const parentTurnId = "turn-parent-usage";
    writeSession(workspace, {
      turnId: parentTurnId,
      sessionId: parentSessionId,
      model: "gpt-parent",
      startedAt: "2026-07-08T09:00:00.000Z",
      completedAt: "2026-07-08T09:10:00.000Z",
      usageSequence: [{ input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100 }],
    });
    writeSession(workspace, {
      turnId: "turn-child-usage",
      sessionId: "child-usage-session",
      parentThreadId: parentSessionId,
      threadSource: "subagent",
      model: "gpt-child",
      startedAt: "2026-07-08T09:02:00.000Z",
      completedAt: "2026-07-08T09:05:00.000Z",
      usageSequence: [{ input_tokens: 2_000, cached_input_tokens: 1_500, output_tokens: 200 }],
    });
    runEvent(workspace, {
      type: "agent-turn-complete",
      "turn-id": parentTurnId,
      "input-messages": [{ text: "顶层任务完成事件" }],
    }, {
      AGENTPING_DISABLE_LLM_SUMMARY: "1",
    });

    const log = readLog(workspace);
    assert.match(log, /PushDeer notify event sent/u);
    assert.match(log, /"model":"gpt-parent"/u);
    assert.match(log, /"usageModels":2/u);
    assert.match(log, /"usageInputTokens":3000/u);
    assert.match(log, /"usageCachedInputTokens":1900/u);
    assert.match(log, /"usageOutputTokens":300/u);
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function makeStubCodex(workspace, summary) {
  const binDir = path.join(workspace.root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const stubPath = path.join(binDir, "codex");
  const source = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const input = fs.readFileSync(0, 'utf8');",
    "if (process.env.STUB_CODEX_CAPTURE) fs.writeFileSync(process.env.STUB_CODEX_CAPTURE, JSON.stringify({ args: process.argv.slice(2), input }));",
    "const outputIndex = process.argv.indexOf('--output-last-message');",
    "if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], process.env.STUB_CODEX_SUMMARY || '');",
  ].join("\n");
  fs.writeFileSync(stubPath, source, { mode: 0o755 });
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    STUB_CODEX_SUMMARY: summary,
    STUB_CODEX_CAPTURE: path.join(workspace.root, "codex-capture.json"),
  };
}

function testLlmSummaryIsUsedWhole() {
  const workspace = makeTempWorkspace();
  try {
    const turnId = "turn-llm-summary";
    const summary = "已完成完整回答摘要，保留关键结论、代码修改、验证结果、风险说明和下一步动作；虽然略微超过期望字数上限，但仍是一句完整且可读的摘要，因此应当原样发送而不是生硬截断，同时确保用户能直接理解任务是否成功、还存在哪些限制以及是否需要继续操作。";
    assert.ok(charLength(summary) > 100 && charLength(summary) < 200);
    writeSession(workspace, {
      turnId,
      finalText: "这是一个很长的最终回答。它包含结论、代码修改、验证结果和后续建议，不能只截取开头。",
    });
    const stubEnv = makeStubCodex(workspace, summary);
    runEvent(workspace, {
      type: "agent-turn-complete",
      "turn-id": turnId,
      "input-messages": [{ text: "请完成任务并总结" }],
    }, {
      ...stubEnv,
      AGENTPING_DEBUG_LOGS: "1",
    });
    const log = readLog(workspace);
    const capture = JSON.parse(fs.readFileSync(stubEnv.STUB_CODEX_CAPTURE, "utf8"));
    assert.match(log, /PushDeer notify event sent/u);
    assert.match(log, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.match(log, /summaryElapsedMs/u);
    assert.ok(capture.args.includes("model_provider=\"agentping-openai\""));
    assert.ok(capture.args.includes("model_providers.agentping-openai.supports_websockets=false"));
    assert.match(capture.args.at(-1), /期望长度：50到100个汉字/u);
    assert.match(capture.input, /这是一个很长的最终回答。它包含结论、代码修改、验证结果和后续建议，不能只截取开头。/u);
    assert.match(log, /LLM summary generated/u);
    assert.match(log, /"transport":"unknown"/u);
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function testInvalidLlmSummaryUsesFixedFallback() {
  const workspace = makeTempWorkspace();
  try {
    const turnId = "turn-invalid-llm-summary";
    const fallbackText = "本轮摘要暂不可用，请查看原回答";
    const config = JSON.parse(fs.readFileSync(workspace.configPath, "utf8"));
    fs.writeFileSync(workspace.configPath, JSON.stringify({
      ...config,
      summaryFallbackText: fallbackText,
    }, null, 2));
    writeSession(workspace, {
      turnId,
      finalText: "这是原始回答，只应出现在通知正文预览中，不应被模型完整复制到通知标题。",
    });
    const invalidSummary = `这是模型错误返回的完整长回答。${"异常长内容".repeat(150)}`;
    const stubEnv = makeStubCodex(workspace, invalidSummary);
    runEvent(workspace, {
      type: "agent-turn-complete",
      "turn-id": turnId,
      "input-messages": [{ text: "请生成简短摘要" }],
    }, {
      ...stubEnv,
      AGENTPING_DEBUG_LOGS: "1",
    });

    const log = readLog(workspace);
    assert.match(log, /LLM summary rejected as invalid/u);
    assert.match(log, /too_long_/u);
    assert.match(log, new RegExp(fallbackText, "u"));
    assert.match(log, /"summarySource":"fallback"/u);
    assert.doesNotMatch(log, /这是模型错误返回的完整长回答/u);
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function testProjectConfigOverrides() {
  const workspace = makeTempWorkspace();
  const previousConfig = process.env.AGENTPING_CONFIG;
  const previousProjectConfig = process.env.AGENTPING_PROJECT_CONFIG;

  try {
    const projectDir = path.join(workspace.root, "project", "nested");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(workspace.root, "project", ".agentping.json"), JSON.stringify({
      CodexPushKey: "project-should-not-win",
      ClaudePushKey: "project-claude-should-not-win",
      agents: {
        openclaw: {
          PushKey: "project-openclaw-should-not-win",
          summaryTimeoutMs: 4321,
        },
      },
      notifyMode: "long_only",
      minDurationMs: 12345,
      titleTemplate: "项目 {summary}",
    }, null, 2));
    fs.writeFileSync(workspace.configPath, JSON.stringify({
      CodexPushKey: "user-key",
      ClaudePushKey: "user-claude-key",
      agents: {
        openclaw: {
          type: "openclaw",
          PushKey: "user-openclaw-key",
          summaryTimeoutMs: 16000,
        },
      },
      notifyMode: "always",
      minDurationMs: 30000,
    }, null, 2));
    process.env.AGENTPING_CONFIG = workspace.configPath;
    delete process.env.AGENTPING_PROJECT_CONFIG;

    const config = loadConfig({ cwd: projectDir });
    assert.equal(config.pushkey, "user-key");
    assert.equal(config.claudePushkey, "user-claude-key");
    assert.equal(config.notifyMode, "long_only");
    assert.equal(config.minDurationMs, 12345);
    assert.equal(config.titleTemplate, "项目 {summary}");
    assert.ok(config.projectConfigPath.endsWith(".agentping.json"));
    const openClawConfig = loadConfig({ cwd: projectDir, agentId: "openclaw", agentType: "openclaw" });
    assert.equal(openClawConfig.agentPushKey, "user-openclaw-key");
    assert.equal(openClawConfig.agentSummaryTimeoutMs, 4321);
  } finally {
    if (previousConfig === undefined) delete process.env.AGENTPING_CONFIG;
    else process.env.AGENTPING_CONFIG = previousConfig;
    if (previousProjectConfig === undefined) delete process.env.AGENTPING_PROJECT_CONFIG;
    else process.env.AGENTPING_PROJECT_CONFIG = previousProjectConfig;
    cleanupTempWorkspace(workspace);
  }
}

function testClaudeHookConfigHelpers() {
  const original = {
    theme: "dark",
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: "notify-existing" }] }],
      Stop: [{ hooks: [{ type: "command", command: "keep-existing-stop" }] }],
    },
  };
  const installed = installClaudeHooks(original, {
    notifyScript: claudeLauncherScript,
    nodePath: "/test/node",
  });
  assert.equal(installed.changed, true);
  assert.equal(installed.settings.theme, "dark");
  assert.equal(installed.settings.hooks.Notification.length, 1);
  assert.equal(installed.settings.hooks.Stop.length, 2);
  assert.equal(installed.settings.hooks.StopFailure.length, 1);
  assert.equal(claudeHookStatus(installed.settings, { notifyScript: claudeLauncherScript }).ok, true);

  const reinstalled = installClaudeHooks(installed.settings, {
    notifyScript: claudeLauncherScript,
    nodePath: "/test/node",
  });
  assert.equal(reinstalled.changed, false);

  const removed = removeClaudeHooks(installed.settings, { notifyScript: claudeLauncherScript });
  assert.equal(removed.changed, true);
  assert.equal(removed.settings.hooks.Notification.length, 1);
  assert.equal(removed.settings.hooks.Stop.length, 1);
  assert.equal(removed.settings.hooks.Stop[0].hooks[0].command, "keep-existing-stop");
  assert.equal(removed.settings.hooks.StopFailure, undefined);
}

async function testClaudeStopNotification() {
  const workspace = makeTempWorkspace();
  try {
    const finalText = "Claude 已完成完整实现，保留了现有配置和使用方法，并完成了全部回归测试。";
    const userText = "适配 Claude Code，并确保最终回答会发送独立通知。";
    const transcriptPath = writeClaudeTranscript(workspace, {
      userText,
      finalText,
      model: "claude-test",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1_000,
        output_tokens: 50,
      },
    });
    const parsedTranscript = await readClaudeTranscriptCompletion(transcriptPath);
    assert.equal(parsedTranscript.model, "claude-test");
    assert.equal(parsedTranscript.usage.inputTokens, 1_102);
    const summary = "Claude Code 通知适配已经完成，独立密钥、摘要、耗时判断和回归测试均正常。";
    const stub = makeStubClaude(workspace, summary);
    runClaudeEvent(workspace, {
      session_id: "claude-session-test",
      transcript_path: transcriptPath,
      cwd: workspace.cwd,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: finalText,
    }, {
      ...stub,
      AGENTPING_DEBUG_LOGS: "1",
    });

    const log = readLog(workspace);
    const capture = JSON.parse(fs.readFileSync(stub.STUB_CLAUDE_CAPTURE, "utf8"));
    assert.match(log, /PushDeer notify event sent/u);
    assert.match(log, /"platform":"claude"/u);
    assert.match(log, /"durationMs":12500/u);
    assert.match(log, /"model":"claude-test"/u);
    assert.match(log, /"usageInputTokens":1102/u);
    assert.match(log, /"usageCachedInputTokens":1000/u);
    assert.match(log, /"usageOutputTokens":50/u);
    assert.match(log, new RegExp(summary, "u"));
    assert.ok(capture.args.includes("--safe-mode"));
    assert.ok(capture.args.includes("--no-session-persistence"));
    assert.ok(capture.args.includes("sonnet"));
    assert.match(capture.input, new RegExp(userText, "u"));
    assert.match(capture.input, new RegExp(finalText, "u"));
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function testClaudeModesAndFailure() {
  const shortWorkspace = makeTempWorkspace();
  try {
    const config = JSON.parse(fs.readFileSync(shortWorkspace.configPath, "utf8"));
    fs.writeFileSync(shortWorkspace.configPath, JSON.stringify({
      ...config,
      notifyMode: "long_only",
      minDurationMs: 10000,
    }, null, 2));
    const transcriptPath = writeClaudeTranscript(shortWorkspace, {
      sessionId: "claude-short",
      completedAt: "2026-07-08T09:00:05.000Z",
    });
    runClaudeEvent(shortWorkspace, {
      session_id: "claude-short",
      transcript_path: transcriptPath,
      cwd: shortWorkspace.cwd,
      hook_event_name: "Stop",
      last_assistant_message: "五秒内完成。",
    }, { AGENTPING_DISABLE_LLM_SUMMARY: "1" });
    const log = readLog(shortWorkspace);
    assert.match(log, /duration below threshold/u);
    assert.doesNotMatch(log, /PushDeer notify event sent/u);
  } finally {
    cleanupTempWorkspace(shortWorkspace);
  }

  const failureWorkspace = makeTempWorkspace();
  try {
    const config = JSON.parse(fs.readFileSync(failureWorkspace.configPath, "utf8"));
    fs.writeFileSync(failureWorkspace.configPath, JSON.stringify({
      ...config,
      notifyMode: "errors_only",
    }, null, 2));
    const transcriptPath = writeClaudeTranscript(failureWorkspace, {
      sessionId: "claude-failure",
      completedAt: "2026-07-08T09:00:02.000Z",
    });
    runClaudeEvent(failureWorkspace, {
      session_id: "claude-failure",
      transcript_path: transcriptPath,
      cwd: failureWorkspace.cwd,
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "Rate limit reached",
      last_assistant_message: "API Error: Rate limit reached",
    }, { AGENTPING_DISABLE_LLM_SUMMARY: "1" });
    const log = readLog(failureWorkspace);
    assert.match(log, /PushDeer notify event sent/u);
    assert.match(log, /"terminalType":"task_failed"/u);
    assert.match(log, /"platform":"claude"/u);
  } finally {
    cleanupTempWorkspace(failureWorkspace);
  }
}

function testClaudeLive() {
  const workspace = makeTempWorkspace();
  try {
    const finalText = "AgentPing 的 Claude Code 通知适配已经完成真实链路验证。";
    const transcriptPath = writeClaudeTranscript(workspace, {
      sessionId: "claude-live-test",
      userText: "请验证 Claude Code 的 AgentPing 完成通知。",
      finalText,
    });
    const env = {
      ...process.env,
      AGENTPING_STATE_DIR: workspace.stateDir,
      AGENTPING_ALLOW_ANY_CLAUDE_TRANSCRIPT: "1",
    };
    if (!flags.has("--real")) env.AGENTPING_DRY_RUN = "1";
    const result = spawnSync(process.execPath, [claudeEventScript], {
      cwd: workspace.cwd,
      input: JSON.stringify({
        session_id: "claude-live-test",
        transcript_path: transcriptPath,
        cwd: workspace.cwd,
        hook_event_name: "Stop",
        last_assistant_message: finalText,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const log = readLog(workspace);
    assert.match(log, /PushDeer notify event sent/u);
    assert.match(log, /"platform":"claude"/u);
    assert.match(log, /"summarySource":"llm"/u);
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function testPushDryRun() {
  const workspace = makeTempWorkspace();
  try {
    const result = spawnSync(
      process.execPath,
      [notifyScript, "--title", "PushDeer dry-run 自测完成", "--desp", "这是 dry-run，不会真实发送。", "--dry-run"],
      {
        cwd: projectRoot,
        stdio: "pipe",
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          AGENTPING_CONFIG: workspace.configPath,
          AGENTPING_STATE_DIR: workspace.stateDir,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /dryRun/u);
    assert.doesNotMatch(result.stdout, /PDU[A-Za-z0-9_-]{12,}/u);
    assert.match(result.stdout, /"pushkey": "\[REDACTED\]"/u);
  } finally {
    cleanupTempWorkspace(workspace);
  }
}

function testLogRotation() {
  const workspace = makeTempWorkspace();
  const previousConfig = process.env.AGENTPING_CONFIG;
  const previousStateDir = process.env.AGENTPING_STATE_DIR;
  const previousMaxBytes = process.env.AGENTPING_LOG_MAX_BYTES;
  const previousKeepFiles = process.env.AGENTPING_LOG_KEEP_FILES;

  try {
    process.env.AGENTPING_CONFIG = workspace.configPath;
    process.env.AGENTPING_STATE_DIR = workspace.stateDir;
    process.env.AGENTPING_LOG_MAX_BYTES = "180";
    process.env.AGENTPING_LOG_KEEP_FILES = "2";

    for (let index = 0; index < 8; index += 1) {
      logEvent("info", "rotation test", {
        index,
        payload: "x".repeat(120),
      });
    }

    assert.ok(fs.existsSync(logPath()), "current log should exist");
    assert.ok(fs.existsSync(logPath(1)), "rotated log should exist");
  } finally {
    if (previousConfig === undefined) delete process.env.AGENTPING_CONFIG;
    else process.env.AGENTPING_CONFIG = previousConfig;
    if (previousStateDir === undefined) delete process.env.AGENTPING_STATE_DIR;
    else process.env.AGENTPING_STATE_DIR = previousStateDir;
    if (previousMaxBytes === undefined) delete process.env.AGENTPING_LOG_MAX_BYTES;
    else process.env.AGENTPING_LOG_MAX_BYTES = previousMaxBytes;
    if (previousKeepFiles === undefined) delete process.env.AGENTPING_LOG_KEEP_FILES;
    else process.env.AGENTPING_LOG_KEEP_FILES = previousKeepFiles;
    cleanupTempWorkspace(workspace);
  }
}

async function testQueueConcurrencyAndRecovery() {
  const workspace = makeTempWorkspace();
  const previousConfig = process.env.AGENTPING_CONFIG;
  const previousStateDir = process.env.AGENTPING_STATE_DIR;
  const previousDryRun = process.env.AGENTPING_DRY_RUN;
  const previousDisableSummary = process.env.AGENTPING_DISABLE_LLM_SUMMARY;
  try {
    process.env.AGENTPING_CONFIG = workspace.configPath;
    process.env.AGENTPING_STATE_DIR = workspace.stateDir;
    process.env.AGENTPING_DRY_RUN = "1";
    process.env.AGENTPING_DISABLE_LLM_SUMMARY = "1";

    enqueueCompletionEvent({
      agentId: "codex",
      agentType: "codex",
      eventId: "queue-codex",
      sessionId: "queue-codex-session",
      status: "success",
      finalText: "Codex 队列并发测试已完成。",
      durationMs: 12_000,
      cwd: workspace.cwd,
    });
    enqueueCompletionEvent({
      agentId: "claude",
      agentType: "claude",
      eventId: "queue-claude",
      sessionId: "queue-claude-session",
      status: "success",
      finalText: "Claude 队列并发测试已完成。",
      durationMs: 13_000,
      cwd: workspace.cwd,
    });
    assert.equal(queueStatus().ready, 2);
    assert.equal(acquireQueueLock(), true);
    assert.equal(acquireQueueLock(), false);
    releaseQueueLock();

    const firstRun = await drainCompletionQueue();
    assert.equal(firstRun.acquired, true);
    assert.equal(firstRun.processed, 2);
    assert.equal(firstRun.failed, 0);
    assert.deepEqual(queueStatus(), { ready: 0, processing: 0, failed: 0, locked: false });

    enqueueCompletionEvent({
      agentId: "codex",
      agentType: "codex",
      eventId: "queue-recovery",
      sessionId: "queue-recovery-session",
      status: "success",
      finalText: "队列处理中断恢复测试已完成。",
      durationMs: 14_000,
      cwd: workspace.cwd,
    });
    const paths = queuePaths();
    const queuedFile = fs.readdirSync(paths.ready).find((name) => name.endsWith(".json"));
    fs.renameSync(path.join(paths.ready, queuedFile), path.join(paths.processing, queuedFile));
    const recoveryRun = await drainCompletionQueue();
    assert.equal(recoveryRun.processed, 1);
    assert.deepEqual(queueStatus(), { ready: 0, processing: 0, failed: 0, locked: false });

    const sentCount = readLog(workspace).split("PushDeer notify event sent").length - 1;
    assert.equal(sentCount, 3);
  } finally {
    if (previousConfig === undefined) delete process.env.AGENTPING_CONFIG;
    else process.env.AGENTPING_CONFIG = previousConfig;
    if (previousStateDir === undefined) delete process.env.AGENTPING_STATE_DIR;
    else process.env.AGENTPING_STATE_DIR = previousStateDir;
    if (previousDryRun === undefined) delete process.env.AGENTPING_DRY_RUN;
    else process.env.AGENTPING_DRY_RUN = previousDryRun;
    if (previousDisableSummary === undefined) delete process.env.AGENTPING_DISABLE_LLM_SUMMARY;
    else process.env.AGENTPING_DISABLE_LLM_SUMMARY = previousDisableSummary;
    cleanupTempWorkspace(workspace);
  }
}

function testFailedQueueRetry() {
  const workspace = makeTempWorkspace();
  const previousStateDir = process.env.AGENTPING_STATE_DIR;
  process.env.AGENTPING_STATE_DIR = workspace.stateDir;
  try {
    enqueueCompletionEvent({
      agentId: "hermes",
      agentType: "hermes",
      eventId: "retry-event",
      finalText: "需要重试的完整回答。",
      durationMs: 20_000,
    });
    const claim = claimNextEvent();
    assert.ok(claim);
    failClaim(claim, new Error("delivery failed for PDU12345678901234567890"));
    const failedFile = fs.readdirSync(queuePaths().failed)[0];
    const failed = JSON.parse(fs.readFileSync(path.join(queuePaths().failed, failedFile), "utf8"));
    assert.equal(failed.event.finalText, "需要重试的完整回答。");
    assert.doesNotMatch(failed.error, /PDU123/u);
    assert.equal(requeueFailedEvents(), 1);
    const retried = claimNextEvent();
    assert.equal(retried.envelope.attempts, 1);
    completeClaim(retried);
    assert.deepEqual(queueStatus(), { ready: 0, processing: 0, failed: 0, locked: false });
  } finally {
    if (previousStateDir === undefined) delete process.env.AGENTPING_STATE_DIR;
    else process.env.AGENTPING_STATE_DIR = previousStateDir;
    cleanupTempWorkspace(workspace);
  }
}

function testLegacyEnvCompatibility() {
  const workspace = makeTempWorkspace();
  const previousAgentConfig = process.env.AGENTPING_CONFIG;
  const previousLegacyConfig = process.env.CODEX_PUSHDEER_CONFIG;

  try {
    const legacyConfig = {
      pushkey: "legacy-pushkey",
      summaryModel: "legacy-model",
      notifyMode: "long_only",
      minDurationMs: 15000,
    };
    fs.writeFileSync(workspace.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
    delete process.env.AGENTPING_CONFIG;
    process.env.CODEX_PUSHDEER_CONFIG = workspace.configPath;

    const config = loadConfig();
    assert.equal(config.pushkey, "legacy-pushkey");
    assert.equal(config.summaryModel, "legacy-model");
    assert.equal(config.notifyMode, "long_only");
    assert.equal(config.minDurationMs, 15000);
  } finally {
    if (previousAgentConfig === undefined) delete process.env.AGENTPING_CONFIG;
    else process.env.AGENTPING_CONFIG = previousAgentConfig;
    if (previousLegacyConfig === undefined) delete process.env.CODEX_PUSHDEER_CONFIG;
    else process.env.CODEX_PUSHDEER_CONFIG = previousLegacyConfig;
    cleanupTempWorkspace(workspace);
  }
}

function testNotifyConfigHelpers() {
  const agentScript = path.join(projectRoot, "plugins", "agentping", "scripts", "pushdeer-notify-event.mjs");
  const legacyScript = path.join(projectRoot, "plugins", "codex-pushdeer-notifier", "scripts", "pushdeer-notify-event.mjs");
  const desiredCommand = notifyCommandForScript(agentScript);
  const legacyCommand = notifyCommandForScript(legacyScript);
  const legacyPathFragments = [
    legacyScript,
    "/plugins/codex-pushdeer-notifier/scripts/pushdeer-notify-event.mjs",
    "/.codex/notify-multiplexer.mjs",
  ];

  const direct = [
    "# config",
    notifyLineForCommand(legacyCommand),
    "",
    "[projects.\"/tmp/work\"]",
  ].join("\n");
  const directResult = replaceTopLevelNotify(direct, {
    desiredCommand,
    legacyCommands: [legacyCommand],
    legacyPathFragments,
  });
  assert.equal(directResult.reason, "legacy notify replaced");
  assert.match(directResult.contents, new RegExp(agentScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));

  const wrapperCommand = [
    "/Applications/ChatGPT.app/Contents/Resources/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient",
    "turn-ended",
    "--previous-notify",
    JSON.stringify(["node", "/Users/example/.codex/notify-multiplexer.mjs"]),
  ];
  const wrapped = [
    "# config",
    notifyLineForCommand(wrapperCommand),
    "",
    "[projects.\"/tmp/work\"]",
  ].join("\n");
  const wrappedResult = replaceTopLevelNotify(wrapped, {
    desiredCommand,
    legacyCommands: [legacyCommand],
    legacyPathFragments,
  });
  assert.equal(wrappedResult.reason, "legacy wrapped notify replaced");
  assert.match(wrappedResult.contents, /--previous-notify/u);
  assert.match(wrappedResult.contents, new RegExp(agentScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));

  const status = notifyConfigStatus(wrappedResult.contents, {
    desiredCommand,
    notifyScript: agentScript,
    legacyCommands: [legacyCommand],
    legacyPathFragments,
  });
  assert.equal(status.ok, true);
  assert.equal(status.detail, "notify wrapper delegates to the configured AgentPing runtime");
}

function testAdapterSdkAndOpenClaw() {
  const extracted = openClawCompletionEvent({
    success: true,
    durationMs: 12_345,
    model: "test-model",
    provider: "test-provider",
    usage: {
      input_tokens: 2_500,
      cached_input_tokens: 2_000,
      output_tokens: 250,
    },
    messages: [
      { role: "user", content: [{ type: "text", text: "请完成测试" }] },
      { role: "assistant", content: [{ type: "text", text: "中间过程" }] },
      { role: "assistant", content: [{ type: "text", text: "测试已经完成。" }] },
    ],
  }, { sessionId: "openclaw-session", cwd: "/tmp/openclaw" });
  const event = normalizeCompletionEvent(extracted);
  assert.equal(event.agentId, "openclaw");
  assert.equal(event.sessionId, "openclaw-session");
  assert.equal(event.userText, "请完成测试");
  assert.equal(event.finalText, "测试已经完成。");
  assert.equal(event.durationMs, 12_345);
  assert.equal(event.status, "success");
  assert.equal(event.model, "test-model");
  assert.equal(event.usage.inputTokens, 2_500);
  assert.throws(() => normalizeCompletionEvent({ agentType: "openclaw" }), /finalText/u);
  assert.equal(pushkeyForPlatform({ pushkey: "codex-only" }, "openclaw"), "");
  assert.equal(pushkeyForPlatform({ pushkey: "codex-only" }, "hermes"), "");
}

function testHermesPluginHooks() {
  const script = [
    "import importlib.util, json",
    `spec=importlib.util.spec_from_file_location('agentping_hermes', ${JSON.stringify(path.join(projectRoot, "integrations", "hermes", "__init__.py"))})`,
    "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
    "hooks={}",
    "class Context:",
    " def register_hook(self, name, callback): hooks[name]=callback",
    "module.register(Context())",
    "captured=[]",
    "module._ingest_script=lambda: type('P', (), {'is_file': lambda self: True})()",
    "module.subprocess.Popen=lambda args, **kwargs: captured.append(json.loads(args[2]))",
    "hooks['pre_llm_call'](session_id='hermes-session')",
    "hooks['post_llm_call'](session_id='hermes-session', user_message='执行测试', assistant_response='Hermes 测试完成。', model='test-model', platform='cli', provider='test-provider', usage={'input_tokens': 1200, 'output_tokens': 120})",
    "print(json.dumps({'hooks': sorted(hooks), 'event': captured[0]}, ensure_ascii=False))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.hooks, ["post_llm_call", "pre_llm_call"]);
  assert.equal(output.event.agentId, "hermes");
  assert.equal(output.event.sessionId, "hermes-session");
  assert.equal(output.event.finalText, "Hermes 测试完成。");
  assert.equal(output.event.provider, "test-provider");
  assert.equal(output.event.usage.input_tokens, 1200);
  assert.ok(output.event.durationMs >= 0);
}

function testRuntimeInstallAndRollback() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentping-runtime-test-"));
  const previous = process.env.AGENTPING_RUNTIME_DIR;
  process.env.AGENTPING_RUNTIME_DIR = path.join(root, "runtime");
  try {
    installRuntime({ projectRoot, version: "0.5.9-test" });
    installRuntime({ projectRoot, version: "0.6.0-test" });
    assert.equal(runtimeStatus().currentVersion, "0.6.0-test");
    assert.equal(runtimeStatus().previousVersion, "0.5.9-test");
    const installedNotifier = path.join(
      runtimeStatus().resolvedPath,
      "plugins",
      "agentping",
      "scripts",
      "pushdeer-notify-event.mjs",
    );
    fs.writeFileSync(installedNotifier, "stale same-version runtime");
    installRuntime({ projectRoot, version: "0.6.0-test" });
    assert.equal(
      fs.readFileSync(installedNotifier, "utf8"),
      fs.readFileSync(path.join(projectRoot, "plugins", "agentping", "scripts", "pushdeer-notify-event.mjs"), "utf8"),
    );
    assert.equal(runtimeStatus().previousVersion, "0.5.9-test");
    const rolledBack = rollbackRuntime();
    assert.equal(rolledBack.version, "0.5.9-test");
    assert.equal(runtimeStatus().currentVersion, "0.5.9-test");
    assert.ok(fs.existsSync(path.join(runtimeStatus().resolvedPath, "plugins", "agentping", "scripts", "agentping-ingest.mjs")));
  } finally {
    if (previous === undefined) delete process.env.AGENTPING_RUNTIME_DIR;
    else process.env.AGENTPING_RUNTIME_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPlatformIntegrationInstallers() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentping-platform-test-"));
  const previousPath = process.env.PATH;
  const previousHermesDir = process.env.HERMES_PLUGIN_DIR;
  const binDir = path.join(root, "bin");
  const commandLog = path.join(root, "openclaw.log");
  fs.mkdirSync(binDir, { recursive: true });
  const openClawStub = path.join(binDir, "openclaw");
  fs.writeFileSync(openClawStub, [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" >> ${JSON.stringify(commandLog)}`,
    "if [ \"$1 $2\" = \"plugins list\" ]; then echo 'agentping installed'; fi",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.HERMES_PLUGIN_DIR = path.join(root, "hermes-plugins", "agentping");
  try {
    const openClaw = installOpenClawIntegration({ runtimeRoot: projectRoot });
    assert.equal(openClaw.installed, true);
    assert.equal(openClawIntegrationStatus().installed, true);
    const calls = fs.readFileSync(commandLog, "utf8");
    assert.match(calls, /plugins install/u);
    assert.match(calls, /allowConversationAccess true/u);

    const hermes = installHermesIntegration({ runtimeRoot: projectRoot });
    assert.equal(hermes.installed, true);
    assert.equal(hermesIntegrationStatus().installed, true);
    assert.ok(fs.existsSync(path.join(process.env.HERMES_PLUGIN_DIR, "__init__.py")));
  } finally {
    process.env.PATH = previousPath;
    if (previousHermesDir === undefined) delete process.env.HERMES_PLUGIN_DIR;
    else process.env.HERMES_PLUGIN_DIR = previousHermesDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPushReal() {
  const result = spawnSync(
    process.execPath,
    [notifyScript, "--title", "AgentPing 真实发送自测完成", "--desp", "这是 AgentPing 的真实发送自测。"],
    {
      cwd: projectRoot,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok": true/u);
}

const tests = {
  format: () => test("format helpers", testFormatHelpers),
  config_migration: () => test("config field migration", testConfigFieldMigration),
  final: () => test("final-only notification", testFinalOnlyNotification),
  subagent: () => test("Codex subagent completion is suppressed", testSubagentNotificationSuppressed),
  codex_usage: () => test("Codex usage includes subagents", testCodexUsageIncludesSubagents),
  summary: () => test("LLM summary is used whole", testLlmSummaryIsUsedWhole),
  summary_fallback: () => test("invalid LLM summary uses fixed fallback", testInvalidLlmSummaryUsesFixedFallback),
  logs: () => test("log rotation", testLogRotation),
  queue: () => test("concurrent queue and recovery", testQueueConcurrencyAndRecovery),
  queue_retry: () => test("failed queue retry", testFailedQueueRetry),
  legacy: () => test("legacy env compatibility", testLegacyEnvCompatibility),
  project: () => test("project config overrides", testProjectConfigOverrides),
  notify: () => test("notify config helpers", testNotifyConfigHelpers),
  claude_hooks: () => test("Claude hook config helpers", testClaudeHookConfigHelpers),
  claude_stop: () => test("Claude Stop notification", testClaudeStopNotification),
  claude_modes: () => test("Claude modes and failure", testClaudeModesAndFailure),
  adapters: () => test("Adapter SDK and OpenClaw event", testAdapterSdkAndOpenClaw),
  hermes: () => test("Hermes plugin hooks", testHermesPluginHooks),
  runtime: () => test("runtime install and rollback", testRuntimeInstallAndRollback),
  platform_install: () => test("platform integration installers", testPlatformIntegrationInstallers),
  claude_live: () => test(flags.has("--real") ? "real Claude notification" : "Claude live dry-run", testClaudeLive),
  push: () => test(flags.has("--real") ? "real PushDeer push" : "dry-run PushDeer push", flags.has("--real") ? testPushReal : testPushDryRun),
};

if (command === "all") {
  await tests.format();
  await tests.config_migration();
  await tests.final();
  await tests.subagent();
  await tests.codex_usage();
  await tests.summary();
  await tests.summary_fallback();
  await tests.logs();
  await tests.queue();
  await tests.queue_retry();
  await tests.legacy();
  await tests.project();
  await tests.notify();
  await tests.claude_hooks();
  await tests.claude_stop();
  await tests.claude_modes();
  await tests.adapters();
  await tests.hermes();
  await tests.runtime();
  await tests.platform_install();
  await tests.push();
} else if (tests[command]) {
  await tests[command]();
} else {
  console.error("Usage: agentping test [all|format|config_migration|final|subagent|codex_usage|summary|summary_fallback|logs|queue|queue_retry|legacy|project|notify|claude_hooks|claude_stop|claude_modes|adapters|hermes|runtime|platform_install|claude_live|push] [--real]");
  process.exit(2);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
