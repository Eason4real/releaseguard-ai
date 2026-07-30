import assert from "node:assert/strict";
import test from "node:test";
import { createDeterministicFixtureProvider } from "../eval/investigation-benchmark/deterministic-provider";
import { deriveBenchmarkExecutionRequest } from "../eval/investigation-benchmark/execution-input";
import { normalizeInvestigationResult } from "../eval/investigation-benchmark/normalizer";
import { runInvestigationBenchmark } from "../eval/investigation-benchmark/runner";
import type {
  BenchmarkExecutionRequest,
  BenchmarkRawInvestigationResult,
  BenchmarkResultProvider,
  InvestigationBenchmarkCase,
} from "../eval/investigation-benchmark/types";

const makeCase = (caseId: string): InvestigationBenchmarkCase => ({
  caseId,
  title: `Phase 1B synthetic ${caseId}`,
  category: "release_regression",
  difficulty: "easy",
  input: {
    incidentId: `INC-${caseId.slice(-3)}`,
    question: "What caused the checkout incident?",
    riskEvent: null,
  },
  dataSources: [{
    sourceId: `SRC-${caseId.slice(-3)}`,
    kind: "analytics",
    fixtureRef: `fixture://SRC-${caseId.slice(-3)}`,
    evidenceIds: ["EV-001", "EV-002", "EV-003"],
  }],
  groundTruth: {
    rootCauseEvaluation: {
      expectedAnswerMode: "CAUSAL",
      requiredConceptGroups: [],
      optionalConcepts: [],
      forbiddenConcepts: [],
      uncertaintyPolicy: "NOT_APPLICABLE",
      specificityPolicy: "ALLOW_MORE_SPECIFIC_IF_CONSISTENT",
    },
    canonicalRootCauseId: "RC-PAYMENT-CALLBACK",
    canonicalRootCause: "The payment callback changed before the checkout confirmation was persisted.",
    acceptableAliases: ["Payment callback persistence race"],
    requiredEvidenceIds: ["EV-001"],
    supportingEvidenceIds: ["EV-001", "EV-002"],
    distractorEvidenceIds: ["EV-003"],
  },
});

const correctRaw: BenchmarkRawInvestigationResult = {
  caseId: "CASE-001",
  predictedRootCause: "The payment callback changed before the checkout confirmation was persisted.",
  predictedRootCauseId: "RC-PAYMENT-CALLBACK",
  citedEvidenceIds: ["EV-001", "EV-002"],
  diagnosisClaims: [
    {
      claimId: "CLAIM-A-ROOT",
      type: "ROOT_CAUSE",
      statement: "The payment callback changed before the checkout confirmation was persisted.",
      groundingStatus: "GROUNDED",
    },
    {
      claimId: "CLAIM-A-METRIC",
      type: "AFFECTED_METRIC",
      statement: "Checkout conversion declined.",
      groundingStatus: "GROUNDED",
    },
  ],
  diagnosisClaimEvidenceLinks: [
    { claimId: "CLAIM-A-ROOT", evidenceId: "EV-001" },
    { claimId: "CLAIM-A-METRIC", evidenceId: "EV-002" },
  ],
  modelCallCount: 3,
  toolCallCount: 4,
  tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, completeness: "COMPLETE" },
  durationMs: 250,
};

const noisyRaw: BenchmarkRawInvestigationResult = {
  caseId: "CASE-002",
  predictedRootCause: "A different dependency caused the incident.",
  predictedRootCauseId: "RC-WRONG",
  citedEvidenceIds: ["EV-001", "EV-003", "EV-003", "EV-999"],
  diagnosisClaims: [
    {
      claimId: "CLAIM-B-ROOT",
      type: "ROOT_CAUSE",
      statement: "A different dependency caused the incident.",
      groundingStatus: "UNGROUNDED",
      citedEvidenceIds: ["EV-003"],
    },
    {
      claimId: "CLAIM-B-METRIC",
      type: "AFFECTED_METRIC",
      statement: "Every region failed.",
      groundingStatus: "UNGROUNDED",
      citedEvidenceIds: ["EV-999"],
    },
  ],
  modelCallCount: 5,
  toolCallCount: 6,
};

const legacyRaw: BenchmarkRawInvestigationResult = {
  caseId: "CASE-003",
  predictedRootCause: "Payment callback persistence race",
  diagnosisClaims: [{
    claimId: "CLAIM-C-ROOT",
    type: "ROOT_CAUSE",
    statement: "Payment callback persistence race",
    groundingStatus: "GROUNDED",
  }],
  modelCallCount: 2,
  toolCallCount: 2,
};

test("Case A runs fixture through normalizer, scorer and aggregate", async () => {
  const report = await runInvestigationBenchmark(
    [makeCase("CASE-001")],
    createDeterministicFixtureProvider([correctRaw]),
  );
  assert.equal(report.cases[0].rootCause.correct, true);
  assert.equal(report.cases[0].evidence.precision, 1);
  assert.equal(report.cases[0].grounding.unsupportedClaimRate, 0);
  assert.deepEqual(report.aggregate, {
    totalCases: 1,
    rootCauseTop1Accuracy: 1,
    automaticallyEvaluatedCases: 1,
    correctCases: 1,
    incorrectCases: 0,
    reviewRequiredCases: 0,
    runtimeFailedCases: 0,
    autoEvaluationCoverage: 1,
    autoEvaluableAccuracy: 1,
    meanEvidencePrecision: 1,
    meanUnsupportedClaimRate: 0,
    medianModelCalls: 3,
    medianToolCalls: 4,
    tokenMetrics: {
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalTokens: 120,
      meanTotalTokens: 120,
    },
  });
});

