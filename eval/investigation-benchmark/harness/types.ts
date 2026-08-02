import type { BenchmarkAgentExecutionInput, InvestigationCaseEvalResult,
  NormalizedInvestigationResult } from "../types";
import type { BenchmarkCaseCategory } from "../types";
import type { DatasetDifficulty } from "../dataset/types";
import type { ModelConfig } from "../../../lib/investigation/model";
import type {
  Confidence,
  EvidenceRelation,
  EvidenceStrength,
  HypothesisStatus,
  InvestigationDecisionType,
  InvestigationRunStatus,
  InvestigationStopReason,
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
  selector: HarnessObservationSelector;
  output: unknown;
};

export type HarnessObservationSelector = {
  releaseId?: string;
  metricKey?: string;
  dimension?: string;
  platform?: string;
  version?: string;
  region?: string;
  userType?: string;
};

export type HarnessProductionEvidenceCategory =
  | "RELEASE_CHANGE"
  | "PRODUCT_METRIC"
  | "SEGMENT_METRIC"
  | "USER_FEEDBACK"
  | "SIMILAR_INCIDENT";

export type HarnessFixtureExecutionRecord = {
  matched: boolean;
  matchedObservationId: string | null;
  benchmarkEvidenceId: string | null;
  category: HarnessProductionEvidenceCategory | null;
  selector: HarnessObservationSelector;
  output: unknown;
  toolName: string;
  toolSignature: string;
  toolCallId: string | null;
  toolResultId: string | null;
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

export type HarnessTelemetryValue = null | boolean | number | string
  | HarnessTelemetryValue[] | { [key: string]: HarnessTelemetryValue };

export type HarnessExecutionTelemetry = {
  schemaVersion: "benchmark-observability-v3";
  telemetryIdentity: string;
  availability: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  plannerActions: InvestigationDecisionType[];
  plannerStopDecision: {
    iteration: number;
    reasonCode: string;
    reason: string;
    rationale: string;
  } | null;
  schemaRepairCount: number;
  plannerValidationEvents: Array<{
    iteration: number | null;
    attemptIndex: number;
    outcome: "REPAIR_ATTEMPTED" | "REPAIRED" | "REPAIR_FAILED";
    validationKind: "SCHEMA" | "SEMANTIC";
    decisionType: InvestigationDecisionType | null;
    validationCode: string | null;
    validationPath: string | null;
    validationSubcode: string | null;
    responseHash: string | null;
    responseStructure: HarnessTelemetryValue | null;
  }>;
  guardEvents: Array<{
    eventType: "DUPLICATE_TOOL_CALL";
    iteration: number | null;
    proposedToolName: string | null;
    sanitizedProposedArguments: Record<string, HarnessTelemetryValue> | null;
    proposedFingerprint: string | null;
    duplicateOfToolCallId: string | null;
    duplicateOfFingerprint: string | null;
    resolution: "REJECTED_AND_STOPPED_INCONCLUSIVE";
  }> | null;
  iterations: Array<{
    sequence: number;
    iterationId: string;
    status: "RUNNING" | "COMPLETED" | "PAUSED" | "FAILED";
    decisionType: InvestigationDecisionType | null;
    publicRationale: string | null;
  }>;
  toolTrajectory: Array<{
    order: number;
    iteration: number;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, HarnessTelemetryValue>;
    status: ToolCallStatus;
    resultStatus: "SUCCESS" | "EMPTY" | "ERROR" | null;
    observationMetadata: {
      valueType: string;
      topLevelKeys: string[];
      itemCount: number | null;
    };
    evidenceIds: string[];
    error: "TOOL_ERROR_REPORTED" | null;
  }>;
  evidencePersistenceEvents: Array<{
    evidenceId: string;
    toolCallId: string | null;
    category: string;
    source: string;
    strength: EvidenceStrength;
    provenance: "synthetic" | "runtime_generated" | "derived" | "public_reference";
    statement: string;
  }>;
  evidenceAssessments: Array<{
    iteration: number | null;
    evidenceId: string;
    hypothesisId: string;
    relation: EvidenceRelation;
    explanation: string;
  }>;
  hypothesisTransitions: Array<{
    iteration: number | null;
    hypothesisId: string;
    before: {
      status: HypothesisStatus;
      confidence: Confidence;
      supportScore: number;
      contradictionScore: number;
    } | null;
    after: {
      status: HypothesisStatus;
      confidence: Confidence;
      supportScore: number;
      contradictionScore: number;
    };
  }> | null;
  competingHypothesisState: Array<{
    hypothesisId: string;
    revision: number;
    statement: string;
    status: HypothesisStatus;
    confidence: Confidence;
    supportScore: number;
    contradictionScore: number;
  }>;
  diagnosisAttempts: Array<{
    attempt: number;
    diagnosisId: string | null;
    selectedHypothesisId: string | null;
    validationResult: "ACCEPTED" | "REJECTED" | "UNAVAILABLE";
    rejectionReason: string | null;
  }>;
  finalizeAttempts: Array<{
    iteration: number;
    validationResult: "ACCEPTED" | "REJECTED" | "UNAVAILABLE";
    rejectionReason: string | null;
  }>;
  stopReason: InvestigationStopReason | null;
  budgetTerminationReason: InvestigationStopReason | null;
  terminalState: InvestigationRunStatus;
  modelCallCount: number;
  toolCallCount: number;
  unavailableFields: string[];
};

export type HarnessExecutionOutcome = {
  status: "PASS" | "FAIL";
  terminalInvestigationState: "FINALIZED" | "INCONCLUSIVE" | "FAILED";
  prediction?: HarnessRawPrediction;
  telemetry?: HarnessExecutionTelemetry;
  error?: string;
  errorCategory?: HarnessErrorCategory;
};

export type HarnessErrorCategory =
  | "PLANNER_SCHEMA_ERROR"
  | "INVALID_PLANNER_DECISION"
  | "RUNTIME_ERROR";

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
  telemetrySchemaVersion: "benchmark-observability-v3";
  sourceCommit: string;
  executionProvider: HarnessExecutionProviderType;
  runtimeMode: HarnessRuntimeMode;
  enabledTools: string[];
  modelConfiguration: "deterministic / no live model" | LiveHarnessManifestModelConfiguration;
  startedAt: string;
  completedAt: string | null;
  totalCases: number;
  processedCases: number;
  completedCases: number;
  failedCases: number;
  inconclusiveCases: number;
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
    errorCategory: HarnessErrorCategory | null;
  };
  normalizedPrediction: NormalizedInvestigationResult | null;
  telemetry: HarnessExecutionTelemetry | null;
  scoring: InvestigationCaseEvalResult;
};

