import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadInvestigationBenchmarkDevDataset } from
  "../eval/investigation-benchmark/dataset/dev";
import { rescoreFrozenBaselineReport } from
  "../eval/investigation-benchmark/harness/offline-rescore";
import { scoreInvestigationCase } from "../eval/investigation-benchmark/scorer";
import {
  detectPredictedAnswerMode,
  detectRootCauseConcepts,
} from "../eval/investigation-benchmark/root-cause-semantic-scorer";
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

test("explicit uncertainty overrides causal phrases inside unresolved alternatives", () => {
  const text = "Insufficient evidence to confirm a single root cause. The following unresolved "
    + "alternatives remain plausible, and the observations cannot distinguish among them: "
    + "(1) A client change is the root cause; (2) the decline results from a rollout; "
    + "(3) the incident was caused by a dependency.";
  assert.equal(detectPredictedAnswerMode(text), "ABSTAIN");
  const concepts = detectRootCauseConcepts(text);
  assert.ok(concepts.includes("EVIDENCE_INSUFFICIENT"));
  assert.ok(concepts.includes("ALTERNATIVES_UNRESOLVED"));
  assert.equal(concepts.includes("DEFINITE_CAUSAL_ATTRIBUTION"), false);
});

test("a true causal answer and a causal conclusion after a weak disclaimer remain causal", () => {
  assert.equal(detectPredictedAnswerMode(
    "The single root cause is a malformed client configuration.",
  ), "CAUSAL");
  assert.equal(detectPredictedAnswerMode(
    "The evidence is limited, but the single root cause is a malformed client configuration.",
  ), "CAUSAL");
  assert.equal(detectPredictedAnswerMode(
    "Insufficient evidence leaves unresolved alternatives that cannot be distinguished. "
      + "However, the definitive root cause is a malformed client configuration.",
  ), "CAUSAL");
});

test("release concepts recognize identifiers, client changes, rollout, deployment, and version changes", () => {
  for (const text of [
    "REL-777 release (MobileClient change) remains an alternative.",
    "A release change remains possible.",
    "The application rollout remains possible.",
    "The service deployment remains possible.",
    "A version change remains possible.",
    "REL-888 (SyntheticComponent change) remains possible.",
  ]) assert.ok(detectRootCauseConcepts(text).includes("CHECKOUT_RELEASE"), text);
});

test("semantic scorer implementation contains no case-specific release identifiers", async () => {
  const source = await readFile(
    "eval/investigation-benchmark/root-cause-semantic-scorer.ts",
    "utf8",
  );
  for (const forbidden of ["CASE-219", "REL-219", "CheckoutClient", "REL-777", "MobileClient"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("frozen CASE-219 offline projection scores as an explicit unresolved abstention", async (t) => {
  const artifactPath = "eval-results/investigation-benchmark/"
    + "post-harness-fix-case-219-run1.reprojected-c64c5c5.json";
  let validation;
  try {
    validation = JSON.parse(await readFile(artifactPath, "utf8")) as {
      originalPrediction: NormalizedInvestigationResult;
      projectedPrediction: NormalizedInvestigationResult;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("Local offline validation artifact is not present.");
      return;
    }
    throw error;
  }
  const benchmarkCase = cases.get("CASE-219");
  assert.ok(benchmarkCase);
  const before = scoreInvestigationCase(benchmarkCase, validation.originalPrediction);
  const after = scoreInvestigationCase(benchmarkCase, validation.projectedPrediction);
  assert.equal(before.rootCause.audit.predictedAnswerMode, "ABSTAIN");
  assert.deepEqual(before.rootCause.audit.missingRequiredConcepts, [
    "release-alternative", "provider-alternative", "alternatives-unresolved",
  ]);
  assert.equal(after.rootCause.audit.expectedAnswerMode, "ABSTAIN");
  assert.equal(after.rootCause.audit.predictedAnswerMode, "ABSTAIN");
  assert.deepEqual(after.rootCause.audit.missingRequiredConcepts, []);
  assert.ok(after.rootCause.audit.matchedConcepts.includes("CHECKOUT_RELEASE"));
  assert.ok(after.rootCause.audit.matchedConcepts.includes("PAYMENT_PROVIDER_INSTABILITY"));
  assert.ok(after.rootCause.audit.matchedConcepts.includes("ALTERNATIVES_UNRESOLVED"));
  assert.equal(after.rootCause.audit.uncertaintyPolicyResult, "PASS");
  assert.equal(after.rootCause.correct, true);
});

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
  const source = {
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
  };
  const report = await rescoreFrozenBaselineReport(source, "c".repeat(64));
  assert.equal(report.identity.scoringInput, "FROZEN_NORMALIZED_PREDICTION_ONLY");
  assert.equal(report.identity.evaluationContractVersion, "phase1a-v2");
  assert.equal(report.cases.length, 22);
  assert.equal(report.cases.find((item) => item.caseId === "CASE-206")
    ?.scoring.rootCause.correct, true);
  assert.match(report.semanticHash, /^[a-f0-9]{64}$/);

  const liveSource = {
    ...source,
    cases: source.cases.map((item) => item.caseId === "CASE-208" ? {
      ...item,
      execution: {
        status: "PASS" as const,
        terminalInvestigationState: "INCONCLUSIVE" as const,
        modelCallCount: item.normalizedPrediction.modelCallCount,
        toolCallCount: item.normalizedPrediction.toolCallCount,
        errorCategory: null,
      },
      telemetry: {
        plannerActions: ["STOP_INCONCLUSIVE"],
        plannerValidationEvents: [],
      } as never,
    } : item),
  };
  const liveReport = await rescoreFrozenBaselineReport(liveSource, "d".repeat(64));
  assert.equal(liveReport.schemaVersion, "investigation-live-benchmark-rescore-v1");
  assert.equal(liveReport.reportStatus, "COMPLETE");
  assert.equal(liveReport.cases.find((item) => item.caseId === "CASE-208")
    ?.execution.terminalInvestigationState, "INCONCLUSIVE");
  assert.deepEqual(liveReport.cases.find((item) => item.caseId === "CASE-208")
    ?.telemetry?.plannerActions, ["STOP_INCONCLUSIVE"]);
  assert.equal(liveReport.aggregate.inconclusiveCases, 1);
});
