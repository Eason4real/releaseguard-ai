export const PUBLIC_DEMO_REPLAY_MODES = ["NORMAL", "FAULT_INJECTION"] as const;
export type PublicDemoReplayMode = (typeof PUBLIC_DEMO_REPLAY_MODES)[number];

export const PUBLIC_DEMO_REPLAY_STAGES = [
  "IDLE",
  "DETECTED",
  "INVESTIGATING",
  "WAITING_APPROVAL",
  "APPROVED",
  "ACTION_SIMULATED",
  "ACTION_COMPLETED",
  "VERIFIED",
] as const;
export type PublicDemoReplayStage = (typeof PUBLIC_DEMO_REPLAY_STAGES)[number];

export type PublicDemoDecisionType =
  | "CREATE_HYPOTHESES"
  | "CALL_TOOL"
  | "ASSESS_EVIDENCE"
  | "FINALIZE";

export type PublicDemoDecisionStatus = "ACCEPTED" | "REJECTED" | "REPAIRED";
export type PublicDemoHypothesisStatus =
  | "ACTIVE"
  | "SUPPORTED"
  | "WEAKENED"
  | "REJECTED"
  | "SELECTED";
export type PublicDemoEvidenceRelation = "SUPPORTS" | "CONTRADICTS" | "NEUTRAL";

export type PublicDemoBudget = {
  modelCallsUsed: number;
  maxModelCalls: number;
  toolCallsUsed: number;
  maxToolCalls: number;
  iterationsUsed: number;
  maxIterations: number;
};

export type PublicDemoValidation = {
  schema: "VALID" | "INVALID";
  semantic: "VALID" | "INVALID" | "NOT_RUN";
  errorType: "PlannerDecisionValidationError" | "PlannerDecisionSemanticError" | null;
  code: string | null;
  path: string | null;
};

export type PublicDemoDecision = {
  type: PublicDemoDecisionType;
  status: PublicDemoDecisionStatus;
  plannerState: "ACCEPTED" | "REJECTED" | "REPAIRED";
  modelCallOrdinal: number;
  repairAttempt: 0 | 1;
  serverSummary: string;
  publicRationale: string;
  validation: PublicDemoValidation;
};

export type PublicDemoToolCall = {
  name: "get_release" | "segment_metric" | "search_user_feedback";
  status: "SUCCESS";
  argumentsSummary: string;
  resultSummary: string;
};

export type PublicDemoHypothesis = {
  id: "H1" | "H2" | "H3";
  statement: string;
  supportIf: string;
  refuteIf: string;
  status: PublicDemoHypothesisStatus;
};

export type PublicDemoEvidence = {
  id: "E-RELEASE" | "E-SEGMENT" | "E-FEEDBACK";
  title: string;
  observation: string;
  sourceTool: PublicDemoToolCall["name"];
  provenance: "DETERMINISTIC_FIXTURE";
};

export type PublicDemoEvidenceLink = {
  evidenceId: PublicDemoEvidence["id"];
  targetHypothesisId: PublicDemoHypothesis["id"];
  relation: PublicDemoEvidenceRelation;
  explanation: string;
};

export type PublicDemoAuditKind =
  | "RISK_DETECTED"
  | "PLANNER_RESPONSE_OBSERVED"
  | "DECISION_VALIDATED"
  | "DECISION_REJECTED"
  | "DECISION_ACCEPTED"
  | "REPAIR_ATTEMPTED"
  | "TOOL_CALL_STARTED"
  | "TOOL_RESULT_RECORDED"
  | "EVIDENCE_CREATED"
  | "EVIDENCE_ASSESSED"
  | "DIAGNOSIS_CREATED"
  | "APPROVAL_GRANTED"
  | "ACTION_SIMULATED"
  | "ACTION_COMPLETED"
  | "VERIFICATION_COMPLETED";

export type PublicDemoAuditEvent = {
  id: string;
  kind: PublicDemoAuditKind;
  label: string;
  source: "REPLAY_FIXTURE" | "DEMO_OPERATOR";
  offsetSeconds: number;
  tieBreaker: number;
  status: "OBSERVED" | "VALID" | "ACCEPTED" | "REJECTED" | "SUCCESS";
};

export type PublicDemoReplayStep = {
  id: string;
  sequence: number;
  stage: PublicDemoReplayStage;
  phase: string;
  title: string;
  summary: string;
  iteration: number | null;
  decision: PublicDemoDecision | null;
  budget: PublicDemoBudget;
  toolCall: PublicDemoToolCall | null;
  hypothesisUpdates: PublicDemoHypothesis[];
  evidenceCreated: PublicDemoEvidence[];
  relationUpdates: PublicDemoEvidenceLink[];
  businessObjects: string[];
  outcome: {
    diagnosis?: PublicDemoDiagnosis;
    approvalGranted?: true;
    workItemReference?: string;
    actionCompleted?: true;
    verificationRate?: string;
  };
  auditEvents: PublicDemoAuditEvent[];
};

export type PublicDemoDiagnosis = {
  selectedHypothesisId: PublicDemoHypothesis["id"];
  confidence: "HIGH";
  rootCause: string;
  causalChain: string;
  proposedAction: string;
};

export type PublicDemoReplayState = {
  mode: PublicDemoReplayMode;
  cursor: number;
  playback: "PAUSED" | "PLAYING";
};

export type PublicDemoReplayAction =
  | { type: "NEXT" }
  | { type: "PREVIOUS" }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "RESET" }
  | { type: "SET_MODE"; mode: PublicDemoReplayMode };

export type PublicDemoReplaySnapshot = {
  stage: PublicDemoReplayStage;
  currentStep: PublicDemoReplayStep | null;
  steps: readonly PublicDemoReplayStep[];
  hypotheses: PublicDemoHypothesis[];
  evidence: PublicDemoEvidence[];
  relations: PublicDemoEvidenceLink[];
  auditEvents: PublicDemoAuditEvent[];
  diagnosis: PublicDemoDiagnosis | null;
  approvalGranted: boolean;
  workItemReference: string | null;
  actionCompleted: boolean;
  verificationRate: string | null;
};
