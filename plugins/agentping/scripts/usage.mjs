export const USAGE_DETAIL_MODES = ["compact", "detailed"];

const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
];

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numberFrom(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function integerFrom(...values) {
  const numeric = numberFrom(...values);
  return numeric === null ? null : Math.round(numeric);
}

function stringFrom(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeUsageEntry(value, context = {}) {
  const raw = objectValue(value);
  const nested = objectValue(raw.usage);
  const source = Object.keys(nested).length > 0 ? { ...raw, ...nested } : raw;
  const details = objectValue(source.prompt_tokens_details || source.input_tokens_details);
  const outputDetails = objectValue(source.output_tokens_details || source.completion_tokens_details);
  const anthropicCached = integerFrom(source.cache_read_input_tokens, source.cacheReadInputTokens);
  const cachedInputTokens = integerFrom(
    source.cachedInputTokens,
    source.cached_input_tokens,
    details.cached_tokens,
    anthropicCached,
  );
  const cacheCreationInputTokens = integerFrom(
    source.cacheCreationInputTokens,
    source.cache_creation_input_tokens,
  );
  const rawInputTokens = integerFrom(
    source.inputTokens,
    source.input_tokens,
    source.promptTokens,
    source.prompt_tokens,
  );
  const hasAnthropicCacheFields = source.cache_read_input_tokens !== undefined ||
    source.cacheReadInputTokens !== undefined ||
    source.cache_creation_input_tokens !== undefined;
  const inputTokens = rawInputTokens === null
    ? (cachedInputTokens !== null || cacheCreationInputTokens !== null
      ? (cachedInputTokens || 0) + (cacheCreationInputTokens || 0)
      : null)
    : hasAnthropicCacheFields
      ? rawInputTokens + (anthropicCached || 0) + (cacheCreationInputTokens || 0)
      : rawInputTokens;
  const outputTokens = integerFrom(
    source.outputTokens,
    source.output_tokens,
    source.completionTokens,
    source.completion_tokens,
  );
  const reasoningTokens = integerFrom(
    source.reasoningTokens,
    source.reasoning_output_tokens,
    outputDetails.reasoning_tokens,
  );
  const computedTotal = inputTokens !== null || outputTokens !== null
    ? (inputTokens || 0) + (outputTokens || 0)
    : null;
  const totalTokens = integerFrom(source.totalTokens, source.total_tokens, computedTotal);
  const entry = {
    provider: stringFrom(source.provider, context.provider),
    model: stringFrom(source.model, context.model),
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
  const hasNumericValue = TOKEN_FIELDS.map((field) => entry[field]).some((item) => item !== null);
  return hasNumericValue || entry.model ? entry : null;
}

function mergeEntries(entries) {
  const grouped = new Map();
  for (const rawEntry of entries.filter(Boolean)) {
    const entry = normalizeUsageEntry(rawEntry, rawEntry);
    if (!entry) continue;
    const key = `${entry.provider}\n${entry.model}`;
    const current = grouped.get(key) || {
      provider: entry.provider,
      model: entry.model,
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    };
    for (const field of TOKEN_FIELDS) {
      if (entry[field] !== null) current[field] = (current[field] || 0) + entry[field];
    }
    grouped.set(key, current);
  }
  return Array.from(grouped.values());
}

function aggregateEntries(entries) {
  const aggregate = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, null]));
  for (const entry of entries) {
    for (const field of TOKEN_FIELDS) {
      if (entry[field] !== null) aggregate[field] = (aggregate[field] || 0) + entry[field];
    }
  }
  return aggregate;
}

export function normalizeUsage(value, context = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const entry = normalizeUsageEntry({}, context);
    return entry ? { ...aggregateEntries([entry]), breakdown: [entry] } : null;
  }
  const raw = objectValue(value);
  const suppliedBreakdown = Array.isArray(raw.breakdown)
    ? raw.breakdown
    : Array.isArray(raw.models)
      ? raw.models
      : [];
  const entries = suppliedBreakdown.length > 0
    ? mergeEntries(suppliedBreakdown.map((entry) => ({ ...objectValue(entry), provider: entry?.provider || context.provider })))
    : mergeEntries([normalizeUsageEntry(raw, context)]);
  if (entries.length === 0) return null;
  return {
    ...aggregateEntries(entries),
    breakdown: entries,
  };
}

