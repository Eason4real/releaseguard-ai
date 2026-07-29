import type { AnalyticsStore, MetricQuery } from "../lib/analytics/store";
import type { MetricBucket, Release, RiskEvent } from "../lib/analytics/types";
import { runAgentLoop } from "../lib/investigation/agent-loop";
import { decideProposedAction, executeApprovedGithubAction } from "../lib/investigation/action-runtime";
import type { InvestigationDecision, InvestigationPlanner, PlannerContext } from "../lib/investigation/planner";
import { startInvestigation } from "../lib/investigation/runtime";
import type { InvestigationAggregate } from "../lib/investigation/types";
import type { ModelResponseObservation } from "../lib/investigation/model";
import { PlannerDecisionValidationError } from "../lib/investigation/llm-planner";
import { PlannerDecisionSemanticError } from
  "../lib/investigation/planner-decision-semantics";
import {
  confirmActionCompletion,
  createVerificationAttempt,
  evaluateVerificationAttempt,
} from "../lib/investigation/verification-runtime";
import type { FeedbackRetriever, IncidentRetriever } from "../lib/retrieval/types";
import type { LiveScenarioInput } from "./fixtures/phase4-scenario-inputs";
import { LiveEvalStore } from "./support/live-eval-store";

const NOW = "2026-07-28T00:00:00.000Z";
const createBuckets = (scenario: LiveScenarioInput): MetricBucket[] => scenario.metricSeries.map((item, index) => ({
  id: `MB-${scenario.id}-${index}`, metricKey: scenario.riskEvent.metricKey,
  bucketStart: new Date(Date.parse(NOW) + index * 300_000).toISOString(),
  bucketEnd: new Date(Date.parse(NOW) + (index + 1) * 300_000).toISOString(),
  granularityMinutes: 5, numerator: null, denominator: null, value: item.value,
  sampleSize: item.sampleSize, platform: item.platform ?? null, appVersion: item.appVersion ?? null,
  region: item.region ?? null, userType: item.userType ?? null,
  dimensionSignature: JSON.stringify(item), releaseId: scenario.riskEvent.releaseId,
  provenance: "live_eval_scenario_input", createdAt: NOW,
}));

class ScenarioAnalytics implements AnalyticsStore {
  private readonly riskEvents = new Map<string, RiskEvent>();
  private readonly releases = new Map<string, Release>();
  private buckets: MetricBucket[] = [];
  async upsertRelease(item: Release) { this.releases.set(item.id, structuredClone(item)); }
  async upsertMetricBuckets(items: MetricBucket[]) { this.buckets.push(...structuredClone(items)); }
  async saveRiskEvent(item: RiskEvent) { this.riskEvents.set(item.id, structuredClone(item)); return item; }
  async getRelease(id: string) { return structuredClone(this.releases.get(id) ?? null); }
  async getRiskEvent(id: string) { return structuredClone(this.riskEvents.get(id) ?? null); }
  async getRiskEventBySignature(signature: string) {
    return structuredClone([...this.riskEvents.values()].find((item) => item.triggerSignature === signature) ?? null);
  }
  async queryMetricBuckets(query: MetricQuery) {
    return structuredClone(this.buckets.filter((item) => item.metricKey === query.metricKey
      && Object.entries(query.filters ?? {}).every(([key, value]) =>
        item[key as keyof Pick<MetricBucket, "platform" | "appVersion" | "region" | "userType">] === value)));
  }
}

