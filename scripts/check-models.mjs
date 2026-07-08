#!/usr/bin/env node
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SUMMARY_MODEL,
  configPath,
  loadConfig,
  saveConfigPatch,
} from "../plugins/agentping/scripts/pushdeer-lib.mjs";
import { chooseSummaryModel, listCodexModels } from "./model-utils.mjs";

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

const output = {
  configPath: configPath(),
  selectedSummaryModel: selection.model || DEFAULT_SUMMARY_MODEL,
  selectionSource: selection.source,
  configuredSummaryModel: current.summaryModel,
  codexDefaultModel: selection.codexDefaultModel,
  llmTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LLM_TIMEOUT_MS,
  availableModels: catalog.models,
  catalogError: catalog.ok ? "" : catalog.error,
};

if (args["write-config"]) {
  saveConfigPatch({
    summaryModel: output.selectedSummaryModel,
    llmTimeoutMs: output.llmTimeoutMs,
  });
  output.wroteConfig = true;
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
  if (output.catalogError) console.log(`Model catalog warning: ${output.catalogError}`);
  if (output.wroteConfig) console.log("Wrote summary model config.");
}
