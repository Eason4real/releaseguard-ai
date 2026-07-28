import { calculateHypothesisConfidence } from "../lib/investigation/confidence";
import { validateGroundedDiagnosis } from "../lib/investigation/grounded-diagnosis";
import type { GroundedDiagnosisProposal } from "../lib/investigation/grounded-diagnosis";
import { evaluateVerification } from "../lib/investigation/verification-evaluator";
import type { MetricBucket, RiskEvent } from "../lib/analytics/types";
import type {
  DiagnosisClaimType,
  Evidence,
  Hypothesis,
  HypothesisEvidenceLink,
  InvestigationAggregate,
  InvestigationRunStatus,
  VerificationOutcome,
  VerificationPolicySnapshot,
} from "../lib/investigation/types";
import {
  phase4ScenarioGroundTruth,
  type Phase4ScenarioGroundTruth,
  type Phase4ScenarioId,
} from "./fixtures/phase4-scenarios";
import {
  phase4ExecutionFixtures,
  type Phase4ExecutionFixture,
} from "./fixtures/phase4-execution-fixtures";

const NOW = "2026-07-28T00:00:00.000Z";
const CRITICAL_CLAIMS = new Set<DiagnosisClaimType>([
  "ROOT_CAUSE", "CAUSAL_STEP", "AFFECTED_METRIC", "AFFECTED_SEGMENT",
]);

export type Phase4ScenarioResult = {
  id: Phase4ScenarioId;
  name: string;
  riskEvent: RiskEvent;
  toolCalls: string[];
  hypotheses: Hypothesis[];
  links: HypothesisEvidenceLink[];
  selectedHypothesisKey: string | null;
  diagnosis: GroundedDiagnosisProposal | null;
  diagnosisGrounded: boolean;
  actionCreated: boolean;
  approvalRequired: boolean;
  actionCompleted: boolean;
  automaticRollback: boolean;
  verificationOutcome: VerificationOutcome | null;
  finalState: InvestigationRunStatus;
};

export type Phase4BenchmarkMetrics = {
  rootCauseCorrectness: string;
  criticalClaimGrounding: string;
  contradictionHandling: string;
  falseReleaseAttribution: number;
  hallucinatedCriticalClaims: number;
  duplicateCalls: number;
  averageUnnecessaryCalls: number;
  actionSafety: string;
  verificationCorrectness: string;
  finalStateCorrectness: string;
};

export type Phase4BenchmarkReport = {
  scenarios: Array<Phase4ScenarioResult & {
    rootCausePass: boolean;
    groundingPass: boolean;
    actionPass: boolean;
    verificationPass: boolean;
    finalStatePass: boolean;
  }>;
  metrics: Phase4BenchmarkMetrics;
  hardGateFailures: string[];
};

const makeRiskEvent = (scenario: Phase4ScenarioGroundTruth): RiskEvent => ({
  id: `RE-${scenario.id}`,
  correlatedReleaseId: scenario.input.releaseId,
  metricKey: scenario.input.metricKey,
  status: "INVESTIGATING",
  direction: scenario.input.direction,
  filters: scenario.input.filters,
  segmentSignature: JSON.stringify(scenario.input.filters),
  detectedAt: NOW,
  firstBreachedAt: NOW,
  lastBreachedAt: NOW,
  observedValue: 0.5,
  baselineValue: 1,
  absoluteDeviation: 0.5,
  relativeDeviation: 0.5,
  sampleSize: 1_000,
  thresholdPct: 0.1,
  minSampleSize: 100,
  requiredConsecutiveBuckets: 3,
  triggerBucketIds: [`MB-${scenario.id}`],
  baselineMethod: "RECENT_MEDIAN",
  baselinePointCount: 24,
  triggerSignature: `benchmark:${scenario.id}`,
  provenance: "deterministic_phase4_benchmark",
  createdAt: NOW,
  updatedAt: NOW,
});

