#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFinalTextFromPayload,
  extractTurnId,
  findLatestFinalMessage,
  hashText,
  logEvent,
  markSent,
  readStdin,
  safeJsonParse,
  summarizeFinalText,
  wasAlreadySent,
} from "./pushdeer-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopDelayMs() {
  const raw = process.env.CODEX_PUSHDEER_STOP_DELAY_MS;
  if (raw == null || raw === "") return 500;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 500;
  return Math.min(parsed, 3000);
}

async function main() {
  const raw = await readStdin();
  const payload = safeJsonParse(raw) || {};

  let finalText = extractFinalTextFromPayload(payload);
  let turnId = extractTurnId(payload);
  let source = "hook-payload";

  if (!finalText) {
    await sleep(stopDelayMs());
    const latest = await findLatestFinalMessage({ cwd: process.cwd(), retries: 4 });
    if (latest?.finalText) {
      finalText = latest.finalText;
      turnId = turnId || latest.turnId;
      source = "session-transcript";
    }
  }

  const summary = summarizeFinalText(finalText, payload);
  const sendId = turnId || hashText(`${source}:${finalText}:${Date.now()}`).slice(0, 24);

  if (wasAlreadySent(sendId)) {
    logEvent("info", "Skipping duplicate PushDeer hook notification", { sendId, source });
    return;
  }

  markSent(sendId);

  const notifyScript = path.join(__dirname, "pushdeer-notify.mjs");
  const args = [
    notifyScript,
    "--title",
    summary.title,
    "--quiet",
  ];

  if (process.env.CODEX_PUSHDEER_DRY_RUN) {
    args.push("--dry-run");
  }

  logEvent("info", "Starting PushDeer hook notification", {
    sendId,
    source,
    text: summary.title,
  });

  if (process.env.CODEX_PUSHDEER_HOOK_SYNC) {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, args, { stdio: "inherit" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    return;
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

main().catch((error) => {
  logEvent("error", "PushDeer hook failed before notification", {
    error: error?.message || String(error),
  });
  process.exit(0);
});
