import { createHash } from "node:crypto";
import { MemoryAnalyticsStore } from "../../../lib/fixtures/android-730";
import { runAgentLoop } from "../../../lib/investigation/agent-loop";
import type {
  InvestigationDecision,
  InvestigationPlanner,
  PlannerContext,
} from "../../../lib/investigation/planner";
import { createToolSignature } from "../../../lib/investigation/state";
import {
  startInvestigation,
  type InvestigationToolExecutor,
} from "../../../lib/investigation/runtime";
import { getActiveHypotheses, getPendingEvidence } from
  "../../../lib/investigation/hypothesis-invariants";
import { LiveEvalStore, type LiveEvalObservability } from "../../support/live-eval-store";
import {
  bindFixtureExecutionRecords,
  createFixtureExecutionRecord,
  fixtureQueryShapeHints,
  fixtureToolCapabilities,
  observationMatchesSelector,
  productionEvidenceCategory,
  selectorFromToolArguments,
} from "./fixture-adapter";
import { normalizeInvestigationToolArguments } from
  "../../../lib/investigation/tool-query-policy";
import type { HarnessAgentRequest, HarnessFixtureExecutionRecord } from "./types";

type ObservedToolDecision = {
  iteration: number;
  toolName: string;
  arguments: Record<string, unknown>;
  fingerprint: string;
};

type ObservedStopDecision = NonNullable<LiveEvalObservability["plannerStopDecision"]>;

const fingerprint = (signature: string) =>
  createHash("sha256").update(signature).digest("hex");

const observePlanner = (
  planner: InvestigationPlanner,
  observedTools: ObservedToolDecision[],
  observedStop: { decision: ObservedStopDecision | null },
): InvestigationPlanner => ({
  type: planner.type,
  async plan(context): Promise<InvestigationDecision> {
    const decision = await planner.plan(context);
    if (decision.type === "CALL_TOOL") {
      observedTools.push({
        iteration: context.aggregate.run.currentIteration,
        toolName: decision.toolName,
        arguments: structuredClone(decision.arguments),
        fingerprint: fingerprint(createToolSignature(decision.toolName, decision.arguments)),
      });
    } else if (decision.type === "STOP_INCONCLUSIVE") {
      observedStop.decision = {
        iteration: context.aggregate.run.currentIteration,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        rationale: decision.rationale,
      };
    }
    return decision;
  },
  drainModelCallObservations: () => planner.drainModelCallObservations?.() ?? [],
  drainDecisionValidationObservations: () =>
    planner.drainDecisionValidationObservations?.() ?? [],
});

const runtimeObservability = (
  store: LiveEvalStore,
  runId: string,
  aggregate: Awaited<ReturnType<LiveEvalStore["getAggregate"]>>,
  observedTools: ObservedToolDecision[],
  observedStop: ObservedStopDecision | null,
) => {
  const observability = store.getObservability(runId);
  observability.plannerStopDecision = observedStop;
  if (aggregate?.run.stopReason !== "DUPLICATE_TOOL_CALL") return observability;
  const proposed = observedTools.at(-1) ?? null;
  const duplicate = proposed ? aggregate.toolCalls.find((call) =>
    call.proposedActionId === null
    && fingerprint(call.canonicalSignature) === proposed.fingerprint) ?? null : null;
  observability.guardEvents.push({
    eventType: "DUPLICATE_TOOL_CALL",
    iteration: proposed?.iteration ?? null,
    proposedToolName: proposed?.toolName ?? null,
    proposedArguments: proposed ? structuredClone(proposed.arguments) : null,
    proposedFingerprint: proposed?.fingerprint ?? null,
    duplicateOfToolCallId: duplicate?.id ?? null,
    duplicateOfFingerprint: duplicate ? fingerprint(duplicate.canonicalSignature) : null,
    resolution: "REJECTED_AND_STOPPED_INCONCLUSIVE",
  });
  return observability;
};