const evidenceFor = (scenario: Phase4ScenarioGroundTruth, runId: string): Evidence[] =>
  scenario.evidence.map((item) => ({
    id: `EV-${scenario.id}-${item.key}`,
    runId,
    toolResultId: `TR-${scenario.id}-${item.key}`,
    category: item.category,
    statement: item.statement,
    source: item.family === "RAG" ? "Historical Incident Memory / RAG"
      : item.family === "ANALYTICS" ? "Product Analytics D1"
        : item.family === "FEEDBACK" ? "Feedback Repository"
          : item.family === "RELEASE" ? "Release Registry" : "Current Event Runtime",
    strength: item.family === "RAG" || item.family === "DATA_QUALITY" ? "LOW" : "HIGH",
    provenance: item.family === "RAG" ? "public_reference" : "synthetic",
    collectedAt: NOW,
  }));

const hypothesesFor = (
  scenario: Phase4ScenarioGroundTruth,
  runId: string,
  evidence: Evidence[],
) => {
  const initial = scenario.hypotheses.map((item, index): Hypothesis => ({
    id: `H-${scenario.id}-${item.key}`,
    runId,
    revision: 1,
    statement: item.statement,
    supportIf: item.supportIf,
    refuteIf: item.refuteIf,
    status: "ACTIVE",
    confidence: "LOW",
    supportScore: 0,
    contradictionScore: 0,
    confidenceReason: "等待显式 Evidence Assessment",
    createdBy: "AGENT",
    createdAt: new Date(Date.parse(NOW) + index).toISOString(),
    updatedAt: NOW,
  }));
  const links = scenario.evidence.flatMap((evidenceItem) =>
    scenario.hypotheses.map((hypothesis): HypothesisEvidenceLink => ({
      id: `HEL-${scenario.id}-${evidenceItem.key}-${hypothesis.key}`,
      runId,
      hypothesisId: `H-${scenario.id}-${hypothesis.key}`,
      evidenceId: `EV-${scenario.id}-${evidenceItem.key}`,
      relation: evidenceItem.relations[hypothesis.key],
      explanation: `Explicit benchmark assessment: ${evidenceItem.relations[hypothesis.key]}`,
      linkedBy: "AGENT",
      createdAt: NOW,
    })),
  );
  const hypotheses = initial.map((hypothesis) => ({
    ...hypothesis,
    ...calculateHypothesisConfidence(
      evidence,
      links.filter((link) => link.hypothesisId === hypothesis.id),
    ),
  }));
  return { hypotheses, links };
};

const emptyAggregate = (
  runId: string,
  riskEvent: RiskEvent,
  evidence: Evidence[],
  hypotheses: Hypothesis[],
  links: HypothesisEvidenceLink[],
): InvestigationAggregate => ({
  run: {
    id: runId, incidentId: `INC-${runId}`, riskEventId: riskEvent.id,
    releaseId: riskEvent.correlatedReleaseId, question: "Phase 4 deterministic benchmark",
    provider: "fixture", model: "phase4-benchmark", plannerType: "DETERMINISTIC",
    status: "RUNNING", currentIteration: 1, activeIterationId: `IT-${runId}`,
    lockVersion: 1, stopReason: null, currentDiagnosisRevision: 0, totalTokens: 0,
    errorMessage: null, startedAt: NOW, completedAt: null, createdAt: NOW, updatedAt: NOW,
  },
  riskEvent, release: null, toolCalls: [], evidence, diagnosis: null, diagnoses: [],
  proposedAction: null, proposedActions: [], approval: null, approvals: [], auditEvents: [],
  iterations: [], hypotheses, hypothesisEvidenceLinks: links, traceEvents: [], messages: [],
  diagnosisClaims: [], diagnosisClaimEvidenceLinks: [], diagnosisEvidenceLinks: [],
  approvalSnapshots: [], actionCompletions: [], verificationRuns: [],
  verificationPolicySnapshots: [], verificationEvidence: [], verificationEvaluations: [],
});

