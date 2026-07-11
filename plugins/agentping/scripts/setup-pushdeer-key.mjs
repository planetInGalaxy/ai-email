#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  DEFAULT_ENDPOINT,
  configPath,
  configSourcePath,
  envValue,
  loadConfig,
  parseArgs,
  readStdin,
  saveConfigPatch,
  sendPushDeer,
} from "./pushdeer-lib.mjs";

const args = parseArgs();
const platform = String(args.platform || "codex").trim().toLowerCase();
if (!new Set(["codex", "claude"]).has(platform)) {
  console.error("platform must be codex or claude");
  process.exit(2);
}

async function promptHidden(question) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve, reject) => {
    const chars = [];

    function cleanup() {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
    }

    function onData(data) {
      for (const char of String(data)) {
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          output.write("\n");
          resolve(chars.join("").trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          chars.pop();
          continue;
        }
        chars.push(char);
      }
    }

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function resolveKey() {
  if (args.key) return String(args.key).trim();
  if (args.stdin) {
    const piped = (await readStdin()).trim();
    if (piped) return piped;
    return promptHidden(`${platform === "claude" ? "Claude" : "Codex"} PushDeer key: `);
  }
  const envKey = platform === "claude"
    ? envValue("AGENTPING_CLAUDE_PUSHDEER_KEY", "CLAUDE_PUSHDEER_KEY")
    : envValue("AGENTPING_PUSHDEER_KEY", "AGENTPING_KEY", "PUSHDEER_KEY", "CODEX_PUSHDEER_KEY");
  if (envKey) return envKey.trim();

  return promptHidden(`${platform === "claude" ? "Claude" : "Codex"} PushDeer key: `);
}

if (args.show) {
  const config = loadConfig();
  console.log(JSON.stringify({
    configPath: configPath(),
    configSourcePath: configSourcePath(),
    projectConfigPath: config.projectConfigPath,
    endpoint: config.endpoint || DEFAULT_ENDPOINT,
    hasCodexPushKey: Boolean(config.pushkey),
    hasClaudePushKey: Boolean(config.claudePushkey),
    CodexSummaryModel: config.summaryModel,
    ClaudeSummaryModel: config.claudeSummaryModel,
    summaryMinChars: config.summaryMinChars,
    summaryMaxChars: config.summaryMaxChars,
    summaryFallbackText: config.summaryFallbackText,
    llmTimeoutMs: config.llmTimeoutMs,
    despMaxChars: config.despMaxChars,
    despSeparator: config.despSeparator,
    finalWaitMs: config.finalWaitMs,
    notifyMode: config.notifyMode,
    minDurationMs: config.minDurationMs,
    logMaxBytes: config.logMaxBytes,
    logKeepFiles: config.logKeepFiles,
    debugLogs: config.debugLogs,
    titleTemplate: config.titleTemplate,
    despTemplate: config.despTemplate,
    finalTextPreviewHeadChars: config.finalTextPreviewHeadChars,
    finalTextPreviewTailChars: config.finalTextPreviewTailChars,
    finalTextPreviewMarker: config.finalTextPreviewMarker,
  }, null, 2));
  process.exit(0);
}

if (args.unset) {
  const patch = platform === "claude"
    ? { ClaudePushKey: undefined }
    : { CodexPushKey: undefined };
  saveConfigPatch({ ...patch, endpoint: args.endpoint || DEFAULT_ENDPOINT });
  console.log(`Removed stored ${platform} PushDeer key from ${configPath()}`);
  process.exit(0);
}

const key = await resolveKey();
if (!key) {
  console.error("PushDeer key is required.");
  process.exit(2);
}

const endpoint = args.endpoint || DEFAULT_ENDPOINT;
saveConfigPatch({
  [platform === "claude" ? "ClaudePushKey" : "CodexPushKey"]: key,
  endpoint,
});

console.log(`Saved ${platform} PushDeer config to ${configPath()}`);

if (args.test) {
  const result = await sendPushDeer({
    title: "配置完成",
    endpoint,
    pushkey: key,
    dryRun: Boolean(args["dry-run"]),
  });
  console.log(JSON.stringify(result, null, 2));
}