test("Case B preserves noisy citations and unsupported claims for the scorer", async () => {
  const report = await runInvestigationBenchmark(
    [makeCase("CASE-002")],
    createDeterministicFixtureProvider([noisyRaw]),
  );
  assert.equal(report.cases[0].rootCause.correct, false);
  assert.equal(report.cases[0].evidence.precision, 1 / 3);
  assert.deepEqual(report.cases[0].evidence.duplicateEvidenceIds,
    ["EV-003", "EV-999"]);
  assert.deepEqual(report.cases[0].evidence.unknownEvidenceIds, ["EV-999"]);
  assert.equal(report.cases[0].grounding.unsupportedClaimRate, 1);
  assert.equal(report.cases[0].grounding.unsupportedClaims.length, 2);
});

test("Case C keeps alias matching and legacy grounding unavailable without fake telemetry", async () => {
  const normalized = normalizeInvestigationResult(legacyRaw);
  assert.equal(normalized.predictedRootCauseId, null);
  assert.equal(normalized.tokenUsage, undefined);
  assert.equal(normalized.durationMs, undefined);
  assert.equal(normalized.diagnosisClaims[0].groundingStatus, "LEGACY_UNVERIFIED");

  const report = await runInvestigationBenchmark(
    [makeCase("CASE-003")],
    createDeterministicFixtureProvider([legacyRaw]),
  );
  assert.equal(report.cases[0].rootCause.correct, true);
  assert.equal(report.cases[0].rootCause.matchedBy, "ALIAS");
  assert.equal(report.cases[0].grounding.status, "NOT_EVALUABLE");
  assert.equal(report.cases[0].grounding.unsupportedClaimRate, null);
  assert.equal(report.aggregate.meanUnsupportedClaimRate, null);
  assert.equal(report.aggregate.tokenMetrics, undefined);
});

test("provider receives a runtime execution object with no evaluation-plane fields", async () => {
  const capture: { request?: BenchmarkExecutionRequest } = {};
  const provider: BenchmarkResultProvider = {
    run(request) {
      capture.request = request;
      return correctRaw;
    },
  };
  const benchmarkCase = makeCase("CASE-001");
  await runInvestigationBenchmark([benchmarkCase], provider);

  const captured = capture.request;
  assert.ok(captured);
  assert.deepEqual(Object.keys(captured).sort(), ["agentInput", "executionKey"]);
  assert.equal(captured.executionKey, "CASE-001");
  assert.deepEqual(Object.keys(captured.agentInput).sort(),
    ["dataSources", "incidentId", "incidentQuestion", "riskEvent"]);
  assert.deepEqual(captured.agentInput.dataSources, [{
    kind: "analytics",
    sourceRef: "fixture://SRC-001",
  }]);
  assert.doesNotMatch(JSON.stringify(captured.agentInput),
    /CASE-001|release_regression|Phase 1B synthetic|easy/);
  const serialized = JSON.stringify(captured);
  for (const forbiddenField of [
    "groundTruth",
    "canonicalRootCauseId",
    "canonicalRootCause",
    "acceptableAliases",
    "requiredEvidenceIds",
    "supportingEvidenceIds",
    "distractorEvidenceIds",
    "rootCauseEvaluation",
    "requiredConceptGroups",
    "optionalConcepts",
    "forbiddenConcepts",
    "uncertaintyPolicy",
    "specificityPolicy",
    "expectedClaims",
    "expectedAnswer",
  ]) assert.doesNotMatch(serialized, new RegExp(`"${forbiddenField}"`));
});

test("execution input is a detached copy and deterministic provider only selects by opaque execution key", () => {
  const benchmarkCase = makeCase("CASE-001");
  const originalGroundTruth = structuredClone(benchmarkCase.groundTruth);
  const request = deriveBenchmarkExecutionRequest(benchmarkCase);
  request.agentInput.incidentQuestion = "Changed execution-plane question";
  request.agentInput.dataSources[0].sourceRef = "fixture://SRC-999";

  assert.deepEqual(benchmarkCase.groundTruth, originalGroundTruth);
  assert.equal(benchmarkCase.input.question, "What caused the checkout incident?");
  assert.equal(benchmarkCase.dataSources[0].fixtureRef, "fixture://SRC-001");

  const provider = createDeterministicFixtureProvider([correctRaw]);
  assert.equal(provider.run(request), correctRaw);
});

test("execution boundary rejects semantic benchmark identifiers", () => {
  const leakingCase = makeCase("CASE-001");
  leakingCase.dataSources[0].sourceId = "SRC-DATABASE-LOCK";
  leakingCase.dataSources[0].fixtureRef = "fixture://root-cause-db-lock.json";
  assert.throws(() => deriveBenchmarkExecutionRequest(leakingCase),
    /NON_OPAQUE_BENCHMARK_IDENTIFIER/);
});
