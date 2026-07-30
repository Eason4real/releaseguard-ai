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
export type RootCauseAnswerMode = "CAUSAL" | "ABSTAIN";
export const ROOT_CAUSE_SEMANTIC_CONCEPTS = [
  "RECOMMENDATION_SYSTEM",
  "FEATURE_FLAG_ROLLOUT",
  "EXPERIMENT_ASSIGNMENT",
  "NEW_USERS",
  "INCORRECT_ASSIGNMENT",
  "EVIDENCE_INSUFFICIENT",
  "ALTERNATIVES_UNRESOLVED",
  "CHECKOUT_RELEASE",
  "PAYMENT_PROVIDER_INSTABILITY",
  "DEFINITE_CAUSAL_ATTRIBUTION",
  "RELEASE_EXCLUDED",
  "IMMEDIATE_RETRY",
  "IDEMPOTENCY_LOCK",
  "DATABASE_LOCK",
] as const;
export type RootCauseSemanticConcept = (typeof ROOT_CAUSE_SEMANTIC_CONCEPTS)[number];

export type RootCauseConceptGroup = {
  id: string;
  anyOf: RootCauseSemanticConcept[];
};

export type RootCauseEvaluationRubric = {
  expectedAnswerMode: RootCauseAnswerMode;
  requiredConceptGroups: RootCauseConceptGroup[];
  optionalConcepts: RootCauseSemanticConcept[];
  forbiddenConcepts: RootCauseSemanticConcept[];
  uncertaintyPolicy: "NOT_APPLICABLE" | "REQUIRE_ABSTENTION" | "REQUIRE_UNRESOLVED_ALTERNATIVES";
  specificityPolicy: "ALLOW_MORE_SPECIFIC_IF_CONSISTENT";
};

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
  rootCauseEvaluation: RootCauseEvaluationRubric;
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

export type BenchmarkAgentDataSource = {
  kind: BenchmarkDataSourceFixture["kind"];
  sourceRef: string;
};

export type BenchmarkAgentExecutionInput = {
  incidentId: string;
  incidentQuestion: string;
  riskEvent: RiskEvent | null;
  release?: Release | null;
  dataSources: BenchmarkAgentDataSource[];
};

export type BenchmarkExecutionRequest = {
  executionKey: string;
  agentInput: BenchmarkAgentExecutionInput;
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
  run(request: BenchmarkExecutionRequest):
    | BenchmarkRawInvestigationResult
    | Promise<BenchmarkRawInvestigationResult>;
};

export type InvestigationBenchmarkRunResult = {
  cases: InvestigationCaseEvalResult[];
  aggregate: InvestigationAggregateMetrics;
};

export type RootCauseScore = {
  correct: boolean | null;
  expected: { id: string; rootCause: string };
  predicted: { id: string | null; rootCause: string };
  matchedBy: "ID" | "ALIAS" | "SEMANTIC_RUBRIC" | "ABSTENTION" | "NONE";
  evaluationStatus: "AUTOMATICALLY_EVALUATED" | "REVIEW_REQUIRED" | "RUNTIME_FAILED";
  audit: {
    predictedAnswerMode: RootCauseAnswerMode;
    expectedAnswerMode: RootCauseAnswerMode;
    matchedConcepts: RootCauseSemanticConcept[];
    missingRequiredConcepts: string[];
    forbiddenAssertions: RootCauseSemanticConcept[];
    uncertaintyPolicyResult: "PASS" | "FAIL" | "NOT_APPLICABLE" | "REVIEW_REQUIRED";
    specificityPolicyResult: "PASS" | "FAIL" | "REVIEW_REQUIRED";
    finalDecision: "CORRECT" | "INCORRECT" | "REVIEW_REQUIRED" | "RUNTIME_FAILED";
    decisionReason: string;
  };
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
  runtimeFailed: boolean;
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
  automaticallyEvaluatedCases: number;
  correctCases: number;
  incorrectCases: number;
  reviewRequiredCases: number;
  runtimeFailedCases: number;
  autoEvaluationCoverage: number | null;
  autoEvaluableAccuracy: number | null;
  meanEvidencePrecision: number | null;
  meanUnsupportedClaimRate: number | null;
  medianModelCalls: number | null;
  medianToolCalls: number | null;
  tokenMetrics?: AggregateTokenMetrics;
};
