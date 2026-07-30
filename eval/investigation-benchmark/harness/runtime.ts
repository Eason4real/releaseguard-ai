import { MemoryAnalyticsStore } from "../../../lib/fixtures/android-730";
import { runAgentLoop } from "../../../lib/investigation/agent-loop";
import type { InvestigationPlanner, PlannerContext } from "../../../lib/investigation/planner";
import { startInvestigation } from "../../../lib/investigation/runtime";
import { getActiveHypotheses, getPendingEvidence } from
  "../../../lib/investigation/hypothesis-invariants";
import { LiveEvalStore } from "../../support/live-eval-store";
import type { HarnessAgentRequest } from "./types";

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

export async function executeHarnessAgentRuntime(request: HarnessAgentRequest) {
  const analytics = await seedAnalytics(request);
  const store = new LiveEvalStore(analytics);
  const runId = await startInvestigation(store, {
    question: request.agentInput.incidentQuestion,
    provider: "HARNESS_PROVIDER",
    model: "android-7.3.0-fixture",
    incidentId: request.agentInput.incidentId,
    riskEventId: request.agentInput.riskEvent?.id ?? null,
    releaseId: request.agentInput.release?.id ?? null,
  });
  const aggregate = await runAgentLoop(store, {
    runId,
    planner: new HarnessRuntimePlanner(),
    analytics,
    maxIterations: 8,
    maxToolCalls: 2,
  });
  if (!aggregate) throw new Error("HARNESS_RUNTIME_RESULT_MISSING");
  return aggregate;
}
