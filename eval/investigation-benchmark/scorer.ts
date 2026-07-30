import type {
  EvidencePrecisionScore,
  InvestigationAggregateMetrics,
  InvestigationBenchmarkCase,
  InvestigationCaseEvalResult,
  InvestigationGroundTruth,
  InvestigationTokenUsage,
  NormalizedInvestigationResult,
  RootCauseScore,
} from "./types";

const normalizeRootCause = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replace(/[\p{P}\p{S}\s]+/gu, "");

const duplicates = (values: string[]) => {
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateIds.add(value);
    seen.add(value);
  }
  return [...duplicateIds].sort();
};

const assertUnique = (values: string[], label: string) => {
  const duplicateIds = duplicates(values);
  if (duplicateIds.length > 0) {
    throw new Error(`${label} contains duplicate IDs: ${duplicateIds.join(", ")}`);
  }
};

const assertGroundTruth = (groundTruth: InvestigationGroundTruth) => {
  assertUnique(groundTruth.requiredEvidenceIds, "requiredEvidenceIds");
  assertUnique(groundTruth.supportingEvidenceIds, "supportingEvidenceIds");
  assertUnique(groundTruth.distractorEvidenceIds, "distractorEvidenceIds");
  const supporting = new Set(groundTruth.supportingEvidenceIds);
  const distractors = new Set(groundTruth.distractorEvidenceIds);
  const missingRequired = groundTruth.requiredEvidenceIds.filter((id) => !supporting.has(id));
  if (missingRequired.length > 0) {
    throw new Error(`requiredEvidenceIds must be included in supportingEvidenceIds: ${missingRequired.join(", ")}`);
  }
  const overlap = groundTruth.supportingEvidenceIds.filter((id) => distractors.has(id));
  if (overlap.length > 0) {
    throw new Error(`supportingEvidenceIds and distractorEvidenceIds overlap: ${overlap.join(", ")}`);
  }
};

const assertCount = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
};

const assertMeasurement = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
};

const assertTokenUsage = (usage: InvestigationTokenUsage) => {
  const values = [usage.inputTokens, usage.outputTokens, usage.totalTokens];
  for (const [index, value] of values.entries()) {
    if (value !== null) assertCount(value, ["inputTokens", "outputTokens", "totalTokens"][index]);
  }
  const knownCount = values.filter((value) => value !== null).length;
  if (usage.completeness === "COMPLETE" && knownCount !== values.length) {
    throw new Error("COMPLETE token usage requires input, output, and total token counts.");
  }
  if (usage.completeness === "PARTIAL" && (knownCount === 0 || knownCount === values.length)) {
    throw new Error("PARTIAL token usage requires some, but not all, token counts.");
  }
  if (usage.completeness === "UNAVAILABLE" && knownCount !== 0) {
    throw new Error("UNAVAILABLE token usage cannot contain token counts.");
  }
};

const scoreRootCause = (
  groundTruth: InvestigationGroundTruth,
  result: NormalizedInvestigationResult,
): RootCauseScore => {
  let correct = false;
  let matchedBy: RootCauseScore["matchedBy"] = "NONE";
  if (result.predictedRootCauseId !== null) {
    correct = result.predictedRootCauseId === groundTruth.canonicalRootCauseId;
    if (correct) matchedBy = "ID";
  } else {
    const predicted = normalizeRootCause(result.predictedRootCause);
    const acceptable = [groundTruth.canonicalRootCause, ...groundTruth.acceptableAliases]
      .map(normalizeRootCause);
    correct = predicted.length > 0 && acceptable.includes(predicted);
    if (correct) matchedBy = "ALIAS";
  }
  return {
    correct,
    expected: {
      id: groundTruth.canonicalRootCauseId,
      rootCause: groundTruth.canonicalRootCause,
    },
    predicted: {
      id: result.predictedRootCauseId,
      rootCause: result.predictedRootCause,
    },
    matchedBy,
  };
};

const scoreEvidence = (
  groundTruth: InvestigationGroundTruth,
  citedEvidenceIds: string[],
): EvidencePrecisionScore => {
  const duplicateEvidenceIds = duplicates(citedEvidenceIds);
  const uniqueCitations = [...new Set(citedEvidenceIds)];
  const supporting = new Set(groundTruth.supportingEvidenceIds);
  const known = new Set([
    ...groundTruth.supportingEvidenceIds,
    ...groundTruth.distractorEvidenceIds,
  ]);
  const relevantCount = uniqueCitations.filter((id) => supporting.has(id)).length;
  const citedCount = uniqueCitations.length;
  return {
    precision: citedCount === 0 ? 0 : relevantCount / citedCount,
    relevantCount,
    citedCount,
    duplicateEvidenceIds,
    unknownEvidenceIds: uniqueCitations.filter((id) => !known.has(id)).sort(),
  };
};

