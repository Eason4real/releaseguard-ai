import type { BenchmarkAgentExecutionInput, InvestigationCaseEvalResult,
  NormalizedInvestigationResult } from "../types";
import type { BenchmarkCaseCategory } from "../types";
import type { DatasetDifficulty } from "../dataset/types";
import type { ModelConfig } from "../../../lib/investigation/model";
import type {
  InvestigationDecisionType,
  ToolCallStatus,
} from "../../../lib/investigation/types";

export const DEV_HARNESS_PROVIDER = "HARNESS_PROVIDER" as const;
export const DEV_HARNESS_MODE = "DETERMINISTIC_NO_LIVE_MODEL" as const;
export const LIVE_LLM_PROVIDER = "LIVE_LLM_PROVIDER" as const;
export const LIVE_LLM_MODE = "LIVE_LLM" as const;
export const LIVE_MODEL_PROVIDERS = ["deepseek", "openai-compatible"] as const;

export type LiveModelProvider = (typeof LIVE_MODEL_PROVIDERS)[number];
export type HarnessExecutionProviderType = typeof DEV_HARNESS_PROVIDER | typeof LIVE_LLM_PROVIDER;
export type HarnessRuntimeMode = typeof DEV_HARNESS_MODE | typeof LIVE_LLM_MODE;

export type LiveHarnessModelConfig = ModelConfig & { provider: LiveModelProvider };

export type LiveHarnessManifestModelConfiguration = {
  provider: LiveModelProvider;
  endpointType: "OPENAI_COMPATIBLE_CHAT_COMPLETIONS";
  baseUrl: string;
  model: string;
  temperature: 0.1;
  topP: "PROVIDER_DEFAULT";
  maxOutputTokens: 5000;
  reasoningConfig: "DEEPSEEK_ENABLED_HIGH" | "PROVIDER_DEFAULT";
  maxModelCalls: 20;
  toolBudget: 10;
  maxIterations: 16;
  timeoutMs: number;
  schemaRepairMax: 1;
  transportRetry: 0;
  concurrency: 1;
  credentialPresent: true;
};

export type HarnessExecutionMetadata = {
  label: "Deterministic Harness Validation" | "Live LLM Benchmark";
  executionProvider: HarnessExecutionProviderType;
  runtimeMode: HarnessRuntimeMode;
  modelConfiguration: "deterministic / no live model" | LiveHarnessManifestModelConfiguration;
};

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

export type HarnessExecutionTelemetry = {
  plannerActions: InvestigationDecisionType[];
  schemaRepairCount: number;
  toolTrajectory: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
    status: ToolCallStatus;
    resultStatus: "SUCCESS" | "EMPTY" | "ERROR" | null;
  }>;
};

export type HarnessExecutionOutcome = {
  status: "PASS" | "FAIL";
  terminalInvestigationState: "FINALIZED" | "INCONCLUSIVE" | "FAILED";
  prediction?: HarnessRawPrediction;
  telemetry?: HarnessExecutionTelemetry;
  error?: string;
};

export type HarnessExecutionProvider = {
  readonly providerType: HarnessExecutionProviderType;
  readonly executionMetadata?: HarnessExecutionMetadata;
  execute(request: HarnessAgentRequest): HarnessExecutionOutcome | Promise<HarnessExecutionOutcome>;
};

export type HarnessExecutionProviderFactory = {
  readonly executionMetadata: HarnessExecutionMetadata;
  create(): HarnessExecutionProvider;
};

export type HarnessRunManifest = {
  runId: string;
  datasetId: string;
  datasetVersion: string;
  datasetHash: string;
  evaluationContractVersion: string;
  sourceCommit: string;
  executionProvider: HarnessExecutionProviderType;
  runtimeMode: HarnessRuntimeMode;
  enabledTools: string[];
  modelConfiguration: "deterministic / no live model" | LiveHarnessManifestModelConfiguration;
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
  automaticallyEvaluatedCases: number;
  correctCases: number;
  incorrectCases: number;
  reviewRequiredCases: number;
  runtimeFailedCases: number;
  autoEvaluationCoverage: number | null;
  autoEvaluableAccuracy: number | null;
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
  label: "Deterministic Harness Validation" | "Live LLM Benchmark";
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

export type LivePreflightFixture = {
  caseId: "CASE-901";
  executionPurpose: "PREFLIGHT_ONLY";
  benchmarkEligible: false;
  request: HarnessAgentRequest;
};

export type LivePreflightReport = {
  label: "Live Agent Preflight";
  executionPurpose: "PREFLIGHT_ONLY";
  benchmarkEligible: false;
  caseId: "CASE-901";
  sourceCommit: string;
  executionProvider: typeof LIVE_LLM_PROVIDER;
  provider: LiveModelProvider;
  model: string;
  endpoint: string;
  terminalState: HarnessExecutionOutcome["terminalInvestigationState"];
  status: HarnessExecutionOutcome["status"];
  modelCallCount: number;
  toolCallCount: number;
  tokenUsage: HarnessRawPrediction["tokenUsage"];
  schemaRepairCount: number;
  plannerActions: InvestigationDecisionType[];
  toolTrajectory: HarnessExecutionTelemetry["toolTrajectory"];
  error?: string;
};
