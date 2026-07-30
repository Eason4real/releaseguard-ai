import type {
  EvidencePrecisionScore,
  InvestigationAggregateMetrics,
  InvestigationBenchmarkCase,
  InvestigationCaseEvalResult,
  InvestigationGroundTruth,
  InvestigationTokenUsage,
  NormalizedInvestigationResult,
} from "./types";
import { scoreRootCauseSemantics } from "./root-cause-semantic-scorer";

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
  options: { runtimeFailed?: boolean } = {},
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
    rootCause: scoreRootCauseSemantics(benchmarkCase.groundTruth, result, options),
    evidence: scoreEvidence(benchmarkCase.groundTruth, result.citedEvidenceIds),
    grounding,
    cost: {
      modelCalls: result.modelCallCount,
      toolCalls: result.toolCallCount,
      ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    },
    runtimeFailed: options.runtimeFailed ?? false,
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
  const automaticallyEvaluated = results.filter((result) =>
    !result.runtimeFailed && result.rootCause.evaluationStatus === "AUTOMATICALLY_EVALUATED");
  const correctCases = automaticallyEvaluated.filter((result) =>
    result.rootCause.correct === true).length;
  const incorrectCases = automaticallyEvaluated.filter((result) =>
    result.rootCause.correct === false).length;
  const reviewRequiredCases = results.filter((result) =>
    !result.runtimeFailed && result.rootCause.evaluationStatus === "REVIEW_REQUIRED").length;
  const runtimeFailedCases = results.filter((result) => result.runtimeFailed).length;
  const autoEvaluableAccuracy = automaticallyEvaluated.length === 0
    ? null
    : correctCases / automaticallyEvaluated.length;
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
    rootCauseTop1Accuracy: autoEvaluableAccuracy,
    automaticallyEvaluatedCases: automaticallyEvaluated.length,
    correctCases,
    incorrectCases,
    reviewRequiredCases,
    runtimeFailedCases,
    autoEvaluationCoverage: results.length === 0
      ? null
      : automaticallyEvaluated.length / results.length,
    autoEvaluableAccuracy,
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