export function mergeUsage(...values) {
  const entries = [];
  for (const value of values.flat()) {
    const normalized = normalizeUsage(value);
    if (normalized?.breakdown) entries.push(...normalized.breakdown);
  }
  if (entries.length === 0) return null;
  const breakdown = mergeEntries(entries);
  return { ...aggregateEntries(breakdown), breakdown };
}

export function usageDelta(currentValue, previousValue = null, fallbackValue = null, context = {}) {
  const current = normalizeUsage(currentValue, context);
  const previous = previousValue && typeof previousValue === "object"
    ? normalizeUsage(previousValue, context)
    : null;
  if (current && previous && current.breakdown.length === 1 && previous.breakdown.length === 1) {
    const currentEntry = current.breakdown[0];
    const previousEntry = previous.breakdown[0];
    const delta = { provider: context.provider, model: context.model };
    let valid = true;
    for (const field of TOKEN_FIELDS) {
      if (currentEntry[field] === null || previousEntry[field] === null) continue;
      if (currentEntry[field] < previousEntry[field]) {
        valid = false;
        break;
      }
      delta[field] = currentEntry[field] - previousEntry[field];
    }
    if (valid) return normalizeUsage(delta, context);
  }
  return normalizeUsage(fallbackValue, context);
}

export function normalizeUsageDetail(value, fallback = "compact") {
  const mode = String(value || fallback).trim().toLowerCase();
  return USAGE_DETAIL_MODES.includes(mode) ? mode : fallback;
}

export function formatTokenCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return "";
  if (numeric < 1000) return String(Math.round(numeric));
  if (numeric < 1_000_000) return `${(numeric / 1000).toFixed(numeric < 10_000 ? 1 : 0)}k`;
  return `${(numeric / 1_000_000).toFixed(numeric < 10_000_000 ? 1 : 0)}M`;
}

function usageLine(entry, options) {
  const detail = normalizeUsageDetail(options.usageDetail);
  const parts = [];
  const modelLabel = entry.model || entry.provider || "未知模型";
  parts.push(`\`${modelLabel.replace(/`/g, "")}\``);
  if (entry.inputTokens !== null) {
    const cacheParts = [];
    if ((entry.cachedInputTokens || 0) > 0) cacheParts.push(`缓存 ${formatTokenCount(entry.cachedInputTokens)}`);
    if ((entry.cacheCreationInputTokens || 0) > 0 && detail === "detailed") {
      cacheParts.push(`缓存写入 ${formatTokenCount(entry.cacheCreationInputTokens)}`);
    }
    parts.push(`输入 ${formatTokenCount(entry.inputTokens)}${cacheParts.length ? ` (${cacheParts.join(", ")})` : ""}`);
  }
  if (entry.outputTokens !== null) parts.push(`输出 ${formatTokenCount(entry.outputTokens)}`);
  if (detail === "detailed" && (entry.reasoningTokens || 0) > 0) {
    parts.push(`推理 ${formatTokenCount(entry.reasoningTokens)}`);
  }
  return parts.join(" · ");
}

export function formatUsageFooter(value, options = {}) {
  if (options.usageFooter === false) return "";
  const usage = normalizeUsage(value, { model: options.model, provider: options.provider });
  if (!usage?.breakdown?.length) return "";
  const lines = usage.breakdown.map((entry) => usageLine(entry, options)).filter(Boolean);
  if (lines.length === 0) return "";
  if (lines.length === 1) return `***\n\n**运行信息**: ${lines[0]}`;
  return ["***", "", "**运行信息**:", "", lines.join("\n\n")].join("\n");
}

export function usageLogMeta(value) {
  const usage = normalizeUsage(value);
  if (!usage) return { usageModels: 0 };
  return {
    usageModels: usage.breakdown.length,
    usageInputTokens: usage.inputTokens,
    usageCachedInputTokens: usage.cachedInputTokens,
    usageOutputTokens: usage.outputTokens,
    usageReasoningTokens: usage.reasoningTokens,
    usageTotalTokens: usage.totalTokens,
  };
}