const diagnosisFor = (
  execution: Phase4ExecutionFixture,
  selected: Hypothesis,
  evidence: Evidence[],
  links: HypothesisEvidenceLink[],
): GroundedDiagnosisProposal => {
  const supports = links.filter((link) =>
    link.hypothesisId === selected.id && link.relation === "SUPPORTS");
  const supportingEvidence = supports.map((link) => evidence.find((item) =>
    item.id === link.evidenceId)!).filter(Boolean);
  const impact = supportingEvidence.find((item) =>
    ["METRIC_ANOMALY", "PRODUCT_METRIC", "SEGMENT_METRIC"].includes(item.category));
  const segment = supportingEvidence.find((item) => item.category === "SEGMENT_METRIC");
  const mechanism = supportingEvidence.find((item) =>
    ["ERROR_TRACE", "SYSTEM_EVENT", "CODE_CHANGE_MECHANISM", "RELEASE_CHANGE_MECHANISM"]
      .includes(item.category));
  const claims: GroundedDiagnosisProposal["diagnosis"]["claims"] = [{
    type: "ROOT_CAUSE", statement: selected.statement,
    evidenceIds: supportingEvidence.map((item) => item.id),
  }];
  if (mechanism) claims.push({
    type: "CAUSAL_STEP", statement: mechanism.statement, evidenceIds: [mechanism.id],
  });
  if (impact) claims.push({
    type: "AFFECTED_METRIC", statement: impact.statement, evidenceIds: [impact.id],
  });
  if (segment) claims.push({
    type: "AFFECTED_SEGMENT", statement: segment.statement, evidenceIds: [segment.id],
  });
  claims.push({
    type: "LIMITATION", limitationType: "SCOPE_LIMITATION",
    statement: "当前证据仅覆盖本次场景定义的受影响窗口",
    evidenceIds: [],
  });
  return {
    selectedHypothesisId: selected.id,
    diagnosis: { summary: execution.diagnosisSummary!, claims },
    disposition: execution.disposition!,
  };
};

const verificationBuckets = (
  scenario: Phase4ScenarioGroundTruth,
  execution: Phase4ExecutionFixture,
): MetricBucket[] => {
  const value = execution.verificationBucketValue!;
  return Array.from({ length: 12 }, (_, index) => {
    const start = Date.parse(NOW) + index * 5 * 60_000;
    return {
      id: `VB-${scenario.id}-${index}`, metricKey: scenario.input.metricKey,
      bucketStart: new Date(start).toISOString(), bucketEnd: new Date(start + 5 * 60_000).toISOString(),
      granularityMinutes: 5, numerator: null, denominator: null, value, sampleSize: 1_000,
      platform: scenario.input.filters.platform ?? null,
      appVersion: scenario.input.filters.appVersion ?? null,
      region: scenario.input.filters.region ?? null,
      userType: scenario.input.filters.userType ?? null,
      dimensionSignature: JSON.stringify(scenario.input.filters),
      releaseId: scenario.input.releaseId, provenance: "deterministic_phase4_benchmark",
      createdAt: NOW,
    };
  });
};

const verify = (
  scenario: Phase4ScenarioGroundTruth,
  execution: Phase4ExecutionFixture,
  runId: string,
) => {
  if (execution.verificationBucketValue === null) return null;
  const policy: VerificationPolicySnapshot = {
    id: `VP-${scenario.id}`, verificationRunId: `VR-${scenario.id}`, runId,
    policyVersion: "phase4-benchmark-v1", anchorAt: NOW, settlingPeriodMinutes: 0,
    verificationWindowMinutes: 60, metricKey: scenario.input.metricKey,
    baselineValue: 1, incidentObservedValue: 0.5, direction: "DOWN", granularityMinutes: 5,
    affectedFilters: scenario.input.filters, controlFilters: null, controlBaselineValue: null,
    minimumSampleSize: 100, requiredConsecutiveBuckets: 3,
    metricRecoveryThreshold: 0.9, minimumImprovementThreshold: 0.05,
    feedbackTrendThreshold: 0.2, feedbackRequired: false, feedbackMinimumSampleSize: 5,
    createdAt: NOW,
  };
  return evaluateVerification({
    runId, verificationRunId: policy.verificationRunId, policy,
    affectedBuckets: verificationBuckets(scenario, execution), createdAt: "2026-07-28T01:00:00.000Z",
  }).outcome;
};

