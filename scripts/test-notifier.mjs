#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DESP_SEPARATOR,
  charLength,
  fallbackDescription,
  formatDesp,
  loadConfig,
  logEvent,
  logPath,
  normalizeNotifyMode,
  normalizeSummaryCharBounds,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(projectRoot, "plugins", "agentping");
const eventScript = path.join(pluginRoot, "scripts", "pushdeer-notify-event.mjs");
const notifyScript = path.join(pluginRoot, "scripts", "pushdeer-notify.mjs");
const command = process.argv[2] || "all";
const flags = new Set(process.argv.slice(3));

function test(name, fn) {
  try {
    fn();
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
    endpoint: "https://api2.pushdeer.com/message/push",
    summaryMinChars: 30,
    summaryMaxChars: 60,
    llmTimeoutMs: 3000,
    despMaxChars: 300,
    despSeparator: DEFAULT_DESP_SEPARATOR,
    finalWaitMs: 0,
    notifyMode: "always",
    minDurationMs: 30000,
    logMaxBytes: 2097152,
    logKeepFiles: 3,
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
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: workspace.cwd,
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
        ...extraEnv,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `event script exited ${result.status}`);
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
  const { summaryMinChars, summaryMaxChars } = normalizeSummaryCharBounds(60, 30);
  assert.equal(summaryMinChars, 60);
  assert.equal(summaryMaxChars, 60);
  assert.equal(normalizeNotifyMode("manual"), "off");
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

function makeStubCodex(workspace, summary) {
  const binDir = path.join(workspace.root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const stubPath = path.join(binDir, "codex");
  const source = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const outputIndex = process.argv.indexOf('--output-last-message');",
    "if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], process.env.STUB_CODEX_SUMMARY || '');",
  ].join("\n");
  fs.writeFileSync(stubPath, source, { mode: 0o755 });
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    STUB_CODEX_SUMMARY: summary,
  };
}

function testLlmSummaryIsUsedWhole() {
  const workspace = makeTempWorkspace();
  try {
    const turnId = "turn-llm-summary";
    const summary = "已完成完整回答摘要，保留关键结论和下一步动作，语义完整且未硬截断。";
    writeSession(workspace, {
      turnId,
      finalText: "这是一个很长的最终回答。它包含结论、代码修改、验证结果和后续建议，不能只截取开头。",
    });
    const stubEnv = makeStubCodex(workspace, summary);
    runEvent(workspace, {
      type: "agent-turn-complete",
      "turn-id": turnId,
      "input-messages": [{ text: "请完成任务并总结" }],
    }, stubEnv);
    const log = readLog(workspace);
    assert.match(log, /PushDeer notify event sent/u);
    assert.match(log, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
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
  final: () => test("final-only notification", testFinalOnlyNotification),
  summary: () => test("LLM summary is used whole", testLlmSummaryIsUsedWhole),
  logs: () => test("log rotation", testLogRotation),
  legacy: () => test("legacy env compatibility", testLegacyEnvCompatibility),
  push: () => test(flags.has("--real") ? "real PushDeer push" : "dry-run PushDeer push", flags.has("--real") ? testPushReal : testPushDryRun),
};

if (command === "all") {
  tests.format();
  tests.final();
  tests.summary();
  tests.logs();
  tests.legacy();
  tests.push();
} else if (tests[command]) {
  tests[command]();
} else {
  console.error("Usage: agentping test [all|format|final|summary|logs|legacy|push] [--real]");
  process.exit(2);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
