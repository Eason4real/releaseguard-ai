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
import type { HarnessAgentRequest } from "./types";

type ObservedToolDecision = {
  iteration: number;
  toolName: string;
  arguments: Record<string, unknown>;
  fingerprint: string;
};

const fingerprint = (signature: string) =>
  createHash("sha256").update(signature).digest("hex");

const observePlanner = (
  planner: InvestigationPlanner,
  observedTools: ObservedToolDecision[],
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
) => {
  const observability = store.getObservability(runId);
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

const fixtureToolExecutor = (request: HarnessAgentRequest): InvestigationToolExecutor => {
  const remaining = [...request.observations];
  return async (name) => {
    const index = remaining.findIndex((item) => item.toolName === name);
    if (index < 0) {
      return {
        status: "EMPTY",
        output: { data: null, reason: "FIXTURE_OBSERVATION_UNAVAILABLE" },
        errorMessage: null,
        retryable: false,
      };
    }
    const [observation] = remaining.splice(index, 1);
    return {
      status: observation.status,
      output: structuredClone(observation.output),
      errorMessage: observation.status === "ERROR" ? "FIXTURE_TOOL_ERROR" : null,
      retryable: false,
      evidence: observation.status === "SUCCESS" ? [{
        category: "FIXTURE_OBSERVATION",
        statement: `The read-only ${name} tool returned a current investigation observation.`,
        source: "Benchmark Fixture",
        strength: "MEDIUM",
        provenance: "synthetic",
      }] : [],
    };
  };
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
    onObservability?: (observability: LiveEvalObservability) => void;
  } = {},
) {
  const analytics = await seedAnalytics(request);
  const store = new LiveEvalStore(analytics);
  const observedTools: ObservedToolDecision[] = [];
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
      planner: observePlanner(options.planner ?? new HarnessRuntimePlanner(), observedTools),
      analytics,
      maxIterations: options.maxIterations ?? 8,
      maxToolCalls: options.maxToolCalls ?? 2,
      toolExecutor: fixtureToolExecutor(request),
    });
  } catch (error) {
    const failedAggregate = await store.getAggregate(runId);
    const observability = runtimeObservability(store, runId, failedAggregate, observedTools);
    options.onObservability?.(observability);
    throw new HarnessRuntimeExecutionError(error, failedAggregate, observability);
  }
  if (!aggregate) throw new Error("HARNESS_RUNTIME_RESULT_MISSING");
  options.onObservability?.(runtimeObservability(store, runId, aggregate, observedTools));
  return aggregate;
}
