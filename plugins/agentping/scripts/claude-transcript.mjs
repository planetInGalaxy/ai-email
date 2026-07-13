import fs from "node:fs";
import readline from "node:readline";
import { mergeUsage, normalizeUsage } from "./usage.mjs";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readClaudeTranscriptCompletion(transcriptPath) {
  const stream = fs.createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let userText = "";
  let userStartedAt = null;
  let assistantCompletedAt = null;
  let assistantUuid = "";
  let model = "";
  let usage = null;

  for await (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type === "user" && entry?.userType === "external") {
      const text = contentText(entry.message?.content).trim();
      if (text) {
        userText = text;
        userStartedAt = timestampMs(entry.timestamp);
        assistantCompletedAt = null;
        assistantUuid = "";
        model = "";
        usage = null;
      }
      continue;
    }

    if (entry?.type === "assistant" && userStartedAt !== null) {
      const entryModel = String(entry.message?.model || entry.model || "").trim();
      const entryUsage = normalizeUsage(entry.message?.usage, {
        model: entryModel,
        provider: "anthropic",
      });
      if (entryUsage) usage = mergeUsage(usage, entryUsage);
      if (entryModel) model = entryModel;
      const text = contentText(entry.message?.content).trim();
      if (text) {
        assistantCompletedAt = timestampMs(entry.timestamp) ?? assistantCompletedAt;
        assistantUuid = String(entry.uuid || assistantUuid);
      }
    }
  }

  const durationMs = userStartedAt !== null && assistantCompletedAt !== null
    ? Math.max(0, assistantCompletedAt - userStartedAt)
    : null;
  return {
    userText,
    userStartedAt,
    assistantCompletedAt,
    assistantUuid,
    durationMs,
    model,
    provider: model ? "anthropic" : "",
    usage,
  };
}
