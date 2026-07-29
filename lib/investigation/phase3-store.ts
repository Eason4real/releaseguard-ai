import type { InvestigationStore } from "./store";
import type {
  Approval,
  AgentIteration,
  AuditEvent,
  ApprovalSnapshot,
  Diagnosis,
  DiagnosisClaim,
  DiagnosisClaimEvidenceLink,
  Hypothesis,
  HypothesisEvidenceLink,
  InvestigationMessage,
  InvestigationTraceEvent,
  ProposedAction,
  ToolCall,
} from "./types";
import type { ModelCallReservationResult } from "./model-call-budget";

export type ModelCallReservationInput = {
  reservationId: string;
  runId: string;
  iterationId: string;
  iterationSequence: number;
  provider: string;
  model: string;
  attemptIndex: number;
  reservedAt: string;
};

export type GroundedFinalizationCommit = {
  runId: string;
  iterationId: string;
  expectedLockVersion: number;
  expectedDiagnosisRevision: number;
  selectedHypothesis: Pick<
    Hypothesis,
    "id" | "status" | "confidence" | "updatedAt"
  >;
  diagnosis: Diagnosis;
  claims: DiagnosisClaim[];
  claimEvidenceLinks: DiagnosisClaimEvidenceLink[];
  proposedAction: ProposedAction | null;
  approval: Approval | null;
  approvalSnapshot: ApprovalSnapshot | null;
  actionToolCall: ToolCall | null;
  auditEvents: AuditEvent[];
  traceEvent: InvestigationTraceEvent;
  targetRunStatus: "WAITING_APPROVAL" | "WAITING_VERIFICATION";
  totalTokens: number;
  publicRationale: string;
  completedAt: string;
};

export function assertGroundedFinalizationCommit(input: GroundedFinalizationCommit) {
  if (
    !["SUPPORTED", "CONFIRMED"].includes(input.selectedHypothesis.status)
    || !["MEDIUM", "HIGH"].includes(input.selectedHypothesis.confidence)
    || input.diagnosis.confidence !== input.selectedHypothesis.confidence
  ) {
    throw new Error("INVALID_FINALIZATION_HYPOTHESIS: FINALIZE 必须引用服务端可 Finalize 的 Hypothesis。");
  }
  const observesWithoutAction = input.diagnosis.disposition === "OBSERVE"
    && input.targetRunStatus === "WAITING_VERIFICATION";
  const actsWithApproval = input.diagnosis.disposition !== "OBSERVE"
    && input.targetRunStatus === "WAITING_APPROVAL";
  if (!observesWithoutAction && !actsWithApproval) {
    throw new Error("INVALID_FINALIZATION_DISPOSITION: disposition 与 Run target 不一致。");
  }
  const actionParts = [
    input.proposedAction,
    input.approval,
    input.approvalSnapshot,
    input.actionToolCall,
  ];
  const hasCompleteAction = actionParts.every(Boolean);
  const hasNoAction = actionParts.every((item) => item === null);
  if (!hasCompleteAction && !hasNoAction) {
    throw new Error("INVALID_FINALIZATION_ACTION_GRAPH: Action、Approval、Snapshot 和 ToolCall 必须同时存在或同时为空。");
  }
  if (input.targetRunStatus === "WAITING_APPROVAL" && !hasCompleteAction) {
    throw new Error("INVALID_FINALIZATION_TARGET: WAITING_APPROVAL 必须包含完整审批对象。");
  }
  if (input.targetRunStatus === "WAITING_VERIFICATION" && !hasNoAction) {
    throw new Error("INVALID_FINALIZATION_TARGET: OBSERVE 进入 WAITING_VERIFICATION 时不得创建外部写 Action。");
  }
  if (input.diagnosis.revision !== input.expectedDiagnosisRevision + 1) {
    throw new Error("STALE_DIAGNOSIS_REVISION: Diagnosis revision 必须连续递增。");
  }
  if (
    input.diagnosis.runId !== input.runId
    || input.diagnosis.selectedHypothesisId !== input.selectedHypothesis.id
    || input.claims.length === 0
    || input.traceEvent.runId !== input.runId
    || input.traceEvent.iterationId !== input.iterationId
  ) {
    throw new Error("INVALID_FINALIZATION_GRAPH: FINALIZE 对象不属于同一 Run/Iteration。");
  }
  if (input.claims.some((claim) =>
    claim.runId !== input.runId || claim.diagnosisId !== input.diagnosis.id)) {
    throw new Error("INVALID_FINALIZATION_CLAIMS: DiagnosisClaim reference 不一致。");
  }
  if (input.auditEvents.length === 0 || input.auditEvents.some((event) =>
    event.runId !== input.runId)) {
    throw new Error("INVALID_FINALIZATION_AUDIT: FINALIZE audit reference 不一致。");
  }
  const claimIds = new Set(input.claims.map((claim) => claim.id));
  if (input.claimEvidenceLinks.some((link) =>
    link.runId !== input.runId
    || link.diagnosisId !== input.diagnosis.id
    || !claimIds.has(link.claimId))) {
    throw new Error("INVALID_FINALIZATION_CLAIM_LINKS: Claim Evidence Link reference 不一致。");
  }
  if (input.proposedAction && (
    input.proposedAction.runId !== input.runId
    || input.proposedAction.diagnosisId !== input.diagnosis.id
    || input.proposedAction.revision !== input.diagnosis.revision
  )) throw new Error("INVALID_FINALIZATION_ACTION: ProposedAction reference 不一致。");
  if (input.approval && (
    input.approval.runId !== input.runId
    || input.approval.proposedActionId !== input.proposedAction?.id
    || input.approval.revision !== input.diagnosis.revision
  )) throw new Error("INVALID_FINALIZATION_APPROVAL: Approval reference 不一致。");
  if (input.approvalSnapshot && (
    input.approvalSnapshot.runId !== input.runId
    || input.approvalSnapshot.diagnosisId !== input.diagnosis.id
    || input.approvalSnapshot.proposedActionId !== input.proposedAction?.id
    || input.approvalSnapshot.approvalId !== input.approval?.id
    || input.approvalSnapshot.revision !== input.diagnosis.revision
  )) throw new Error("INVALID_FINALIZATION_SNAPSHOT: ApprovalSnapshot reference 不一致。");
  if (input.actionToolCall && (
    input.actionToolCall.runId !== input.runId
    || input.actionToolCall.proposedActionId !== input.proposedAction?.id
    || input.actionToolCall.approvalId !== input.approval?.id
  )) throw new Error("INVALID_FINALIZATION_TOOL_CALL: Action ToolCall reference 不一致。");
}

