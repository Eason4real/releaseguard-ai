import { LLMInvestigationPlanner } from "../lib/investigation/llm-planner";
import type { InvestigationAggregate } from "../lib/investigation/types";
import { phase4ScenarioGroundTruth } from "./fixtures/phase4-scenarios";

const config = {
  provider: new URL(process.env.LIVE_EVAL_BASE_URL!).host,
  baseUrl: process.env.LIVE_EVAL_BASE_URL!,
  model: process.env.LIVE_EVAL_MODEL!,
  apiKey: process.env.LIVE_EVAL_API_KEY!,
};

const planner = new LLMInvestigationPlanner(config);
const emptyAggregate = (scenario: (typeof phase4ScenarioGroundTruth)[number]): InvestigationAggregate => {
  const now = new Date().toISOString();
  const runId = `LIVE-EVAL-${scenario.id}`;
  return {
    run: {
      id: runId, incidentId: `INC-${scenario.id}`, riskEventId: `RE-${scenario.id}`,
      releaseId: scenario.input.releaseId, question: scenario.input.triggerSummary,
      provider: config.provider, model: config.model, plannerType: "LLM", status: "RUNNING",
      currentIteration: 1, activeIterationId: null, lockVersion: 0, stopReason: null,
      currentDiagnosisRevision: 0, totalTokens: 0, errorMessage: null, startedAt: now,
      completedAt: null, createdAt: now, updatedAt: now,
    },
    riskEvent: {
      id: `RE-${scenario.id}`, correlatedReleaseId: scenario.input.releaseId,
      metricKey: scenario.input.metricKey, status: "INVESTIGATING",
      direction: scenario.input.direction, filters: scenario.input.filters,
      segmentSignature: JSON.stringify(scenario.input.filters), detectedAt: now,
      firstBreachedAt: now, lastBreachedAt: now, observedValue: 0.5, baselineValue: 1,
      absoluteDeviation: 0.5, relativeDeviation: 0.5, sampleSize: 1_000,
      thresholdPct: 0.1, minSampleSize: 100, requiredConsecutiveBuckets: 3,
      triggerBucketIds: [`MB-${scenario.id}`], baselineMethod: "RECENT_MEDIAN",
      baselinePointCount: 24, triggerSignature: `live-eval:${scenario.id}`,
      provenance: "live_eval_input", createdAt: now, updatedAt: now,
    },
    release: null, toolCalls: [], evidence: [], diagnosis: null, diagnoses: [],
    proposedAction: null, proposedActions: [], approval: null, approvals: [], auditEvents: [],
    iterations: [], hypotheses: [], hypothesisEvidenceLinks: [], traceEvents: [], messages: [],
    diagnosisClaims: [], diagnosisClaimEvidenceLinks: [], diagnosisEvidenceLinks: [],
    approvalSnapshots: [], actionCompletions: [], verificationRuns: [],
    verificationPolicySnapshots: [], verificationEvidence: [], verificationEvaluations: [],
  };
};

const reports = [];
for (const scenario of phase4ScenarioGroundTruth) {
  const started = Date.now();
  try {
    const decision = await planner.plan({
      aggregate: emptyAggregate(scenario), trigger: "INITIAL", humanMessage: null,
      remainingIterations: 16, remainingToolCalls: 12,
    });
    reports.push({
      provider: config.provider, model: config.model, scenario: scenario.id,
      latencyMs: Date.now() - started, decisionType: decision.type,
      hypothesisTrajectory: decision.type === "CREATE_HYPOTHESES"
        ? decision.hypotheses.map((item) => item.statement) : [],
      toolCalls: decision.type === "CALL_TOOL" ? [decision.toolName] : [],
      selectedHypothesis: decision.type === "FINALIZE" ? decision.selectedHypothesisId : null,
      grounding: decision.type === "FINALIZE" ? "SERVER_VALIDATION_REQUIRED" : "NOT_APPLICABLE",
      action: decision.type === "FINALIZE" ? decision.disposition : null,
      finalState: null,
      pass: decision.type === "CREATE_HYPOTHESES",
      reason: decision.type === "CREATE_HYPOTHESES"
        ? "Valid competing-hypothesis opening decision"
        : `Expected CREATE_HYPOTHESES for an empty Run, received ${decision.type}`,
    });
  } catch (error) {
    reports.push({
      provider: config.provider, model: config.model, scenario: scenario.id,
      latencyMs: Date.now() - started, pass: false,
      reason: error instanceof Error ? error.message : "Unknown live eval error",
    });
  }
}

console.log(JSON.stringify({
  eval: "Phase 4 live LLM structural probe",
  blocking: false,
  fallback: false,
  note: "Expected answers are never supplied to LLMInvestigationPlanner. Deterministic CI remains authoritative.",
  reports,
}, null, 2));