export class HarnessRuntimeExecutionError extends Error {
  readonly name = "HarnessRuntimeExecutionError";
  constructor(
    readonly runtimeCause: unknown,
    readonly aggregate: Awaited<ReturnType<LiveEvalStore["getAggregate"]>>,
    readonly observability: LiveEvalObservability,
  ) {
    super(runtimeCause instanceof Error ? runtimeCause.message : String(runtimeCause));
  }
}

class HarnessRuntimePlanner implements InvestigationPlanner {
  readonly type = "DETERMINISTIC" as const;

  async plan(context: PlannerContext) {
    const aggregate = context.aggregate;
    const hypotheses = getActiveHypotheses(aggregate);
    if (aggregate.hypotheses.length === 0) {
      return {
        type: "CREATE_HYPOTHESES" as const,
        hypotheses: [{
          statement: "The available incident observations may be insufficient for a reliable root cause.",
          supportIf: "Read-only investigation tools leave material causal ambiguity.",
          refuteIf: "Current-incident observations establish one grounded causal explanation.",
        }],
        rationale: "Create one case-agnostic hypothesis for deterministic harness execution.",
      };
    }
    const pending = getPendingEvidence(aggregate);
    if (pending.length > 0) {
      return {
        type: "ASSESS_EVIDENCE" as const,
        assessments: pending.map((evidence) => ({
          evidenceId: evidence.id,
          relations: hypotheses.map((hypothesis) => ({
            targetHypothesisId: hypothesis.id,
            relation: "NEUTRAL" as const,
            explanation: "Harness execution records the observation without deriving an answer label.",
          })),
        })),
        rationale: "Assess every new runtime Evidence without case-specific answer logic.",
      };
    }

    const calls = aggregate.toolCalls.filter((call) => call.proposedActionId === null);
    const targetHypothesisIds = hypotheses.map((item) => item.id);
    if (calls.length === 0 && aggregate.release) {
      return {
        type: "CALL_TOOL" as const,
        toolName: "get_release",
        arguments: { release_id: aggregate.release.id },
        targetHypothesisIds,
        testIntent: "SUPPORT" as const,
        rationale: "Execute the existing release-context tool through the shared AgentLoop.",
      };
    }
    if (calls.every((call) => call.name !== "query_metric") && aggregate.riskEvent) {
      return {
        type: "CALL_TOOL" as const,
        toolName: "query_metric",
        arguments: {
          metric_key: aggregate.riskEvent.metricKey,
          start_time: aggregate.riskEvent.firstBreachedAt,
          end_time: aggregate.riskEvent.lastBreachedAt,
          filters: aggregate.riskEvent.filters,
          granularity_minutes: 5,
          include_baseline: true,
        },
        targetHypothesisIds,
        testIntent: "SUPPORT" as const,
        rationale: "Execute the existing metric tool through the shared AgentLoop.",
      };
    }
    return {
      type: "STOP_INCONCLUSIVE" as const,
      reasonCode: "INSUFFICIENT_EVIDENCE" as const,
      reason: "The deterministic harness does not infer a case answer from fixture metadata.",
      rationale: "Stop after bounded read-only runtime execution without an answer oracle.",
    };
  }
}