const makeRetrievers = (scenario: LiveScenarioInput): {
  feedbackRetriever: FeedbackRetriever; incidentRetriever: IncidentRetriever;
} => ({
  feedbackRetriever: {
    async search() {
      if (scenario.unavailableSources.includes("FEEDBACK")) throw new Error("SCENARIO_FEEDBACK_UNAVAILABLE");
      return scenario.feedback.map((content, index) => ({
        feedbackId: `FB-${scenario.id}-${index}`, timestamp: NOW,
        platform: scenario.riskEvent.filters.platform ?? "ALL", version: scenario.riskEvent.filters.appVersion ?? "ALL",
        region: scenario.riskEvent.filters.region ?? "ALL", userType: scenario.riskEvent.filters.userType ?? "ALL",
        content, tags: [scenario.riskEvent.metricKey], relevance: 1, matchedTerms: [],
        provenance: { source: "Live Eval Scenario Feedback", sourceReference: `eval://${scenario.id}/feedback/${index}` },
      }));
    },
  },
  incidentRetriever: {
    async search() {
      if (scenario.unavailableSources.includes("INCIDENTS")) throw new Error("SCENARIO_INCIDENTS_UNAVAILABLE");
      return scenario.historicalIncidents.map((chunk, index) => ({
        incidentId: `HIST-${scenario.id}-${index}`, title: "Historical incident", relevance: 1,
        chunk, metadata: {}, provenance: { source: "Live Eval Historical Memory", corpusVersion: "eval-v1",
          corpusType: "FIXTURE" as const }, sourceDocument: `eval://${scenario.id}/incident/${index}`,
        chunkId: `CH-${scenario.id}-${index}`, section: "summary",
        retrievalSignals: { lexicalRank: 1, lexicalScore: 1, vectorRank: null, vectorScore: null,
          metadataScore: 0, finalScore: 1, retrievalMode: "LEXICAL_DEGRADED" as const,
          embeddingModel: "live-eval-scenario" },
      }));
    },
  },
});

export type PlannerCallRecord = {
  sequence: number;
  latencyMs: number;
  decision: InvestigationDecision | null;
  error: string | null;
  hypotheses: Array<{ id: string; statement: string; status: string; confidence: string }>;
  evidence: Array<{ id: string; category: string; statement: string }>;
  evidenceRelations: Array<{
    evidenceId: string; hypothesisId: string; relation: string; explanation: string;
  }>;
  tokenUsage: ModelResponseObservation["usage"];
  tokenUsageStatus: "PROVIDED" | "NOT_PROVIDED";
  responseModel: string | null;
  modelCallCount: number;
  modelLatencyMs: number;
  decisionRepairAttempts: number;
};

export function attachModelObservations(
  calls: PlannerCallRecord[],
  observations: ModelResponseObservation[],
) {
  const groups: ModelResponseObservation[][] = [];
  observations.forEach((observation) => {
    if (observation.attemptIndex === undefined || observation.attemptIndex === 0 || groups.length === 0) {
      groups.push([observation]);
    } else {
      groups.at(-1)!.push(observation);
    }
  });
  calls.forEach((call, index) => {
    const group = groups[index] ?? [];
    const usages = group.map((item) => item.usage).filter((item) => item !== null);
    call.tokenUsage = usages.length === 0 ? null : {
      promptTokens: usages.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0),
      completionTokens: usages.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0),
      totalTokens: usages.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
    };
    call.tokenUsageStatus = call.tokenUsage ? "PROVIDED" : "NOT_PROVIDED";
    call.responseModel = group.at(-1)?.model ?? null;
    call.modelCallCount = group.length;
    call.modelLatencyMs = group.reduce((sum, item) => sum + item.latencyMs, 0);
    call.decisionRepairAttempts = Math.max(0, group.length - 1);
  });
  return calls;
}

class ObservedPlanner implements InvestigationPlanner {
  readonly type: InvestigationPlanner["type"];
  readonly calls: PlannerCallRecord[] = [];
  constructor(private readonly inner: InvestigationPlanner) { this.type = inner.type; }
  drainDecisionValidationObservations() {
    return this.inner.drainDecisionValidationObservations?.() ?? [];
  }
  drainModelCallObservations() {
    return this.inner.drainModelCallObservations?.() ?? [];
  }
  async plan(context: PlannerContext) {
    const started = performance.now();
    try {
      const decision = await this.inner.plan(context);
      this.calls.push({ sequence: this.calls.length + 1, latencyMs: performance.now() - started,
        decision: structuredClone(decision), error: null,
        hypotheses: context.aggregate.hypotheses.map(({ id, statement, status, confidence }) =>
          ({ id, statement, status, confidence })),
        evidence: context.aggregate.evidence.map(({ id, category, statement }) => ({ id, category, statement })),
        evidenceRelations: context.aggregate.hypothesisEvidenceLinks.map(({ evidenceId, hypothesisId,
          relation, explanation }) => ({ evidenceId, hypothesisId, relation, explanation })),
        tokenUsage: null, tokenUsageStatus: "NOT_PROVIDED", responseModel: null,
        modelCallCount: 0, modelLatencyMs: 0, decisionRepairAttempts: 0 });
      return decision;
    } catch (error) {
      this.calls.push({ sequence: this.calls.length + 1, latencyMs: performance.now() - started,
        decision: null, error: error instanceof Error ? error.message : "Unknown planner error",
        hypotheses: context.aggregate.hypotheses.map(({ id, statement, status, confidence }) =>
          ({ id, statement, status, confidence })),
        evidence: context.aggregate.evidence.map(({ id, category, statement }) => ({ id, category, statement })),
        evidenceRelations: context.aggregate.hypothesisEvidenceLinks.map(({ evidenceId, hypothesisId,
          relation, explanation }) => ({ evidenceId, hypothesisId, relation, explanation })),
        tokenUsage: null, tokenUsageStatus: "NOT_PROVIDED", responseModel: null,
        modelCallCount: 0, modelLatencyMs: 0, decisionRepairAttempts: 0 });
      throw error;
    }
  }
}

