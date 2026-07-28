export const RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_HUMAN_INPUT",
  "WAITING_APPROVAL",
  "ACTION_EXECUTING",
  "WAITING_ACTION_COMPLETION",
  "WAITING_VERIFICATION",
  "VERIFYING",
  "RESOLVED",
  "PARTIALLY_RESOLVED",
  "NOT_RECOVERED",
  "VERIFICATION_INCONCLUSIVE",
  "CLOSED_NO_ACTION",
  "INCONCLUSIVE",
  "FAILED",
] as const;

export type InvestigationRunStatus = (typeof RUN_STATUSES)[number];
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ToolCallStatus =
  | "REQUESTED"
  | "WAITING_APPROVAL"
  | "RUNNING"
  | "COMPLETED"
  | "SUCCESS"
  | "ERROR"
  | "DENIED"
  | "CANCELLED";
export type ToolResultStatus = "SUCCESS" | "EMPTY" | "ERROR";
export type EvidenceStrength = "HIGH" | "MEDIUM" | "LOW";

export type InvestigationRun = {
  id: string;
  incidentId: string;
  riskEventId: string | null;
  releaseId: string | null;
  question: string;
  provider: string;
  model: string;
  plannerType: "LLM" | "DETERMINISTIC";
  status: InvestigationRunStatus;
  currentIteration: number;
  activeIterationId: string | null;
  lockVersion: number;
  stopReason: InvestigationStopReason | null;
  currentDiagnosisRevision: number;
  totalTokens: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ToolCall = {
  id: string;
  runId: string;
  name: string;
  arguments: Record<string, unknown>;
  canonicalSignature: string;
  status: ToolCallStatus;
  proposedActionId: string | null;
  approvalId: string | null;
  agentIterationId: string | null;
  triggerMessageId: string | null;
  cacheSourceToolCallId: string | null;
  iteration: number;
  order: number;
  resultId: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ToolResult = {
  id: string;
  runId: string;
  toolCallId: string;
  status: ToolResultStatus;
  output: unknown | null;
  errorMessage: string | null;
  retryable: boolean;
  createdAt: string;
};

export type Evidence = {
  id: string;
  runId: string;
  toolResultId: string;
  category: string;
  statement: string;
  source: string;
  strength: EvidenceStrength;
  provenance: "synthetic" | "runtime_generated" | "derived" | "public_reference";
  collectedAt: string;
};

export type Diagnosis = {
  id: string;
  runId: string;
  selectedHypothesisId: string | null;
  groundingStatus: DiagnosisGroundingStatus;
  disposition: DiagnosisDisposition | null;
  rootCause: string;
  summary: string;
  causalChain: string[];
  affectedMetrics: string[];
  affectedSegments: string[];
  validatedClaims: string[];
  unvalidatedClaims: string[];
  confidence: Confidence;
  severity: Severity;
  recommendedAction: string;
  revision: number;
  status: "PROVISIONAL" | "FINAL";
  supersedesDiagnosisId: string | null;
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const DIAGNOSIS_CLAIM_TYPES = [
  "ROOT_CAUSE",
  "CAUSAL_STEP",
  "AFFECTED_METRIC",
  "AFFECTED_SEGMENT",
  "LIMITATION",
] as const;

export type DiagnosisClaimType = (typeof DIAGNOSIS_CLAIM_TYPES)[number];
export type DiagnosisGroundingStatus = "GROUNDED" | "UNGROUNDED" | "LEGACY_UNVERIFIED";
export type DiagnosisDisposition = "OBSERVE" | "FIX" | "ROLLBACK" | "ESCALATE";
export const DIAGNOSIS_LIMITATION_TYPES = [
  "DATA_GAP",
  "SCOPE_LIMITATION",
  "UNRESOLVED_UNCERTAINTY",
  "OBSERVABILITY_LIMITATION",
] as const;
export type DiagnosisLimitationType = (typeof DIAGNOSIS_LIMITATION_TYPES)[number];

export type DiagnosisClaim = {
  id: string;
  runId: string;
  diagnosisId: string;
  type: DiagnosisClaimType;
  limitationType: DiagnosisLimitationType | null;
  statement: string;
  groundingStatus: DiagnosisGroundingStatus;
  createdAt: string;
};

export type DiagnosisClaimEvidenceLink = {
  id: string;
  runId: string;
  diagnosisId: string;
  claimId: string;
  evidenceId: string;
  createdAt: string;
};

export type ProposedAction = {
  id: string;
  runId: string;
  diagnosisId: string;
  type: "CREATE_GITHUB_ISSUE";
  status:
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "REJECTED"
    | "EXECUTING"
    | "SUCCEEDED"
    | "FAILED"
    | "SUPERSEDED"
    | "CANCELLED";
  revision: number;
  supersedesProposedActionId: string | null;
  supersededAt: string | null;
  title: string;
  arguments: Record<string, unknown>;
  rationale: string;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";

export type Approval = {
  id: string;
  runId: string;
  proposedActionId: string;
  status: ApprovalStatus;
  decision: "APPROVE" | "REJECT" | null;
  reason: string | null;
  requestedBy: string;
  decidedBy: string | null;
  targetOwner: string | null;
  targetRepo: string | null;
  revision: number;
  supersedesApprovalId: string | null;
  withdrawnAt: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type AuditEventType =
  | "DIAGNOSIS_FINALIZED"
  | "PROPOSED_ACTION_CREATED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_APPROVED"
  | "APPROVAL_REJECTED"
  | "ACTION_EXECUTION_STARTED"
  | "ACTION_SUCCEEDED"
  | "ACTION_FAILED"
  | "ACTION_COMPLETION_CONFIRMED"
  | "VERIFICATION_ATTEMPT_CREATED"
  | "VERIFICATION_EVALUATION_STARTED"
  | "VERIFICATION_EVALUATED"
  | "VERIFICATION_RETRY_CREATED"
  | "VERIFICATION_REOPENED"
  | "APPROVAL_WITHDRAWN"
  | "INVESTIGATION_REOPENED"
  | "RUN_STATE_CHANGED";

export type AuditEvent = {
  id: string;
  runId: string;
  proposedActionId: string | null;
  approvalId: string | null;
  toolCallId: string | null;
  type: AuditEventType;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type ToolCallWithResult = ToolCall & { result: ToolResult | null };

export type InvestigationStopReason =
  | "MAX_ITERATIONS"
  | "MAX_TOOL_CALLS"
  | "NO_NEW_EVIDENCE"
  | "DUPLICATE_TOOL_CALL"
  | "NO_APPLICABLE_TOOL"
  | "SUFFICIENT_EVIDENCE"
  | "HUMAN_REQUESTED_FINALIZE"
  | "PLANNER_STOPPED"
  | "PLANNER_ERROR";

export type AgentIterationTrigger =
  | "INITIAL"
  | "HUMAN_MESSAGE"
  | "HUMAN_HYPOTHESIS"
  | "CONTINUE";

export type AgentIteration = {
  id: string;
  runId: string;
  sequence: number;
  trigger: AgentIterationTrigger;
  plannerType: "LLM" | "DETERMINISTIC";
  status: "RUNNING" | "COMPLETED" | "PAUSED" | "FAILED";
  decisionType: InvestigationDecisionType | null;
  publicRationale: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type InvestigationDecisionType =
  | "CREATE_HYPOTHESES"
  | "ASSESS_EVIDENCE"
  | "CALL_TOOL"
  | "ASK_HUMAN"
  | "FINALIZE"
  | "STOP_INCONCLUSIVE";

export type HypothesisStatus =
  | "ACTIVE"
  | "SUPPORTED"
  | "WEAKENED"
  | "REJECTED"
  | "CONFIRMED";

export type Hypothesis = {
  id: string;
  runId: string;
  revision: number;
  statement: string;
  supportIf: string;
  refuteIf: string;
  status: HypothesisStatus;
  confidence: Confidence;
  supportScore: number;
  contradictionScore: number;
  confidenceReason: string;
  createdBy: "AGENT" | "HUMAN";
  createdAt: string;
  updatedAt: string;
};

export type EvidenceRelation = "SUPPORTS" | "CONTRADICTS" | "NEUTRAL";

export type HypothesisEvidenceLink = {
  id: string;
  runId: string;
  hypothesisId: string;
  evidenceId: string;
  relation: EvidenceRelation;
  explanation: string;
  linkedBy: "AGENT" | "HUMAN" | "RUNTIME";
  createdAt: string;
};

export type InvestigationTraceEvent = {
  id: string;
  runId: string;
  iterationId: string | null;
  sequence: number;
  type: string;
  actor: "AGENT" | "HUMAN" | "RUNTIME" | "TOOL";
  publicSummary: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type InvestigationMessageIntent =
  | "EXPLAIN"
  | "INVESTIGATE"
  | "ADD_HYPOTHESIS"
  | "FINALIZE_REQUEST";

export type InvestigationMessage = {
  id: string;
  runId: string;
  clientRequestId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  intent: InvestigationMessageIntent;
  content: string;
  citedEvidenceIds: string[];
  createdAt: string;
};

export type DiagnosisEvidenceLink = {
  id: string;
  runId: string;
  diagnosisId: string;
  evidenceId: string;
  relationship: "VALIDATES" | "CONTEXT" | "LIMITATION";
  createdAt: string;
};

export type ApprovalSnapshot = {
  id: string;
  approvalId: string;
  runId: string;
  diagnosisId: string;
  proposedActionId: string;
  revision: number;
  frozenPayload: Record<string, unknown>;
  checksum: string;
  lifecycleStatus: "ACTIVE" | "WITHDRAWN" | "SUPERSEDED";
  createdAt: string;
  withdrawnAt: string | null;
};

export type ActionCompletion = {
  id: string;
  runId: string;
  proposedActionId: string;
  approvalId: string;
  diagnosisId: string;
  revision: number;
  clientRequestId: string;
  effectiveAt: string;
  changeReference: string;
  note: string | null;
  confirmedBy: string;
  createdAt: string;
};

export const VERIFICATION_RUN_STATUSES = [
  "PENDING",
  "WAITING_WINDOW",
  "RUNNING",
  "RESOLVED",
  "PARTIALLY_RESOLVED",
  "NOT_RECOVERED",
  "INCONCLUSIVE",
  "FAILED",
] as const;

export type VerificationRunStatus = (typeof VERIFICATION_RUN_STATUSES)[number];
export type VerificationAnchorType = "ACTION_COMPLETION" | "OBSERVE_DIAGNOSIS";

export type VerificationRun = {
  id: string;
  runId: string;
  diagnosisId: string;
  actionCompletionId: string | null;
  attempt: number;
  clientRequestId: string;
  status: VerificationRunStatus;
  anchorType: VerificationAnchorType;
  anchorAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type VerificationPolicySnapshot = {
  id: string;
  verificationRunId: string;
  runId: string;
  policyVersion: string;
  anchorAt: string;
  settlingPeriodMinutes: number;
  verificationWindowMinutes: number;
  metricKey: string;
  baselineValue: number | null;
  incidentObservedValue: number | null;
  direction: "DOWN" | "UP" | null;
  granularityMinutes: number | null;
  affectedFilters: import("../analytics/types").MetricFilters;
  controlFilters: import("../analytics/types").MetricFilters | null;
  controlBaselineValue: number | null;
  minimumSampleSize: number;
  requiredConsecutiveBuckets: number;
  metricRecoveryThreshold: number;
  minimumImprovementThreshold: number;
  feedbackTrendThreshold: number;
  feedbackRequired: boolean;
  feedbackMinimumSampleSize: number;
  createdAt: string;
};

export type VerificationEvidenceKind = "AFFECTED_METRIC" | "CONTROL_METRIC"
  | "FEEDBACK_REFERENCE" | "FEEDBACK_VERIFICATION";
export type VerificationEvidenceQuality =
  | "SUFFICIENT" | "INSUFFICIENT" | "INVALID_DATA" | "EMPTY" | "ERROR";

export type VerificationEvidence = {
  id: string;
  runId: string;
  verificationRunId: string;
  kind: VerificationEvidenceKind;
  source: string;
  query: Record<string, unknown>;
  windowStart: string;
  windowEnd: string;
  sampleSize: number;
  observedValue: number | null;
  baselineValue: number | null;
  recoveryRatio: number | null;
  qualityStatus: VerificationEvidenceQuality;
  details: Record<string, unknown>;
  provenance: string;
  createdAt: string;
};

export type VerificationOutcome = "RESOLVED" | "PARTIALLY_RESOLVED" | "NOT_RECOVERED" | "INCONCLUSIVE";

export type VerificationEvaluation = {
  id: string;
  runId: string;
  verificationRunId: string;
  clientRequestId: string;
  outcome: VerificationOutcome;
  reasonCode: string;
  result: Record<string, unknown>;
  createdAt: string;
};

export type InvestigationAggregate = {
  run: InvestigationRun;
  riskEvent: import("../analytics/types").RiskEvent | null;
  release: import("../analytics/types").Release | null;
  toolCalls: ToolCallWithResult[];
  evidence: Evidence[];
  diagnosis: Diagnosis | null;
  diagnoses: Diagnosis[];
  proposedAction: ProposedAction | null;
  proposedActions: ProposedAction[];
  approval: Approval | null;
  approvals: Approval[];
  auditEvents: AuditEvent[];
  iterations: AgentIteration[];
  hypotheses: Hypothesis[];
  hypothesisEvidenceLinks: HypothesisEvidenceLink[];
  traceEvents: InvestigationTraceEvent[];
  messages: InvestigationMessage[];
  diagnosisClaims: DiagnosisClaim[];
  diagnosisClaimEvidenceLinks: DiagnosisClaimEvidenceLink[];
  diagnosisEvidenceLinks: DiagnosisEvidenceLink[];
  approvalSnapshots: ApprovalSnapshot[];
  actionCompletions: ActionCompletion[];
  verificationRuns: VerificationRun[];
  verificationPolicySnapshots: VerificationPolicySnapshot[];
  verificationEvidence: VerificationEvidence[];
  verificationEvaluations: VerificationEvaluation[];
};

export type LegacyInvestigationResponse = {
  mode: "live" | "fixture";
  provider: string;
  model: string;
  runId: string;
  runStatus: InvestigationRunStatus;
  trace: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    output: unknown;
    status: ToolResultStatus;
    toolCallId: string;
    toolResultId: string | null;
  }>;
  conclusion: {
    root_cause: string;
    confidence: Confidence | null;
    recommendation: string;
    requires_human_approval: boolean;
    evidence_summary: string[];
    parse_status: "direct" | "repaired" | "raw" | "fixture";
    raw_conclusion: string | null;
  };
  usage?: { total_tokens?: number };
  investigation: InvestigationAggregate;
};