const fixtureToolExecutor = (
  request: HarnessAgentRequest,
  includeQueryHints = false,
  classifyEmptyResults = false,
) => {
  const allObservations = request.observations.map((observation, index) => ({ observation, index }));
  const remaining = request.observations.map((observation, index) => ({ observation, index }));
  const records: HarnessFixtureExecutionRecord[] = [];
  const executor: InvestigationToolExecutor = async (name, args) => {
    const selector = selectorFromToolArguments(name, args);
    const index = remaining.findIndex(({ observation }) =>
      observationMatchesSelector(observation, name, selector));
    if (index < 0) {
      const enabled = request.enabledTools.includes(name);
      const allForTool = allObservations.filter(({ observation }) => observation.toolName === name);
      const remainingForTool = remaining.filter(({ observation }) => observation.toolName === name);
      const sameMetricRemaining = remainingForTool.filter(({ observation }) =>
        selector.metricKey !== undefined
        && observation.selector.metricKey !== undefined
        && observation.selector.metricKey.localeCompare(selector.metricKey, undefined, {
          sensitivity: "base",
        }) === 0);
      const emptyReason = !enabled
        ? "UNSUPPORTED_QUERY"
        : remainingForTool.length === 0 && allForTool.length > 0
          ? "NO_INFORMATION_GAIN"
          : remainingForTool.length === 0
            ? "NO_DATA"
            : selector.metricKey !== undefined && sameMetricRemaining.length === 0
              ? "UNSUPPORTED_QUERY"
              : "NO_MATCH";
      const output = {
        data: null,
        reason: includeQueryHints
          ? classifyEmptyResults ? emptyReason : "FIXTURE_QUERY_SHAPE_UNAVAILABLE"
          : "FIXTURE_OBSERVATION_UNAVAILABLE",
        ...(includeQueryHints && classifyEmptyResults ? { empty_reason: emptyReason } : {}),
        ...(includeQueryHints ? {
          query_shape_hints: fixtureQueryShapeHints(
            remaining.map((item) => item.observation), name, selector,
          ),
        } : {}),
      };
      records.push(createFixtureExecutionRecord(name, args, null, null, output));
      return {
        status: "EMPTY",
        output,
        errorMessage: null,
        retryable: false,
      };
    }
    const [{ observation, index: observationIndex }] = remaining.splice(index, 1);
    records.push(createFixtureExecutionRecord(
      name, args, observation, observationIndex, observation.output,
    ));
    const category = productionEvidenceCategory(name);
    return {
      status: observation.status,
      output: structuredClone(observation.output),
      errorMessage: observation.status === "ERROR" ? "FIXTURE_TOOL_ERROR" : null,
      retryable: false,
      evidence: observation.status === "SUCCESS" && category ? [{
        category,
        statement: `The read-only ${name} tool returned a current investigation observation.`,
        source: "Benchmark Fixture",
        strength: "MEDIUM",
        provenance: "synthetic",
      }] : [],
    };
  };
  return { executor, records };
};

const seedAnalytics = async (request: HarnessAgentRequest) => {
  const analytics = new MemoryAnalyticsStore();
  const { riskEvent, release } = request.agentInput;
  if (release) await analytics.upsertRelease(release);
  if (riskEvent) {
    await analytics.saveRiskEvent(riskEvent);
    const start = Date.parse(riskEvent.firstBreachedAt);
    const end = Date.parse(riskEvent.lastBreachedAt);
    const width = Math.max(60_000, Math.floor((end - start) / 3));
    await analytics.upsertMetricBuckets(Array.from({ length: 3 }, (_, index) => {
      const bucketStart = new Date(start + (index * width)).toISOString();
      const bucketEnd = new Date(Math.min(end, start + ((index + 1) * width))).toISOString();
      return {
        id: riskEvent.triggerBucketIds[index] ?? `MB-HARNESS-${index + 1}`,
        metricKey: riskEvent.metricKey,
        bucketStart,
        bucketEnd,
        granularityMinutes: Math.max(1, Math.round(width / 60_000)),
        numerator: null,
        denominator: null,
        value: riskEvent.observedValue,
        sampleSize: Math.max(1, Math.floor(riskEvent.sampleSize / 3)),
        platform: riskEvent.filters.platform ?? null,
        appVersion: riskEvent.filters.appVersion ?? null,
        region: riskEvent.filters.region ?? null,
        userType: riskEvent.filters.userType ?? null,
        dimensionSignature: riskEvent.segmentSignature,
        releaseId: release?.id ?? riskEvent.correlatedReleaseId,
        provenance: "deterministic_harness_runtime",
        createdAt: bucketStart,
      };
    }));
  }
  return analytics;
};

