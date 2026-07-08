#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  DEFAULT_ENDPOINT,
  configPath,
  loadConfig,
  parseArgs,
  readStdin,
  saveConfigPatch,
  sendPushDeer,
} from "./pushdeer-lib.mjs";

const args = parseArgs();

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
    return promptHidden("PushDeer pushkey: ");
  }
  if (process.env.PUSHDEER_KEY) return process.env.PUSHDEER_KEY.trim();
  if (process.env.CODEX_PUSHDEER_KEY) return process.env.CODEX_PUSHDEER_KEY.trim();

  return promptHidden("PushDeer pushkey: ");
}

if (args.show) {
  const config = loadConfig();
  console.log(JSON.stringify({
    configPath: configPath(),
    endpoint: config.endpoint || DEFAULT_ENDPOINT,
    hasPushkey: Boolean(config.pushkey),
    summaryModel: config.summaryModel,
    llmTimeoutMs: config.llmTimeoutMs,
    despMaxChars: config.despMaxChars,
    despSeparator: config.despSeparator,
  }, null, 2));
  process.exit(0);
}

if (args.unset) {
  saveConfigPatch({
    pushkey: undefined,
    pushKey: undefined,
    endpoint: args.endpoint || DEFAULT_ENDPOINT,
  });
  console.log(`Removed stored PushDeer key from ${configPath()}`);
  process.exit(0);
}

const key = await resolveKey();
if (!key) {
  console.error("PushDeer pushkey is required.");
  process.exit(2);
}

const endpoint = args.endpoint || DEFAULT_ENDPOINT;
saveConfigPatch({
  pushkey: key,
  endpoint,
});

console.log(`Saved PushDeer config to ${configPath()}`);

if (args.test) {
  const result = await sendPushDeer({
    title: "配置完成",
    endpoint,
    pushkey: key,
    dryRun: Boolean(args["dry-run"]),
  });
  console.log(JSON.stringify(result, null, 2));
}
