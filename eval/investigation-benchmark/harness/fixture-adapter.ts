import { createToolSignature } from "../../../lib/investigation/state";
import type { ToolArgs } from "../../../lib/investigation/tools";
import type { InvestigationAggregate } from "../../../lib/investigation/types";
import type {
  HarnessFixtureExecutionRecord,
  HarnessObservationSelector,
  HarnessProductionEvidenceCategory,
  HarnessToolObservation,
} from "./types";

const CATEGORY_BY_TOOL = {
  get_release: "RELEASE_CHANGE",
  query_metric: "PRODUCT_METRIC",
  segment_metric: "SEGMENT_METRIC",
  search_user_feedback: "USER_FEEDBACK",
  search_similar_incidents: "SIMILAR_INCIDENT",
} as const satisfies Record<string, HarnessProductionEvidenceCategory>;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown) => typeof value === "string" && value.trim()
  ? value.trim()
  : undefined;

const equal = (left: string | undefined, right: string | undefined) =>
  left !== undefined && right !== undefined
  && left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;

const scopeFields = ["platform", "version", "region", "userType"] as const;

const compatibleScope = (
  expected: HarnessObservationSelector,
  actual: HarnessObservationSelector,
) => scopeFields.every((field) =>
  expected[field] === undefined || actual[field] === undefined
  || equal(expected[field], actual[field]));

const compatibleRetrievalScope = (
  expected: HarnessObservationSelector,
  actual: HarnessObservationSelector,
) => {
  const comparable = (["metricKey", ...scopeFields] as const).filter((field) =>
    expected[field] !== undefined && actual[field] !== undefined);
  return comparable.length > 0
    && comparable.every((field) => equal(expected[field], actual[field]));
};

export const productionEvidenceCategory = (
  toolName: string,
): HarnessProductionEvidenceCategory | null =>
  CATEGORY_BY_TOOL[toolName as keyof typeof CATEGORY_BY_TOOL] ?? null;

export function selectorFromToolArguments(
  toolName: string,
  args: ToolArgs,
): HarnessObservationSelector {
  const filters = record(args.filters);
  const scope = {
    platform: text(args.platform) ?? text(filters.platform),
    version: text(args.version) ?? text(filters.appVersion),
    region: text(args.region) ?? text(filters.region),
    userType: text(args.userType) ?? text(filters.userType),
  };
  if (toolName === "get_release") return { releaseId: text(args.release_id) };
  if (toolName === "query_metric") {
    return { metricKey: text(args.metric_key), ...scope };
  }
  if (toolName === "segment_metric") {
    return { metricKey: text(args.metric_key), dimension: text(args.dimension), ...scope };
  }
  return { metricKey: text(args.metricKey), ...scope };
}

export function projectObservationSelector(input: {
  toolName: string;
  output: unknown;
  metricKey: string | null;
  filters: Record<string, string>;
  releaseId: string | null;
  releaseVersion: string | null;
}): HarnessObservationSelector {
  const output = record(input.output);
  const data = record(output.data);
  const query = record(output.query);
  const dimension = text(data.dimension) ?? text(query.dimension);
  const scope: HarnessObservationSelector = {
    platform: text(query.platform) ?? text(input.filters.platform),
    version: text(query.version) ?? text(query.appVersion) ?? text(input.filters.appVersion),
    region: text(query.region) ?? text(input.filters.region),
    userType: text(query.userType) ?? text(input.filters.userType),
  };
  if (input.toolName === "get_release") {
    return { releaseId: text(data.id) ?? input.releaseId ?? undefined };
  }
  if (input.toolName === "query_metric") {
    return {
      metricKey: text(data.metric) ?? text(query.metric_key) ?? input.metricKey ?? undefined,
      ...scope,
    };
  }
  if (input.toolName === "segment_metric") {
    const selector = {
      metricKey: text(data.metric) ?? text(query.metric_key) ?? input.metricKey ?? undefined,
      dimension,
      ...scope,
    };
    if (dimension === "platform") delete selector.platform;
    if (dimension === "app_version") delete selector.version;
    if (dimension === "region") delete selector.region;
    if (dimension === "user_type") delete selector.userType;
    return selector;
  }
  return {
    metricKey: input.metricKey ?? undefined,
    ...scope,
    version: scope.version ?? input.releaseVersion ?? undefined,
  };
}

export function observationMatchesSelector(
  observation: HarnessToolObservation,
  toolName: string,
  selector: HarnessObservationSelector,
) {
  if (observation.toolName !== toolName) return false;
  const expected = observation.selector;
  if (toolName === "get_release") {
    return equal(expected.releaseId, selector.releaseId);
  }
  if (toolName === "query_metric") {
    return equal(expected.metricKey, selector.metricKey)
      && compatibleScope(expected, selector);
  }
  if (toolName === "segment_metric") {
    return equal(expected.metricKey, selector.metricKey)
      && equal(expected.dimension, selector.dimension)
      && compatibleScope(expected, selector);
  }
  if (toolName === "search_user_feedback" || toolName === "search_similar_incidents") {
    return compatibleRetrievalScope(expected, selector);
  }
  return false;
}

export const createFixtureExecutionRecord = (
  toolName: string,
  args: ToolArgs,
  observation: HarnessToolObservation | null,
  observationIndex: number | null,
  output: unknown,
): HarnessFixtureExecutionRecord => ({
  matched: observation !== null,
  matchedObservationId: observationIndex === null
    ? null
    : `HARNESS-OBS-${String(observationIndex + 1).padStart(3, "0")}`,
  benchmarkEvidenceId: observation?.evidenceId ?? null,
  category: observation ? productionEvidenceCategory(toolName) : null,
  selector: observation ? structuredClone(observation.selector) : selectorFromToolArguments(toolName, args),
  output: structuredClone(output),
  toolName,
  toolSignature: createToolSignature(toolName, args),
  toolCallId: null,
  toolResultId: null,
});

export function bindFixtureExecutionRecords(
  aggregate: InvestigationAggregate | null,
  records: HarnessFixtureExecutionRecord[],
) {
  if (!aggregate) return;
  const unused = aggregate.toolCalls.filter((call) => call.proposedActionId === null);
  for (const execution of records) {
    const index = unused.findIndex((call) => call.canonicalSignature === execution.toolSignature);
    if (index < 0) continue;
    const [call] = unused.splice(index, 1);
    execution.toolCallId = call.id;
    execution.toolResultId = call.resultId;
  }
}

export function benchmarkEvidenceMap(
  aggregate: InvestigationAggregate,
  records: readonly HarnessFixtureExecutionRecord[],
) {
  const mapped = new Map<string, string>();
  for (const execution of records) {
    if (!execution.matched || !execution.benchmarkEvidenceId || !execution.toolResultId) continue;
    for (const evidence of aggregate.evidence) {
      if (evidence.toolResultId === execution.toolResultId) {
        mapped.set(evidence.id, execution.benchmarkEvidenceId);
      }
    }
  }
  return mapped;
}