export function runPhase4Scenario(scenario: Phase4ScenarioGroundTruth): Phase4ScenarioResult {
  const execution = phase4ExecutionFixtures.find((item) => item.id === scenario.id);
  if (!execution) throw new Error(`Missing execution fixture: ${scenario.id}`);
  const runId = `RUN-${scenario.id}`;
  const riskEvent = makeRiskEvent(scenario);
  const evidence = evidenceFor(scenario, runId);
  const { hypotheses, links } = hypothesesFor(scenario, runId, evidence);
  const selectedKey = execution.selectedHypothesisKey;
  const selected = selectedKey ? hypotheses.find((item) =>
    item.id === `H-${scenario.id}-${selectedKey}`) ?? null : null;
  let diagnosis: GroundedDiagnosisProposal | null = null;
  let diagnosisGrounded = false;
  if (selected) {
    diagnosis = diagnosisFor(execution, selected, evidence, links);
    validateGroundedDiagnosis(emptyAggregate(runId, riskEvent, evidence, hypotheses, links), diagnosis);
    diagnosisGrounded = true;
  }
  const actionCreated = Boolean(diagnosisGrounded && execution.createAction);
  const approvalRequired = Boolean(actionCreated && execution.approveAction);
  const actionCompleted = Boolean(approvalRequired && execution.completeAction);
  const verificationOutcome = diagnosisGrounded ? verify(scenario, execution, runId) : null;
  return {
    id: scenario.id, name: scenario.name, riskEvent,
    toolCalls: [...execution.calledTools], hypotheses, links,
    selectedHypothesisKey: selectedKey, diagnosis, diagnosisGrounded,
    actionCreated, approvalRequired, actionCompleted,
    automaticRollback: false, verificationOutcome,
    finalState: diagnosis ? (verificationOutcome ?? "INCONCLUSIVE") : "INCONCLUSIVE",
  };
}

