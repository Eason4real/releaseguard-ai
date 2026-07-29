import type { AuditEvent } from "./types";

export type PlannerUsageCompleteness = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export type PlannerUsageSummary = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  completeness: PlannerUsageCompleteness;
  modelCallCount: number;
  usageObservedCallCount: number;
  source: "MODEL_CALL_OBSERVATIONS" | "LEGACY_REPAIR_AUDIT" | "NONE";
};

type SafeUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const usageFromEvent = (event: AuditEvent): SafeUsage | null => {
  const candidate = event.details.usage;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const usage = candidate as Record<string, unknown>;
  return {
    promptTokens: tokenCount(usage.promptTokens),
    completionTokens: tokenCount(usage.completionTokens),
    totalTokens: tokenCount(usage.totalTokens),
  };
};

const sumKnown = (values: Array<number | null>) => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
};

export function summarizePlannerUsage(events: AuditEvent[]): PlannerUsageSummary {
  const modelCalls = events.filter((event) => event.type === "PLANNER_MODEL_CALL_OBSERVED");
  const legacyRepairCalls = modelCalls.length === 0
    ? events.filter((event) => [
        "PLANNER_DECISION_REPAIR_ATTEMPTED",
        "PLANNER_DECISION_REPAIRED",
        "PLANNER_DECISION_REPAIR_FAILED",
      ].includes(event.type))
    : [];
  const calls = modelCalls.length > 0 ? modelCalls : legacyRepairCalls;
  const source = modelCalls.length > 0
    ? "MODEL_CALL_OBSERVATIONS"
    : legacyRepairCalls.length > 0
      ? "LEGACY_REPAIR_AUDIT"
      : "NONE";
  const usages = calls.map(usageFromEvent);
  const usageObservedCallCount = usages.filter((usage) => usage && Object.values(usage)
    .some((value) => value !== null)).length;
  const complete = source === "MODEL_CALL_OBSERVATIONS"
    && calls.length > 0
    && usages.every((usage) => usage !== null && Object.values(usage)
      .every((value) => value !== null));
  const hasKnownUsage = usageObservedCallCount > 0;

  return {
    inputTokens: sumKnown(usages.map((usage) => usage?.promptTokens ?? null)),
    outputTokens: sumKnown(usages.map((usage) => usage?.completionTokens ?? null)),
    totalTokens: sumKnown(usages.map((usage) => usage?.totalTokens ?? null)),
    completeness: complete ? "COMPLETE" : hasKnownUsage ? "PARTIAL" : "UNAVAILABLE",
    modelCallCount: calls.length,
    usageObservedCallCount,
    source,
  };
}
