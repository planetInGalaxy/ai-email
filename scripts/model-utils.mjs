import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SUMMARY_MODEL = "gpt-5.4-mini";
export const DEFAULT_LLM_TIMEOUT_MS = 16_000;
export const SUMMARY_MODEL_CANDIDATES = [
  DEFAULT_SUMMARY_MODEL,
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.4-mini",
  "gpt-5.4",
];

export function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

export function readCodexDefaultModel(configFile = codexConfigPath()) {
  try {
    const contents = fs.readFileSync(configFile, "utf8");
    const match = contents.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function flattenModelCatalog(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => {
    if (Array.isArray(item)) return item;
    if (item && typeof item === "object") return flattenModelCatalog(item);
    return [];
  });
}

function modelId(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.id || item.name || item.model || item.slug || "";
}

export function listCodexModels() {
  const result = spawnSync("codex", ["debug", "models"], {
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      AGENTPING_DISABLE_LLM_SUMMARY: "1",
      CODEX_PUSHDEER_DISABLE_LLM_SUMMARY: "1",
    },
  });

  if (result.status !== 0) {
    return {
      ok: false,
      models: [],
      error: (result.stderr || result.stdout || "").trim(),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const models = Array.from(new Set(flattenModelCatalog(parsed).map(modelId).filter(Boolean)));
    return { ok: true, models, error: "" };
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: `Failed to parse codex debug models output: ${error.message}`,
    };
  }
}

export function chooseSummaryModel({
  preferredModel = "",
  fallbackModel = DEFAULT_SUMMARY_MODEL,
  configFile = codexConfigPath(),
} = {}) {
  const catalog = listCodexModels();
  const codexDefaultModel = readCodexDefaultModel(configFile);
  const candidates = [
    preferredModel,
    ...SUMMARY_MODEL_CANDIDATES,
    codexDefaultModel,
    fallbackModel,
  ].filter(Boolean);

  if (!catalog.ok || catalog.models.length === 0) {
    return {
      model: preferredModel || codexDefaultModel || fallbackModel,
      source: catalog.ok ? "fallback" : "fallback-catalog-error",
      availableModels: catalog.models,
      catalogError: catalog.error,
      codexDefaultModel,
    };
  }

  const selected = candidates.find((candidate) => catalog.models.includes(candidate)) || catalog.models[0];
  return {
    model: selected,
    source: catalog.models.includes(preferredModel) ? "preferred" : "auto",
    availableModels: catalog.models,
    catalogError: "",
    codexDefaultModel,
  };
}