export type HarnessAggregateMetrics = {
  totalCases: number;
  completedCases: number;
  failedCases: number;
  inconclusiveCases: number;
  rootCauseTop1Accuracy: number | null;
  rootCauseExactMatchAccuracy: number | null;
  rootCauseSemanticAccuracy: number | null;
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
  plannerValidationFailures: number;
  plannerDecisionRepairAttempts: number;
  plannerDecisionRepairSuccesses: number;
  plannerDecisionRepairRate: number | null;
  plannerFirstAttemptSuccessRate: number | null;
  plannerFinalSuccessRate: number | null;
  errorTaxonomyCounts: Record<HarnessErrorCategory, number>;
  groundedContractMismatches: number;
  tokenUsage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  };
  totalDurationMs: number | null;
  estimatedOrActualCost: null;
};

export type HarnessBreakdown = {
  category: Record<string, HarnessAggregateMetrics>;
  difficulty: Record<string, HarnessAggregateMetrics>;
};

export type DevHarnessReport = {
  schemaVersion: "investigation-live-benchmark-report-v1";
  reportStatus: "COMPLETE" | "INCOMPLETE";
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
  onProgress?: (event: {
    index: number;
    total: number;
    caseId: string;
    phase: "START" | "END";
    terminalState?: HarnessExecutionOutcome["terminalInvestigationState"];
    modelCallCount?: number;
    toolCallCount?: number;
    durationMs?: number;
  }) => void;
  onCheckpoint?: (report: DevHarnessReport) => void | Promise<void>;
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
