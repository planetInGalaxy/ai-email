#!/usr/bin/env node
import fs from "node:fs";
import {
  ensureDir,
  loadConfig,
  logPath,
  parseArgs,
  redactText,
  rotateLogIfNeeded,
  stateDir,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";

const args = parseArgs();
const command = args._[0] || "status";

function usage() {
  console.log([
    "Usage: agentping logs <command> [options]",
    "",
    "Commands:",
    "  status             Show log path, current size, and rotated files",
    "  path               Print current log path",
    "  tail [n]           Print last n log lines, default 30",
    "  summary [n]        Summarize recent log lines, default 100",
    "  rotate             Force log rotation",
    "  clear              Delete notifier logs",
  ].join("\n"));
}

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      size: 0,
      mtime: null,
    };
  }
}

function rotatedFiles() {
  const config = loadConfig();
  const maxIndex = Math.max(20, config.logKeepFiles || 0);
  const files = [];
  for (let index = 1; index <= maxIndex; index += 1) {
    const info = fileInfo(logPath(index));
    if (info.exists) files.push(info);
  }
  return files;
}

function status() {
  const config = loadConfig();
  console.log(JSON.stringify({
    stateDir: stateDir(),
    log: fileInfo(logPath()),
    rotated: rotatedFiles(),
    logMaxBytes: config.logMaxBytes,
    logKeepFiles: config.logKeepFiles,
  }, null, 2));
}

function tail() {
  const lineCount = Number.parseInt(args.lines || args._[1] || "30", 10);
  const count = Number.isFinite(lineCount) && lineCount > 0 ? Math.min(lineCount, 500) : 30;
  let contents = "";
  try {
    contents = fs.readFileSync(logPath(), "utf8");
  } catch {
    return;
  }
  const lines = contents.trimEnd().split(/\n/).slice(-count);
  if (lines.length) {
    console.log(lines.map((line) => redactText(line)).join("\n"));
  }
}

function readRecentEntries(count) {
  let contents = "";
  try {
    contents = fs.readFileSync(logPath(), "utf8");
  } catch {
    return [];
  }
  return contents
    .trimEnd()
    .split(/\n/)
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          ts: "",
          level: "unknown",
          message: redactText(line),
        };
      }
    });
}

export function summarizeEntries(entries) {
  const counts = {};
  for (const entry of entries) {
    counts[entry.level || "unknown"] = (counts[entry.level || "unknown"] || 0) + 1;
  }
  const lastSent = [...entries].reverse().find((entry) => /sent/u.test(entry.message || ""));
  const lastWarn = [...entries].reverse().find((entry) => entry.level === "warn");
  const lastError = [...entries].reverse().find((entry) => entry.level === "error");
  return {
    entries: entries.length,
    counts,
    lastSent: lastSent
      ? {
          ts: lastSent.ts || "",
          message: lastSent.message || "",
          summarySource: lastSent.summarySource || "",
          summaryElapsedMs: lastSent.summaryElapsedMs ?? null,
          summaryError: lastSent.summaryError || "",
          durationMs: lastSent.durationMs ?? null,
        }
      : null,
    lastWarn: lastWarn
      ? {
          ts: lastWarn.ts || "",
          message: lastWarn.message || "",
          error: lastWarn.error || lastWarn.summaryError || "",
        }
      : null,
    lastError: lastError
      ? {
          ts: lastError.ts || "",
          message: lastError.message || "",
          error: lastError.error || "",
        }
      : null,
  };
}

function summary() {
  const lineCount = Number.parseInt(args.lines || args._[1] || "100", 10);
  const count = Number.isFinite(lineCount) && lineCount > 0 ? Math.min(lineCount, 1000) : 100;
  console.log(JSON.stringify(summarizeEntries(readRecentEntries(count)), null, 2));
}

function rotate() {
  ensureDir(stateDir());
  const rotated = rotateLogIfNeeded({ force: true });
  console.log(rotated ? `Rotated ${logPath()}` : `No log file to rotate at ${logPath()}`);
}

function clear() {
  let count = 0;
  for (let index = 0; index <= 50; index += 1) {
    const filePath = logPath(index);
    if (!fs.existsSync(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    count += 1;
  }
  console.log(`Deleted ${count} log file${count === 1 ? "" : "s"}.`);
}

switch (command) {
  case "status":
    status();
    break;
  case "path":
    console.log(logPath());
    break;
  case "tail":
    tail();
    break;
  case "summary":
    summary();
    break;
  case "rotate":
    rotate();
    break;
  case "clear":
    clear();
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown logs command: ${command}`);
    usage();
    process.exit(2);
}