const scoreGrounding = (result: NormalizedInvestigationResult) => {
  const claims = result.diagnosisClaims.filter((claim) => claim.type !== "LIMITATION");
  const unsupported = claims.filter((claim) => claim.groundingStatus === "UNGROUNDED");
  const notEvaluable = claims.length === 0 || claims.some((claim) =>
    claim.groundingStatus === "LEGACY_UNVERIFIED"
    || (claim.groundingStatus === "GROUNDED" && claim.citedEvidenceIds.length === 0));
  return {
    unsupportedClaimRate: notEvaluable ? null : unsupported.length / claims.length,
    unsupportedClaims: unsupported.map((claim) => ({
      claimId: claim.claimId,
      statement: claim.statement,
    })),
    evaluatedClaimCount: notEvaluable ? 0 : claims.length,
    status: notEvaluable ? "NOT_EVALUABLE" as const : "EVALUABLE" as const,
  };
};

export function scoreInvestigationCase(
  benchmarkCase: InvestigationBenchmarkCase,
  result: NormalizedInvestigationResult,
): InvestigationCaseEvalResult {
  if (benchmarkCase.caseId !== result.caseId) {
    throw new Error(`Case ID mismatch: expected ${benchmarkCase.caseId}, received ${result.caseId}.`);
  }
  assertGroundTruth(benchmarkCase.groundTruth);
  assertCount(result.modelCallCount, "modelCallCount");
  assertCount(result.toolCallCount, "toolCallCount");
  if (result.durationMs !== undefined) assertMeasurement(result.durationMs, "durationMs");
  if (result.tokenUsage) assertTokenUsage(result.tokenUsage);

  const grounding = scoreGrounding(result);
  return {
    caseId: benchmarkCase.caseId,
    rootCause: scoreRootCause(benchmarkCase.groundTruth, result),
    evidence: scoreEvidence(benchmarkCase.groundTruth, result.citedEvidenceIds),
    grounding,
    cost: {
      modelCalls: result.modelCallCount,
      toolCalls: result.toolCallCount,
      ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    },
    overallStatus: grounding.status === "EVALUABLE"
      ? "EVALUATED"
      : "PARTIALLY_EVALUATED",
  };
}

const mean = (values: number[]) => values.length === 0
  ? null
  : values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
};

type CompleteTokenUsage = InvestigationTokenUsage & {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

const completeTokenUsage = (
  result: InvestigationCaseEvalResult,
): CompleteTokenUsage | null => {
  const usage = result.cost.tokenUsage;
  if (
    !usage
    || usage.completeness !== "COMPLETE"
    || usage.inputTokens === null
    || usage.outputTokens === null
    || usage.totalTokens === null
  ) return null;
  return {
    ...usage,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
};

export function aggregateInvestigationMetrics(
  results: InvestigationCaseEvalResult[],
): InvestigationAggregateMetrics {
  const groundingRates = results.flatMap((result) =>
    result.grounding.unsupportedClaimRate === null
      ? []
      : [result.grounding.unsupportedClaimRate]);
  const tokenUsages = results.map(completeTokenUsage);
  const hasCompleteTokenCoverage = results.length > 0
    && tokenUsages.every((usage) => usage !== null);
  const completeUsages = tokenUsages.filter((usage): usage is CompleteTokenUsage =>
    usage !== null);
  const totalInputTokens = completeUsages.reduce((sum, usage) => sum + usage.inputTokens, 0);
  const totalOutputTokens = completeUsages.reduce((sum, usage) => sum + usage.outputTokens, 0);
  const totalTokens = completeUsages.reduce((sum, usage) => sum + usage.totalTokens, 0);

  return {
    totalCases: results.length,
    rootCauseTop1Accuracy: mean(results.map((result) => result.rootCause.correct ? 1 : 0)),
    meanEvidencePrecision: mean(results.map((result) => result.evidence.precision)),
    meanUnsupportedClaimRate: mean(groundingRates),
    medianModelCalls: median(results.map((result) => result.cost.modelCalls)),
    medianToolCalls: median(results.map((result) => result.cost.toolCalls)),
    ...(hasCompleteTokenCoverage ? {
      tokenMetrics: {
        totalInputTokens,
        totalOutputTokens,
        totalTokens,
        meanTotalTokens: totalTokens / results.length,
      },
    } : {}),
  };
}
