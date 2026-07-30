import assert from "node:assert/strict";
import test from "node:test";
import { createDeterministicFixtureProvider } from "../eval/investigation-benchmark/deterministic-provider";
import { normalizeInvestigationResult } from "../eval/investigation-benchmark/normalizer";
import { runInvestigationBenchmark } from "../eval/investigation-benchmark/runner";
import type {
  BenchmarkRawInvestigationResult,
  InvestigationBenchmarkCase,
} from "../eval/investigation-benchmark/types";

const makeCase = (caseId: string): InvestigationBenchmarkCase => ({
  caseId,
  title: `Phase 1B synthetic ${caseId}`,
  category: "release_regression",
  difficulty: "easy",
  input: {
    incidentId: `INC-${caseId}`,
    question: "What caused the checkout incident?",
    riskEvent: null,
  },
  dataSources: [{
    sourceId: `SOURCE-${caseId}`,
    kind: "analytics",
    fixtureRef: `synthetic://${caseId}`,
    evidenceIds: ["EV-CAUSE", "EV-IMPACT", "EV-DISTRACTOR"],
  }],
  groundTruth: {
    canonicalRootCauseId: "RC-PAYMENT-CALLBACK",
    canonicalRootCause: "The payment callback changed before the checkout confirmation was persisted.",
    acceptableAliases: ["Payment callback persistence race"],
    requiredEvidenceIds: ["EV-CAUSE"],
    supportingEvidenceIds: ["EV-CAUSE", "EV-IMPACT"],
    distractorEvidenceIds: ["EV-DISTRACTOR"],
  },
});

const correctRaw: BenchmarkRawInvestigationResult = {
  caseId: "CASE-A",
  predictedRootCause: "The payment callback changed before the checkout confirmation was persisted.",
  predictedRootCauseId: "RC-PAYMENT-CALLBACK",
  citedEvidenceIds: ["EV-CAUSE", "EV-IMPACT"],
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
    { claimId: "CLAIM-A-ROOT", evidenceId: "EV-CAUSE" },
    { claimId: "CLAIM-A-METRIC", evidenceId: "EV-IMPACT" },
  ],
  modelCallCount: 3,
  toolCallCount: 4,
  tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, completeness: "COMPLETE" },
  durationMs: 250,
};

const noisyRaw: BenchmarkRawInvestigationResult = {
  caseId: "CASE-B",
  predictedRootCause: "A different dependency caused the incident.",
  predictedRootCauseId: "RC-WRONG",
  citedEvidenceIds: ["EV-CAUSE", "EV-DISTRACTOR", "EV-DISTRACTOR", "EV-UNKNOWN"],
  diagnosisClaims: [
    {
      claimId: "CLAIM-B-ROOT",
      type: "ROOT_CAUSE",
      statement: "A different dependency caused the incident.",
      groundingStatus: "UNGROUNDED",
      citedEvidenceIds: ["EV-DISTRACTOR"],
    },
    {
      claimId: "CLAIM-B-METRIC",
      type: "AFFECTED_METRIC",
      statement: "Every region failed.",
      groundingStatus: "UNGROUNDED",
      citedEvidenceIds: ["EV-UNKNOWN"],
    },
  ],
  modelCallCount: 5,
  toolCallCount: 6,
};

const legacyRaw: BenchmarkRawInvestigationResult = {
  caseId: "CASE-C",
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
    [makeCase("CASE-A")],
    createDeterministicFixtureProvider([correctRaw]),
  );
  assert.equal(report.cases[0].rootCause.correct, true);
  assert.equal(report.cases[0].evidence.precision, 1);
  assert.equal(report.cases[0].grounding.unsupportedClaimRate, 0);
  assert.deepEqual(report.aggregate, {
    totalCases: 1,
    rootCauseTop1Accuracy: 1,
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
    [makeCase("CASE-B")],
    createDeterministicFixtureProvider([noisyRaw]),
  );
  assert.equal(report.cases[0].rootCause.correct, false);
  assert.equal(report.cases[0].evidence.precision, 1 / 3);
  assert.deepEqual(report.cases[0].evidence.duplicateEvidenceIds,
    ["EV-DISTRACTOR", "EV-UNKNOWN"]);
  assert.deepEqual(report.cases[0].evidence.unknownEvidenceIds, ["EV-UNKNOWN"]);
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
    [makeCase("CASE-C")],
    createDeterministicFixtureProvider([legacyRaw]),
  );
  assert.equal(report.cases[0].rootCause.correct, true);
  assert.equal(report.cases[0].rootCause.matchedBy, "ALIAS");
  assert.equal(report.cases[0].grounding.status, "NOT_EVALUABLE");
  assert.equal(report.cases[0].grounding.unsupportedClaimRate, null);
  assert.equal(report.aggregate.meanUnsupportedClaimRate, null);
  assert.equal(report.aggregate.tokenMetrics, undefined);
});
