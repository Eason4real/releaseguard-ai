import type { Release, RiskEvent } from "../../lib/analytics/types";
import type {
  DiagnosisClaimType,
  DiagnosisGroundingStatus,
} from "../../lib/investigation/types";

export const BENCHMARK_CASE_CATEGORIES = [
  "release_regression",
  "configuration",
  "database",
  "upstream_dependency",
  "infrastructure",
  "user_feedback",
  "unknown",
  "insufficient_evidence",
] as const;

export type BenchmarkCaseCategory = (typeof BENCHMARK_CASE_CATEGORIES)[number];
export type BenchmarkDifficulty = "easy" | "medium" | "hard";

export type BenchmarkDataSourceFixture = {
  sourceId: string;
  kind: "analytics" | "release" | "feedback" | "technical_signal" | "historical_incident";
  fixtureRef: string;
  evidenceIds: string[];
};

export type InvestigationGroundTruth = {
  canonicalRootCauseId: string;
  canonicalRootCause: string;
  acceptableAliases: string[];
  requiredEvidenceIds: string[];
  supportingEvidenceIds: string[];
  distractorEvidenceIds: string[];
};

export type InvestigationBenchmarkCase = {
  caseId: string;
  title: string;
  category: BenchmarkCaseCategory;
  difficulty: BenchmarkDifficulty;
  input: {
    incidentId: string;
    question: string;
    riskEvent: RiskEvent | null;
    release?: Release | null;
  };
  dataSources: BenchmarkDataSourceFixture[];
  groundTruth: InvestigationGroundTruth;
};

export type NormalizedDiagnosisClaim = {
  claimId: string;
  type: DiagnosisClaimType;
  statement: string;
  citedEvidenceIds: string[];
  groundingStatus: DiagnosisGroundingStatus;
};

export type InvestigationTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
};

export type NormalizedInvestigationResult = {
  caseId: string;
  predictedRootCause: string;
  predictedRootCauseId: string | null;
  citedEvidenceIds: string[];
  diagnosisClaims: NormalizedDiagnosisClaim[];
  modelCallCount: number;
  toolCallCount: number;
  tokenUsage?: InvestigationTokenUsage;
  durationMs?: number;
};

export type BenchmarkRawDiagnosisClaim = {
  claimId: string;
  type: DiagnosisClaimType;
  statement: string;
  groundingStatus?: DiagnosisGroundingStatus;
  citedEvidenceIds?: string[];
};

export type BenchmarkRawInvestigationResult = {
  caseId: string;
  predictedRootCause?: string | null;
  predictedRootCauseId?: string | null;
  citedEvidenceIds?: string[];
  diagnosisClaims?: BenchmarkRawDiagnosisClaim[];
  diagnosisClaimEvidenceLinks?: Array<{
    claimId: string;
    evidenceId: string;
  }>;
  modelCallCount?: number;
  toolCallCount?: number;
  tokenUsage?: InvestigationTokenUsage;
  durationMs?: number;
};

export type BenchmarkResultProvider = {
  run(benchmarkCase: InvestigationBenchmarkCase):
    | BenchmarkRawInvestigationResult
    | Promise<BenchmarkRawInvestigationResult>;
};

export type InvestigationBenchmarkRunResult = {
  cases: InvestigationCaseEvalResult[];
  aggregate: InvestigationAggregateMetrics;
};

export type RootCauseScore = {
  correct: boolean;
  expected: { id: string; rootCause: string };
  predicted: { id: string | null; rootCause: string };
  matchedBy: "ID" | "ALIAS" | "NONE";
};

export type EvidencePrecisionScore = {
  precision: number;
  relevantCount: number;
  citedCount: number;
  duplicateEvidenceIds: string[];
  unknownEvidenceIds: string[];
};

export type GroundingScore = {
  unsupportedClaimRate: number | null;
  unsupportedClaims: Array<{ claimId: string; statement: string }>;
  evaluatedClaimCount: number;
  status: "EVALUABLE" | "NOT_EVALUABLE";
};

export type InvestigationCostScore = {
  modelCalls: number;
  toolCalls: number;
  tokenUsage?: InvestigationTokenUsage;
  durationMs?: number;
};

export type InvestigationCaseEvalResult = {
  caseId: string;
  rootCause: RootCauseScore;
  evidence: EvidencePrecisionScore;
  grounding: GroundingScore;
  cost: InvestigationCostScore;
  overallStatus: "EVALUATED" | "PARTIALLY_EVALUATED";
};

export type AggregateTokenMetrics = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  meanTotalTokens: number;
};

export type InvestigationAggregateMetrics = {
  totalCases: number;
  rootCauseTop1Accuracy: number | null;
  meanEvidencePrecision: number | null;
  meanUnsupportedClaimRate: number | null;
  medianModelCalls: number | null;
  medianToolCalls: number | null;
  tokenMetrics?: AggregateTokenMetrics;
};
