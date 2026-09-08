import { createToolSignature } from "./state";

export type EmptyResultReason =
  | "NO_DATA"
  | "UNSUPPORTED_QUERY"
  | "NO_MATCH"
  | "NO_INFORMATION_GAIN";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const compactRecord = (value: Record<string, unknown>) => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
);

const rename = (
  source: Record<string, unknown>,
  aliases: Record<string, string>,
) => {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const target = aliases[key] ?? key;
    if (!(target in normalized) || target === key) normalized[target] = value;
  }
  return normalized;
};

const normalizeText = (value: unknown) => typeof value === "string" ? value.trim() : value;

const normalizeIso = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value.trim();
};

const normalizeFilters = (value: unknown) => {
  const filters = rename(record(value), {
    app_version: "appVersion",
    user_type: "userType",
  });
  return compactRecord(Object.fromEntries(Object.entries(filters).map(([key, item]) => [
    key,
    normalizeText(item),
  ])));
};

const normalizeDimension = (value: unknown) => {
  if (typeof value !== "string") return value;
  const canonical = value.trim().toLowerCase().replaceAll("-", "_");
  const aliases: Record<string, string> = {
    appversion: "app_version",
    usertype: "user_type",
  };
  return aliases[canonical] ?? canonical;
};

export function normalizeInvestigationToolArguments(
  toolName: string,
  input: Record<string, unknown>,
) {
  const common = rename(input, toolName === "query_metric" || toolName === "segment_metric"
    ? {
        metric: "metric_key",
        metricKey: "metric_key",
        startTime: "start_time",
        endTime: "end_time",
        granularityMinutes: "granularity_minutes",
        includeBaseline: "include_baseline",
      }
    : toolName === "search_user_feedback"
      ? {
          start_time: "startTime",
          end_time: "endTime",
          appVersion: "version",
          app_version: "version",
          user_type: "userType",
        }
      : toolName === "search_similar_incidents"
        ? {
            metric_key: "metricKey",
            appVersion: "version",
            app_version: "version",
            user_type: "userType",
          }
        : toolName === "get_release"
          ? { releaseId: "release_id" }
          : {});

  if ("filters" in common) common.filters = normalizeFilters(common.filters);
  for (const key of ["start_time", "end_time", "startTime", "endTime"]) {
    if (key in common) common[key] = normalizeIso(common[key]);
  }
  if ("dimension" in common) common.dimension = normalizeDimension(common.dimension);
  for (const [key, value] of Object.entries(common)) {
    if (key !== "filters") common[key] = normalizeText(value);
  }
  return compactRecord(common);
}

export const createSemanticToolSignature = (
  toolName: string,
  input: Record<string, unknown>,
) => createToolSignature(toolName, normalizeInvestigationToolArguments(toolName, input));

export function emptyResultReason(output: unknown): EmptyResultReason | null {
  const value = record(output);
  const candidate = value.empty_reason ?? value.reason_code ?? value.reason;
  return typeof candidate === "string" && [
    "NO_DATA",
    "UNSUPPORTED_QUERY",
    "NO_MATCH",
    "NO_INFORMATION_GAIN",
  ].includes(candidate) ? candidate as EmptyResultReason : null;
}