export type LiveScenarioRuntimeResult = {
  scenarioId: string;
  aggregate: InvestigationAggregate;
  plannerCalls: PlannerCallRecord[];
  totalLatencyMs: number;
  safeActionAdapterCalls: number;
  runtimeError: string | null;
  runtimeErrorCategory: "PLANNER_SCHEMA_ERROR" | "PLANNER_SEMANTIC_ERROR" | "RUNTIME_ERROR" | null;
};

export async function runLiveScenarioRuntime(
  scenario: LiveScenarioInput,
  planner: InvestigationPlanner,
): Promise<LiveScenarioRuntimeResult> {
  const analytics = new ScenarioAnalytics();
  const riskEventId = `RE-LIVE-${scenario.id}`;
  const riskEvent: RiskEvent = {
    id: riskEventId, correlatedReleaseId: scenario.riskEvent.releaseId,
    metricKey: scenario.riskEvent.metricKey, status: "INVESTIGATING", direction: scenario.riskEvent.direction,
    filters: scenario.riskEvent.filters, segmentSignature: JSON.stringify(scenario.riskEvent.filters),
    detectedAt: NOW, firstBreachedAt: NOW, lastBreachedAt: NOW,
    observedValue: scenario.riskEvent.observedValue, baselineValue: scenario.riskEvent.baselineValue,
    absoluteDeviation: Math.abs(scenario.riskEvent.observedValue - scenario.riskEvent.baselineValue),
    relativeDeviation: Math.abs(scenario.riskEvent.observedValue - scenario.riskEvent.baselineValue)
      / scenario.riskEvent.baselineValue,
    sampleSize: 1000, thresholdPct: 0.1, minSampleSize: 100, requiredConsecutiveBuckets: 3,
    triggerBucketIds: [`MB-${scenario.id}-0`], baselineMethod: "RECENT_MEDIAN", baselinePointCount: 24,
    triggerSignature: `live-eval:${scenario.id}`, provenance: "live_eval_scenario_input",
    createdAt: NOW, updatedAt: NOW,
  };
  await analytics.saveRiskEvent(riskEvent);
  if (scenario.release && scenario.riskEvent.releaseId) await analytics.upsertRelease({
    id: scenario.riskEvent.releaseId, version: scenario.release.version, platform: scenario.release.platform,
    releasedAt: NOW, rolloutStatus: "FULL", rolloutPercentage: 100, featureFlags: [],
    changedModules: scenario.release.changedModules, provenance: "live_eval_scenario_input", createdAt: NOW,
  });
  if (!scenario.unavailableSources.includes("METRICS")) await analytics.upsertMetricBuckets(createBuckets(scenario));
  const store = new LiveEvalStore(analytics);
  const runId = await startInvestigation(store, { question: scenario.riskEvent.triggerSummary,
    provider: "live-eval", model: "live-eval", incidentId: `INC-LIVE-${scenario.id}`,
    riskEventId, releaseId: scenario.riskEvent.releaseId });
  const observed = new ObservedPlanner(planner);
  const retrievers = makeRetrievers(scenario);
  let runtimeError: string | null = null;
  let runtimeErrorCategory: LiveScenarioRuntimeResult["runtimeErrorCategory"] = null;
  let safeActionAdapterCalls = 0;
  try {
    await runAgentLoop(store, { runId, planner: observed, analytics,
      feedbackRetriever: retrievers.feedbackRetriever, incidentRetriever: retrievers.incidentRetriever,
      maxIterations: 16, maxToolCalls: 10 });
    let aggregate = (await store.getAggregate(runId))!;
    if (aggregate.run.status === "WAITING_APPROVAL" && aggregate.proposedAction) {
      await decideProposedAction(store, { runId, proposedActionId: aggregate.proposedAction.id,
        decision: "APPROVE", reason: "Live eval simulated approval", targetOwner: "releaseguard-eval",
        targetRepo: "safe-no-network" });
      const fakeGithub: typeof fetch = async (_input, init) => {
        safeActionAdapterCalls += 1;
        return init?.method === "POST"
          ? Response.json({ number: 1, title: "Live eval issue",
            html_url: "https://github.com/releaseguard-eval/safe-no-network/issues/1",
            created_at: new Date().toISOString() }, { status: 201 })
          : Response.json([], { status: 200 });
      };
      await executeApprovedGithubAction(store, { runId, proposedActionId: aggregate.proposedAction.id,
        token: "live-eval-non-secret-token" }, fakeGithub);
      aggregate = (await store.getAggregate(runId))!;
    }
    if (aggregate.run.status === "WAITING_ACTION_COMPLETION") {
      const completedCall = aggregate.toolCalls.find((item) => item.proposedActionId !== null && item.completedAt);
      const requestedEffectiveAt = Date.parse(scenario.actionCompletion.effectiveAt);
      const minimumEffectiveAt = Date.parse(completedCall?.completedAt ?? scenario.actionCompletion.effectiveAt);
      if (requestedEffectiveAt < minimumEffectiveAt) {
        throw new Error("SCENARIO_ACTION_EFFECTIVE_AT_PRECEDES_ACTION");
      }
      await confirmActionCompletion(store, { runId, clientRequestId: `live-eval-completion-${scenario.id}`,
        effectiveAt: scenario.actionCompletion.effectiveAt,
        changeReference: scenario.actionCompletion.changeReference });
      aggregate = (await store.getAggregate(runId))!;
    }
    if (aggregate.run.status === "WAITING_VERIFICATION") {
      const anchor = aggregate.actionCompletions.at(-1)?.effectiveAt ?? aggregate.diagnosis!.createdAt;
      const verificationClock = () => new Date(Date.parse(anchor) + 3 * 60 * 60_000);
      const attempt = await createVerificationAttempt(store, {
        runId, clientRequestId: `live-eval-verification-${scenario.id}` }, verificationClock);
      store.verificationMetricBuckets = scenario.verification.metricValues.map((value, index) => ({
        id: `VB-${scenario.id}-${index}`, metricKey: scenario.riskEvent.metricKey,
        bucketStart: new Date(Date.parse(anchor) + (30 + index * 5) * 60_000).toISOString(),
        bucketEnd: new Date(Date.parse(anchor) + (35 + index * 5) * 60_000).toISOString(),
        granularityMinutes: 5, numerator: null, denominator: null, value,
        sampleSize: scenario.verification.sampleSize, platform: scenario.riskEvent.filters.platform ?? null,
        appVersion: scenario.riskEvent.filters.appVersion ?? null, region: scenario.riskEvent.filters.region ?? null,
        userType: scenario.riskEvent.filters.userType ?? null,
        dimensionSignature: JSON.stringify(scenario.riskEvent.filters), releaseId: scenario.riskEvent.releaseId,
        provenance: "live_eval_scenario_input", createdAt: NOW,
      }));
      await evaluateVerificationAttempt(store, { runId, verificationRunId: attempt.verificationRun.id,
        clientRequestId: `live-eval-evaluation-${scenario.id}` }, verificationClock);
    }
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : "Unknown runtime error";
    runtimeErrorCategory = error instanceof PlannerDecisionValidationError
      ? "PLANNER_SCHEMA_ERROR"
      : error instanceof PlannerDecisionSemanticError
        ? "PLANNER_SEMANTIC_ERROR"
        : "RUNTIME_ERROR";
  }
  const aggregate = (await store.getAggregate(runId))!;
  return { scenarioId: scenario.id, aggregate, plannerCalls: observed.calls,
    totalLatencyMs: observed.calls.reduce((sum, item) => sum + item.latencyMs, 0),
    safeActionAdapterCalls, runtimeError, runtimeErrorCategory };
}