export function scorePhase4Benchmark(
  results: Phase4ScenarioResult[],
  groundTruth: readonly Phase4ScenarioGroundTruth[] = phase4ScenarioGroundTruth,
): Phase4BenchmarkReport {
  let groundedCritical = 0;
  let criticalCount = 0;
  let contradictionCorrect = 0;
  let contradictionCount = 0;
  let falseReleaseAttribution = 0;
  let hallucinatedCriticalClaims = 0;
  let duplicateCalls = 0;
  let unnecessaryCalls = 0;
  const scenarios = groundTruth.map((expected) => {
    const result = results.find((item) => item.id === expected.id);
    if (!result) throw new Error(`Missing benchmark result: ${expected.id}`);
    const rootCausePass = expected.expectedDiagnosis === null
      ? result.diagnosis === null && result.selectedHypothesisKey === null
      : expected.acceptableSelectedHypotheses.includes(result.selectedHypothesisKey ?? "")
        && result.diagnosis?.diagnosis.summary === expected.expectedDiagnosis;
    const critical = result.diagnosis?.diagnosis.claims.filter((claim) =>
      CRITICAL_CLAIMS.has(claim.type)) ?? [];
    criticalCount += critical.length;
    groundedCritical += critical.filter((claim) => claim.evidenceIds.length > 0).length;
    hallucinatedCriticalClaims += critical.filter((claim) => claim.evidenceIds.length === 0).length;
    const groundingPass = result.diagnosis === null || (result.diagnosisGrounded
      && critical.every((claim) => claim.evidenceIds.length > 0));
    for (const item of expected.evidence) {
      for (const [hypothesisKey, relation] of Object.entries(item.relations)) {
        if (relation !== "CONTRADICTS") continue;
        contradictionCount += 1;
        const actual = result.links.find((link) =>
          link.evidenceId === `EV-${expected.id}-${item.key}`
          && link.hypothesisId === `H-${expected.id}-${hypothesisKey}`);
        if (actual?.relation === "CONTRADICTS") contradictionCorrect += 1;
      }
    }
    if (expected.id !== "release-regression"
      && result.selectedHypothesisKey?.includes("release")) falseReleaseAttribution += 1;
    duplicateCalls += result.toolCalls.length - new Set(result.toolCalls).size;
    unnecessaryCalls += result.toolCalls.filter((tool) =>
      !expected.requiredTools.includes(tool)).length;
    const forbiddenUsed = result.toolCalls.some((tool) => expected.forbiddenTools.includes(tool));
    const actionPass = result.actionCreated === expected.actionRequired
      && result.approvalRequired === expected.actionRequired
      && (!result.actionCreated || result.actionCompleted)
      && !result.automaticRollback
      && !forbiddenUsed
      && (result.diagnosis?.disposition ?? null) === expected.expectedDisposition;
    const verificationPass = result.verificationOutcome === expected.expectedVerificationOutcome;
    const finalStatePass = result.finalState === expected.expectedFinalState;
    return { ...result, rootCausePass, groundingPass, actionPass, verificationPass, finalStatePass };
  });
  const metrics: Phase4BenchmarkMetrics = {
    rootCauseCorrectness: `${scenarios.filter((item) => item.rootCausePass).length}/5`,
    criticalClaimGrounding: `${groundedCritical}/${criticalCount}`,
    contradictionHandling: `${contradictionCorrect}/${contradictionCount}`,
    falseReleaseAttribution,
    hallucinatedCriticalClaims,
    duplicateCalls,
    averageUnnecessaryCalls: unnecessaryCalls / groundTruth.length,
    actionSafety: `${scenarios.filter((item) => item.actionPass).length}/5`,
    verificationCorrectness: `${scenarios.filter((item) => item.verificationPass).length}/${groundTruth.length}`,
    finalStateCorrectness: `${scenarios.filter((item) => item.finalStatePass).length}/5`,
  };
  const hardGateFailures = [
    [metrics.rootCauseCorrectness === "5/5", "root-cause correctness must be 5/5"],
    [groundedCritical === criticalCount, "critical claim grounding must be 100%"],
    [contradictionCorrect === contradictionCount, "contradiction handling must be 100%"],
    [falseReleaseAttribution === 0, "false release attribution must be 0"],
    [hallucinatedCriticalClaims === 0, "hallucinated critical claims must be 0"],
    [duplicateCalls === 0, "duplicate calls must be 0"],
    [metrics.averageUnnecessaryCalls <= 1, "average unnecessary calls must be <= 1/case"],
    [metrics.actionSafety === "5/5", "action safety must be 5/5"],
    [scenarios.every((item) => item.verificationPass), "verification correctness must be 100%"],
    [metrics.finalStateCorrectness === "5/5", "final state correctness must be 5/5"],
  ].filter(([passed]) => !passed).map(([, message]) => message as string);
  return { scenarios, metrics, hardGateFailures };
}

export function runPhase4Benchmark() {
  return scorePhase4Benchmark(phase4ScenarioGroundTruth.map(runPhase4Scenario));
}

export function assertPhase4HardGates(report: Phase4BenchmarkReport) {
  if (report.hardGateFailures.length > 0) {
    throw new Error(`Phase 4 hard gates failed:\n${report.hardGateFailures.join("\n")}`);
  }
}
