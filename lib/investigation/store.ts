import type {
  Approval,
  AuditEvent,
  Diagnosis,
  Evidence,
  InvestigationAggregate,
  InvestigationRun,
  InvestigationRunStatus,
  ProposedAction,
  ToolCall,
  ToolResult,
} from "./types";

export type RunTransitionPatch = {
  totalTokens?: number;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  stopReason?: InvestigationRun["stopReason"];
  currentDiagnosisRevision?: number;
  currentIteration?: number;
  activeIterationId?: string | null;
  lockVersion?: number;
};

export interface InvestigationStore {
  createRun(run: InvestigationRun): Promise<void>;
  transitionRun(
    runId: string,
    to: InvestigationRunStatus,
    patch?: RunTransitionPatch,
  ): Promise<void>;
  createToolCall(call: ToolCall): Promise<void>;
  markToolCallRunning(callId: string, startedAt: string): Promise<void>;
  completeToolCall(callId: string, result: ToolResult, completedAt: string): Promise<void>;
  saveEvidence(items: Evidence[]): Promise<void>;
  saveDiagnosis(diagnosis: Diagnosis): Promise<void>;
  saveProposedAction(action: ProposedAction): Promise<void>;
  saveApproval(approval: Approval): Promise<void>;
  saveAuditEvents(events: AuditEvent[]): Promise<void>;
  decideApproval(
    approvalId: string,
    decision: "APPROVE" | "REJECT",
    patch: {
      reason: string | null;
      decidedBy: string;
      targetOwner: string | null;
      targetRepo: string | null;
      decidedAt: string;
    },
  ): Promise<boolean>;
  updateProposedActionStatus(
    actionId: string,
    from: ProposedAction["status"],
    to: ProposedAction["status"],
  ): Promise<boolean>;
  updateActionToolCall(
    callId: string,
    from: ToolCall["status"],
    to: ToolCall["status"],
    patch?: {
      approvalId?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    },
  ): Promise<boolean>;
  completeActionToolCall(
    callId: string,
    from: ToolCall["status"],
    result: ToolResult,
    completedAt: string,
  ): Promise<boolean>;
  getAggregate(runId: string): Promise<InvestigationAggregate | null>;
  getLatestAggregate(): Promise<InvestigationAggregate | null>;
}