export async function executeHarnessAgentRuntime(
  request: HarnessAgentRequest,
  options: {
    planner?: InvestigationPlanner;
    provider?: string;
    model?: string;
    maxModelCalls?: number;
    maxIterations?: number;
    maxToolCalls?: number;
    includeFixtureQueryHints?: boolean;
    harnessVersion?: "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8";
    onObservability?: (observability: LiveEvalObservability) => void;
    onFixtureExecutions?: (records: HarnessFixtureExecutionRecord[]) => void;
  } = {},
) {
  const analytics = await seedAnalytics(request);
  const store = new LiveEvalStore(analytics);
  const observedTools: ObservedToolDecision[] = [];
  const observedStop = { decision: null as ObservedStopDecision | null };
  const v3 = ["V3", "V4", "V5", "V6", "V7", "V8"].includes(options.harnessVersion ?? "");
  const v4 = ["V4", "V5", "V6", "V7", "V8"].includes(options.harnessVersion ?? "");
  const fixtureExecution = fixtureToolExecutor(
    request,
    options.includeFixtureQueryHints,
    v3,
  );
  const runId = await startInvestigation(store, {
    question: request.agentInput.incidentQuestion,
    provider: options.provider ?? "HARNESS_PROVIDER",
    model: options.model ?? "android-7.3.0-fixture",
    incidentId: request.agentInput.incidentId,
    riskEventId: request.agentInput.riskEvent?.id ?? null,
    releaseId: request.agentInput.release?.id ?? null,
    maxModelCalls: options.maxModelCalls,
  });
  let aggregate;
  try {
    aggregate = await runAgentLoop(store, {
      runId,
      planner: observePlanner(options.planner ?? new HarnessRuntimePlanner(), observedTools, observedStop),
      analytics,
      maxIterations: options.maxIterations ?? 8,
      maxToolCalls: options.maxToolCalls ?? 2,
      toolExecutor: fixtureExecution.executor,
      ...(v3 ? {
        normalizeToolArguments: normalizeInvestigationToolArguments,
        maxConsecutiveNoEvidence: 4,
        maxNoEvidenceTotal: 4,
        runtimeGuidance: {
          policyVersion: options.harnessVersion === "V8" ? "HARNESS_V8" : options.harnessVersion === "V7" ? "HARNESS_V7" : options.harnessVersion === "V6" ? "HARNESS_V6" : options.harnessVersion === "V5" ? "HARNESS_V5" : v4 ? "HARNESS_V4" : "HARNESS_V3",
          toolCapabilities: fixtureToolCapabilities(request.observations, request.enabledTools),
          emptyResultProtocol: [
            "NO_DATA",
            "UNSUPPORTED_QUERY",
            "NO_MATCH",
            "NO_INFORMATION_GAIN",
          ],
          disclosure: "Schema names only; no observation values, Evidence IDs, Gold, or expected answers.",
          ...(v4 ? {
            evidencePacketProtocol: {
              phases: ["COLLECT", "SYNTHESIZE"],
              synthesisAllowsToolCalls: false,
              minimumCompetingHypotheses: 2,
              queryValueTaxonomy: ["DECISIVE", "DISCRIMINATING", "SUPPORTING", "REDUNDANT"],
              inconclusiveReasons: ["INSUFFICIENT_EVIDENCE", "CONFLICTING_EVIDENCE", "UNSUPPORTED_QUERY_SPACE", "BUDGET_EXHAUSTED", "MODEL_UNCERTAINTY"],
            },
          } : {}),
        },
      } : {}),
    });
  } catch (error) {
    const failedAggregate = await store.getAggregate(runId);
    bindFixtureExecutionRecords(failedAggregate, fixtureExecution.records);
    options.onFixtureExecutions?.(structuredClone(fixtureExecution.records));
    const observability = runtimeObservability(
      store, runId, failedAggregate, observedTools, observedStop.decision,
    );
    options.onObservability?.(observability);
    throw new HarnessRuntimeExecutionError(error, failedAggregate, observability);
  }
  if (!aggregate) throw new Error("HARNESS_RUNTIME_RESULT_MISSING");
  bindFixtureExecutionRecords(aggregate, fixtureExecution.records);
  options.onFixtureExecutions?.(structuredClone(fixtureExecution.records));
  options.onObservability?.(runtimeObservability(
    store, runId, aggregate, observedTools, observedStop.decision,
  ));
  return aggregate;
}