export interface Phase3InvestigationStore extends InvestigationStore {
  reserveModelCall(input: ModelCallReservationInput): Promise<ModelCallReservationResult>;
  claimIteration(iteration: AgentIteration, expectedLockVersion: number): Promise<boolean>;
  completeIteration(
    iterationId: string,
    status: AgentIteration["status"],
    decisionType: AgentIteration["decisionType"],
    publicRationale: string | null,
    completedAt: string,
  ): Promise<void>;
  saveHypotheses(items: Hypothesis[]): Promise<void>;
  commitEvidenceAssessment(input: {
    links: HypothesisEvidenceLink[];
    hypotheses: Hypothesis[];
    traceEvent: InvestigationTraceEvent;
    iterationId: string;
    rationale: string;
    completedAt: string;
  }): Promise<void>;
  commitHumanHypothesis(input: {
    hypothesis: Hypothesis;
    message: InvestigationMessage;
    traceEvent: InvestigationTraceEvent;
    iterationId: string;
    completedAt: string;
  }): Promise<void>;
  saveTraceEvents(items: InvestigationTraceEvent[]): Promise<void>;
  saveMessage(message: InvestigationMessage): Promise<boolean>;
  finalizeGroundedInvestigation(input: GroundedFinalizationCommit): Promise<void>;
  recordRuntimeCommand(input: {
    id: string;
    runId: string;
    clientRequestId: string;
    commandType: string;
    resultReference: string | null;
    createdAt: string;
  }): Promise<boolean>;
  withdrawPendingRevision(input: {
    runId: string;
    approvalId: string;
    proposedActionId: string;
    actionToolCallId: string;
    snapshotId: string | null;
    now: string;
  }): Promise<boolean>;
}

export function isPhase3Store(store: InvestigationStore): store is Phase3InvestigationStore {
  return "claimIteration" in store && typeof store.claimIteration === "function";
}
