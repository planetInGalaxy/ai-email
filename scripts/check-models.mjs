#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SUMMARY_MODEL,
  charLength,
  codexSummaryExecArgs,
  codexTransportDiagnostics,
  configPath,
  loadConfig,
  saveConfigPatch,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";
import { SUMMARY_MODEL_CANDIDATES, chooseSummaryModel, listCodexModels } from "./model-utils.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    if (eq > 2) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs();
const current = loadConfig();
const preferredModel = args.model ||
  args["summary-model"] ||
  current.summaryModel ||
  process.env.AGENTPING_SUMMARY_MODEL ||
  process.env.CODEX_PUSHDEER_SUMMARY_MODEL ||
  "";
const timeoutMs = Number.parseInt(
  args.timeout || args["llm-timeout-ms"] || current.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS,
  10,
);
const selection = chooseSummaryModel({ preferredModel });
const catalog = listCodexModels();

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseModelList(value) {
  return String(value || "")
    .split(/[, ]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function benchmarkRuns() {
  const fromBenchmark = args.benchmark && args.benchmark !== true ? args.benchmark : "";
  const parsed = Number.parseInt(args.runs || fromBenchmark || "3", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return Math.min(parsed, 10);
}

function benchmarkCandidates() {
  const requested = parseModelList(args.models || args.modelList || "");
  if (requested.length) return requested;
  if (catalog.models.length) {
    const preferred = selection.model || DEFAULT_SUMMARY_MODEL;
    return unique([
      preferred,
      ...SUMMARY_MODEL_CANDIDATES,
    ]).filter((model) => catalog.models.includes(model));
  }
  return unique([selection.model || DEFAULT_SUMMARY_MODEL]);
}

function runOneBenchmark(model, timeout) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentping-model-benchmark-"));
  const outputFile = path.join(tempDir, "summary.txt");
  const prompt = "用一句中文短句概括：AgentPing 正在测试摘要模型速度。";
  const input = "用户问题：测试 AgentPing 摘要速度。\n\n助手回答：AgentPing 已完成一次摘要模型速度测试。";
  const startedAt = Date.now();
  try {
    const result = spawnSync(
      "codex",
      codexSummaryExecArgs({ model, outputFile, prompt }),
      {
        input,
        encoding: "utf8",
        stdio: "pipe",
        timeout,
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
    let outputText = "";
    try {
      outputText = fs.readFileSync(outputFile, "utf8").trim();
    } catch {
      outputText = "";
    }
    return {
      ok: result.status === 0 && Boolean(outputText),
      elapsedMs,
      status: result.status,
      signal: result.signal || "",
      outputChars: Array.from(outputText).length,
      inputChars: charLength(input),
      ...codexTransportDiagnostics(result.stderr, {
        timedOut: result.signal === "SIGTERM",
      }),
      error: result.status === 0 && outputText
        ? ""
        : (result.signal || (result.stderr || result.stdout || "empty output").trim()).slice(0, 300),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function benchmarkModels({ models, runs, timeout }) {
  return models.map((model) => {
    const attempts = [];
    for (let index = 0; index < runs; index += 1) {
      attempts.push(runOneBenchmark(model, timeout));
    }
    const successes = attempts.filter((attempt) => attempt.ok);
    const elapsed = successes.map((attempt) => attempt.elapsedMs);
    const avgMs = elapsed.length
      ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length)
      : null;
    return {
      model,
      ok: successes.length > 0,
      runs,
      successes: successes.length,
      avgMs,
      minMs: elapsed.length ? Math.min(...elapsed) : null,
      maxMs: elapsed.length ? Math.max(...elapsed) : null,
      attempts,
    };
  });
}

const shouldBenchmark = Boolean(args.benchmark || args["write-fastest"]);
const benchmark = shouldBenchmark
  ? benchmarkModels({
      models: benchmarkCandidates(),
      runs: benchmarkRuns(),
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LLM_TIMEOUT_MS,
    })
  : [];
const fastest = benchmark
  .filter((item) => item.ok && item.avgMs !== null)
  .sort((a, b) => a.avgMs - b.avgMs)[0] || null;

const output = {
  configPath: configPath(),
  selectedSummaryModel: selection.model || DEFAULT_SUMMARY_MODEL,
  selectionSource: selection.source,
  configuredSummaryModel: current.summaryModel,
  codexDefaultModel: selection.codexDefaultModel,
  llmTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LLM_TIMEOUT_MS,
  availableModels: catalog.models,
  catalogError: catalog.ok ? "" : catalog.error,
  benchmark,
  fastestSummaryModel: fastest?.model || "",
};

if (args["write-fastest"] && fastest) {
  saveConfigPatch({
    summaryModel: fastest.model,
    llmTimeoutMs: output.llmTimeoutMs,
  });
  output.selectedSummaryModel = fastest.model;
  output.wroteConfig = true;
  output.writeReason = "fastest benchmark result";
} else if (args["write-config"]) {
  saveConfigPatch({
    summaryModel: output.selectedSummaryModel,
    llmTimeoutMs: output.llmTimeoutMs,
  });
  output.wroteConfig = true;
  output.writeReason = "selected model";
}

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`Config: ${output.configPath}`);
  console.log(`Selected summary model: ${output.selectedSummaryModel}`);
  console.log(`LLM timeout: ${output.llmTimeoutMs}ms`);
  if (output.codexDefaultModel) console.log(`Codex default model: ${output.codexDefaultModel}`);
  if (output.availableModels.length) {
    console.log(`Available models: ${output.availableModels.join(", ")}`);
  }
  if (output.benchmark.length) {
    console.log("Benchmark:");
    for (const item of output.benchmark) {
      const transports = unique(item.attempts.map((attempt) => attempt.transport)).join("/");
      const retries = item.attempts.reduce((sum, attempt) => sum + attempt.transportRetries, 0);
      const timeoutStages = unique(item.attempts.map((attempt) => attempt.timeoutStage)).join("/");
      const status = item.ok
        ? `${item.successes}/${item.runs} ok, avg ${item.avgMs}ms, min ${item.minMs}ms, max ${item.maxMs}ms`
        : `0/${item.runs} ok`;
      const diagnostics = [
        transports ? `transport ${transports}` : "",
        `retries ${retries}`,
        timeoutStages ? `timeout stage ${timeoutStages}` : "",
      ].filter(Boolean).join(", ");
      console.log(`  ${item.model}: ${status}; ${diagnostics}`);
    }
    if (output.fastestSummaryModel) console.log(`Fastest summary model: ${output.fastestSummaryModel}`);
  }
  if (output.catalogError) console.log(`Model catalog warning: ${output.catalogError}`);
  if (output.wroteConfig) console.log(`Wrote summary model config (${output.writeReason}).`);
}
