import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateInvestigationMetrics,
  scoreInvestigationCase,
} from "../eval/investigation-benchmark/scorer";
import type {
  InvestigationBenchmarkCase,
  NormalizedInvestigationResult,
} from "../eval/investigation-benchmark/types";

const benchmarkCase = (caseId: string): InvestigationBenchmarkCase => ({
  caseId,
  title: `Synthetic scorer fixture ${caseId}`,
  category: "release_regression",
  difficulty: "easy",
  input: {
    incidentId: `INC-${caseId}`,
    question: "What caused the release incident?",
    riskEvent: null,
  },
  dataSources: [{
    sourceId: `SOURCE-${caseId}`,
    kind: "analytics",
    fixtureRef: `synthetic://${caseId}`,
    evidenceIds: ["EV-REQUIRED", "EV-SUPPORT", "EV-DISTRACTOR"],
  }],
  groundTruth: {
    canonicalRootCauseId: "RC-RETRY-LOCK",
    canonicalRootCause: "Immediate retry conflicted with the idempotency lock.",
    acceptableAliases: ["Idempotency lock conflict from immediate retry"],
    requiredEvidenceIds: ["EV-REQUIRED"],
    supportingEvidenceIds: ["EV-REQUIRED", "EV-SUPPORT"],
    distractorEvidenceIds: ["EV-DISTRACTOR"],
  },
});

const fixtures: NormalizedInvestigationResult[] = [
  {
    caseId: "CASE-A",
    predictedRootCause: "Exact canonical diagnosis",
    predictedRootCauseId: "RC-RETRY-LOCK",
    citedEvidenceIds: ["EV-REQUIRED", "EV-SUPPORT"],
    diagnosisClaims: [{
      claimId: "CLAIM-A-ROOT",
      type: "ROOT_CAUSE",
      statement: "Immediate retry conflicted with the idempotency lock.",
      citedEvidenceIds: ["EV-REQUIRED"],
      groundingStatus: "GROUNDED",
    }],
    modelCallCount: 3,
    toolCallCount: 4,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      completeness: "COMPLETE",
    },
    durationMs: 1_000,
  },
  {
    caseId: "CASE-B",
    predictedRootCause: "Idempotency lock conflict from immediate retry",
    predictedRootCauseId: "RC-WRONG",
    citedEvidenceIds: ["EV-REQUIRED", "EV-DISTRACTOR", "EV-DISTRACTOR", "EV-UNKNOWN"],
    diagnosisClaims: [{
      claimId: "CLAIM-B-ROOT",
      type: "ROOT_CAUSE",
      statement: "A different cause was selected.",
      citedEvidenceIds: ["EV-DISTRACTOR"],
      groundingStatus: "GROUNDED",
    }],
    modelCallCount: 8,
    toolCallCount: 7,
  },
  {
    caseId: "CASE-C",
    predictedRootCause: "  IDEMPOTENCY LOCK conflict from immediate retry!!! ",
    predictedRootCauseId: null,
    citedEvidenceIds: [],
    diagnosisClaims: [
      {
        claimId: "CLAIM-C-ROOT",
        type: "ROOT_CAUSE",
        statement: "Immediate retry conflicted with the idempotency lock.",
        citedEvidenceIds: ["EV-REQUIRED"],
        groundingStatus: "GROUNDED",
      },
      {
        claimId: "CLAIM-C-IMPACT",
        type: "AFFECTED_METRIC",
        statement: "All regions were affected.",
        citedEvidenceIds: [],
        groundingStatus: "UNGROUNDED",
      },
    ],
    modelCallCount: 5,
    toolCallCount: 2,
    tokenUsage: {
      inputTokens: 50,
      outputTokens: null,
      totalTokens: null,
      completeness: "PARTIAL",
    },
  },
];

test("scores stable IDs before aliases and handles duplicate and unknown evidence IDs", () => {
  const correct = scoreInvestigationCase(benchmarkCase("CASE-A"), fixtures[0]);
  assert.equal(correct.rootCause.correct, true);
  assert.equal(correct.rootCause.matchedBy, "ID");
  assert.deepEqual(correct.evidence, {
    precision: 1,
    relevantCount: 2,
    citedCount: 2,
    duplicateEvidenceIds: [],
    unknownEvidenceIds: [],
  });

  const incorrect = scoreInvestigationCase(benchmarkCase("CASE-B"), fixtures[1]);
  assert.equal(incorrect.rootCause.correct, false,
    "a wrong stable ID must not be rescued by matching alias text");
  assert.equal(incorrect.rootCause.matchedBy, "NONE");
  assert.equal(incorrect.evidence.precision, 1 / 3);
  assert.equal(incorrect.evidence.relevantCount, 1);
  assert.equal(incorrect.evidence.citedCount, 3);
  assert.deepEqual(incorrect.evidence.duplicateEvidenceIds, ["EV-DISTRACTOR"]);
  assert.deepEqual(incorrect.evidence.unknownEvidenceIds, ["EV-UNKNOWN"]);
});

test("uses normalized aliases, defines empty evidence precision, and scores unsupported claims", () => {
  const result = scoreInvestigationCase(benchmarkCase("CASE-C"), fixtures[2]);
  assert.equal(result.rootCause.correct, true);
  assert.equal(result.rootCause.matchedBy, "ALIAS");
  assert.deepEqual(result.evidence, {
    precision: 0,
    relevantCount: 0,
    citedCount: 0,
    duplicateEvidenceIds: [],
    unknownEvidenceIds: [],
  });
  assert.deepEqual(result.grounding, {
    unsupportedClaimRate: 0.5,
    unsupportedClaims: [{ claimId: "CLAIM-C-IMPACT", statement: "All regions were affected." }],
    evaluatedClaimCount: 2,
    status: "EVALUABLE",
  });
  assert.equal(result.overallStatus, "EVALUATED");
});

test("marks incomplete claim linkage unavailable and aggregates only evaluable metrics", () => {
  const legacyFixture: NormalizedInvestigationResult = {
    ...fixtures[2],
    diagnosisClaims: fixtures[2].diagnosisClaims.map((claim, index) => index === 0
      ? { ...claim, groundingStatus: "LEGACY_UNVERIFIED" }
      : claim),
  };
  const unavailable = scoreInvestigationCase(benchmarkCase("CASE-C"), legacyFixture);
  assert.equal(unavailable.grounding.status, "NOT_EVALUABLE");
  assert.equal(unavailable.grounding.unsupportedClaimRate, null);
  assert.equal(unavailable.overallStatus, "PARTIALLY_EVALUATED");

  const results = fixtures.map((fixture) =>
    scoreInvestigationCase(benchmarkCase(fixture.caseId), fixture));
  assert.deepEqual(aggregateInvestigationMetrics(results), {
    totalCases: 3,
    rootCauseTop1Accuracy: 2 / 3,
    meanEvidencePrecision: (1 + 1 / 3) / 3,
    meanUnsupportedClaimRate: 1 / 6,
    medianModelCalls: 5,
    medianToolCalls: 4,
  });
  assert.deepEqual(aggregateInvestigationMetrics([results[0]]).tokenMetrics, {
    totalInputTokens: 100,
    totalOutputTokens: 25,
    totalTokens: 125,
    meanTotalTokens: 125,
  });
  assert.equal(aggregateInvestigationMetrics([unavailable]).meanUnsupportedClaimRate, null);
});
