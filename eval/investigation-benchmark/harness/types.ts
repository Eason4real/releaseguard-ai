import type { BenchmarkAgentExecutionInput, InvestigationCaseEvalResult,
  NormalizedInvestigationResult } from "../types";
import type { BenchmarkCaseCategory } from "../types";
import type { DatasetDifficulty } from "../dataset/types";

export const DEV_HARNESS_PROVIDER = "HARNESS_PROVIDER" as const;
export const DEV_HARNESS_MODE = "DETERMINISTIC_NO_LIVE_MODEL" as const;

export type HarnessToolObservation = {
  evidenceId: string;
  sourceRef: string;
  toolName: string;
  observationScope: "CURRENT_INCIDENT" | "HISTORICAL";
  status: "SUCCESS" | "EMPTY" | "ERROR";
  output: unknown;
};

export type HarnessAgentRequest = {
  agentInput: BenchmarkAgentExecutionInput;
  enabledTools: string[];
  observations: HarnessToolObservation[];
};

export type HarnessRawPrediction = {
  predictedRootCause?: string | null;
  predictedRootCauseId?: string | null;
  citedEvidenceIds?: string[];
  diagnosisClaims?: Array<{
    claimId: string;
    type: "ROOT_CAUSE" | "CAUSAL_STEP" | "AFFECTED_METRIC" | "AFFECTED_SEGMENT" | "LIMITATION";
    statement: string;
    groundingStatus?: "GROUNDED" | "UNGROUNDED" | "LEGACY_UNVERIFIED";
    citedEvidenceIds?: string[];
  }>;
  diagnosisClaimEvidenceLinks?: Array<{ claimId: string; evidenceId: string }>;
  modelCallCount: number;
  toolCallCount: number;
  tokenUsage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  };
  durationMs?: number;
};

export type HarnessExecutionOutcome = {
  status: "PASS" | "FAIL";
  terminalInvestigationState: "FINALIZED" | "INCONCLUSIVE" | "FAILED";
  prediction?: HarnessRawPrediction;
  error?: string;
};

export type HarnessExecutionProvider = {
  readonly providerType: typeof DEV_HARNESS_PROVIDER;
  execute(request: HarnessAgentRequest): HarnessExecutionOutcome | Promise<HarnessExecutionOutcome>;
};

export type HarnessExecutionProviderFactory = {
  create(): HarnessExecutionProvider;
};

export type HarnessRunManifest = {
  runId: string;
  datasetId: string;
  datasetVersion: string;
  datasetHash: string;
  evaluationContractVersion: string;
  sourceCommit: string;
  executionProvider: typeof DEV_HARNESS_PROVIDER;
  runtimeMode: typeof DEV_HARNESS_MODE;
  enabledTools: string[];
  modelConfiguration: "deterministic / no live model";
  startedAt: string;
  completedAt: string;
  totalCases: number;
  completedCases: number;
  failedCases: number;
};

export type HarnessCaseExecutionResult = {
  caseId: string;
  category: BenchmarkCaseCategory;
  difficulty: DatasetDifficulty;
  execution: {
    status: "PASS" | "FAIL";
    terminalInvestigationState: "FINALIZED" | "INCONCLUSIVE" | "FAILED";
    modelCallCount: number;
    toolCallCount: number;
    error?: string;
  };
  normalizedPrediction: NormalizedInvestigationResult | null;
  scoring: InvestigationCaseEvalResult;
};

export type HarnessAggregateMetrics = {
  totalCases: number;
  completedCases: number;
  failedCases: number;
  rootCauseTop1Accuracy: number | null;
  meanEvidencePrecision: number | null;
  meanUnsupportedClaimRate: number | null;
  groundingEvaluableCases: number;
  groundingUnavailableCases: number;
  medianModelCalls: number | null;
  medianToolCalls: number | null;
  totalModelCalls: number;
  totalToolCalls: number;
};

export type HarnessBreakdown = {
  category: Record<string, HarnessAggregateMetrics>;
  difficulty: Record<string, HarnessAggregateMetrics>;
};

export type DevHarnessReport = {
  label: "Deterministic Harness Validation";
  manifest: HarnessRunManifest;
  cases: HarnessCaseExecutionResult[];
  aggregate: HarnessAggregateMetrics;
  breakdown: HarnessBreakdown;
  semanticHash: string;
};

export type DevHarnessRunOptions = {
  sourceCommit: string;
  providerFactory: HarnessExecutionProviderFactory;
  caseId?: string;
  runId?: string;
  now?: () => string;
};
