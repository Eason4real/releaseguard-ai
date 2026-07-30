import assert from "node:assert/strict";
import test from "node:test";
import { loadInvestigationBenchmarkDevDataset } from
  "../eval/investigation-benchmark/dataset/dev";
import { rescoreFrozenBaselineReport } from
  "../eval/investigation-benchmark/harness/offline-rescore";
import { scoreInvestigationCase } from "../eval/investigation-benchmark/scorer";
import type {
  InvestigationBenchmarkCase,
  NormalizedInvestigationResult,
} from "../eval/investigation-benchmark/types";

const cases = new Map(loadInvestigationBenchmarkDevDataset().fixtures.map((fixture) =>
  [fixture.benchmarkCase.caseId, fixture.benchmarkCase]));

const prediction = (
  benchmarkCase: InvestigationBenchmarkCase,
  predictedRootCause: string,
  groundingStatus: "GROUNDED" | "UNGROUNDED" = "GROUNDED",
): NormalizedInvestigationResult => ({
  caseId: benchmarkCase.caseId,
  predictedRootCause,
  predictedRootCauseId: null,
  citedEvidenceIds: [],
  diagnosisClaims: [{
    claimId: `CLAIM-${benchmarkCase.caseId}`,
    type: "ROOT_CAUSE",
    statement: predictedRootCause,
    citedEvidenceIds: groundingStatus === "GROUNDED" ? ["EV-TEST"] : [],
    groundingStatus,
  }],
  modelCallCount: 1,
  toolCallCount: 0,
});

const score = (caseId: string, text: string, groundingStatus?: "GROUNDED" | "UNGROUNDED") => {
  const benchmarkCase = cases.get(caseId);
  assert.ok(benchmarkCase);
  return scoreInvestigationCase(benchmarkCase, prediction(benchmarkCase, text, groundingStatus));
};

test("CASE-206 accepts a more-specific semantic equivalent through the controlled rubric", () => {
  const result = score("CASE-206",
    "A change in ExperimentBinding incorrectly assigns NEW users to a control or off-target "
    + "experiment variant, causing irrelevant or default recommendations.");
  assert.equal(result.rootCause.correct, true);
  assert.equal(result.rootCause.matchedBy, "SEMANTIC_RUBRIC");
  assert.equal(result.rootCause.audit.predictedAnswerMode, "CAUSAL");
  assert.deepEqual(result.rootCause.audit.missingRequiredConcepts, []);
  assert.equal(result.rootCause.audit.specificityPolicyResult, "PASS");
});

test("CASE-219 rejects a grounded definite attribution that violates expected uncertainty", () => {
  const result = score("CASE-219",
    "The payment completion drop is caused by instability of an external payment provider, "
    + "unrelated to the release.", "GROUNDED");
  assert.equal(result.grounding.status, "EVALUABLE");
  assert.equal(result.rootCause.correct, false);
  assert.equal(result.rootCause.matchedBy, "NONE");
  assert.equal(result.rootCause.audit.expectedAnswerMode, "ABSTAIN");
  assert.equal(result.rootCause.audit.predictedAnswerMode, "CAUSAL");
  assert.equal(result.rootCause.audit.uncertaintyPolicyResult, "FAIL");
  assert.ok(result.rootCause.audit.forbiddenAssertions.includes("RELEASE_EXCLUDED"));
});

test("CASE-220 accepts a semantic abstention only because Ground Truth is ABSTAIN", () => {
  const result = score("CASE-220",
    "Insufficient evidence to determine a root cause from the available observations.");
  assert.equal(result.rootCause.correct, true);
  assert.equal(result.rootCause.matchedBy, "ABSTENTION");
  assert.equal(result.rootCause.audit.expectedAnswerMode, "ABSTAIN");
  assert.equal(result.rootCause.audit.predictedAnswerMode, "ABSTAIN");
});

test("generic insufficient evidence is incorrect for a CAUSAL case", () => {
  const result = score("CASE-206",
    "Insufficient evidence to determine a root cause from the available observations.");
  assert.equal(result.rootCause.correct, false);
  assert.equal(result.rootCause.audit.finalDecision, "INCORRECT");
  assert.equal(result.rootCause.audit.predictedAnswerMode, "ABSTAIN");
});

test("semantically adjacent text with a different core cause is incorrect", () => {
  const result = score("CASE-206",
    "Recommendation failures for new users were caused by a database lock, not experiment assignment.");
  assert.equal(result.rootCause.correct, false);
  assert.ok(result.rootCause.audit.forbiddenAssertions.includes("DATABASE_LOCK"));
});

test("missing reviewed concepts without a contradiction requires review instead of a false negative", () => {
  const result = score("CASE-206", "The recommendation rollout caused the incident.");
  assert.equal(result.rootCause.correct, null);
  assert.equal(result.rootCause.evaluationStatus, "REVIEW_REQUIRED");
  assert.equal(result.rootCause.matchedBy, "NONE");
  assert.ok(result.rootCause.audit.missingRequiredConcepts.length > 0);
});

test("offline rescore ignores legacy scores and evaluates only frozen normalized predictions", async () => {
  const dataset = loadInvestigationBenchmarkDevDataset();
  const sourceCases = dataset.fixtures.map((fixture) => ({
    caseId: fixture.benchmarkCase.caseId,
    normalizedPrediction: prediction(
      fixture.benchmarkCase,
      fixture.benchmarkCase.groundTruth.canonicalRootCause,
    ),
    scoring: { rootCause: { correct: false } },
  }));
  const report = await rescoreFrozenBaselineReport({
    manifest: {
      datasetId: "INVESTIGATION-BENCHMARK-DEV",
      datasetVersion: "0.1.0",
      datasetHash: "a".repeat(64),
      evaluationContractVersion: "phase1a-v1",
      sourceCommit: "source-commit",
      totalCases: 22,
      completedCases: 22,
      failedCases: 0,
    },
    cases: sourceCases,
    semanticHash: "b".repeat(64),
  }, "c".repeat(64));
  assert.equal(report.identity.scoringInput, "FROZEN_NORMALIZED_PREDICTION_ONLY");
  assert.equal(report.identity.evaluationContractVersion, "phase1a-v2");
  assert.equal(report.cases.length, 22);
  assert.equal(report.cases.find((item) => item.caseId === "CASE-206")
    ?.scoring.rootCause.correct, true);
  assert.match(report.semanticHash, /^[a-f0-9]{64}$/);
});
