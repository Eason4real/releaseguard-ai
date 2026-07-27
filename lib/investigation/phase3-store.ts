import type { InvestigationStore } from "./store";
import type {
  AgentIteration,
  ApprovalSnapshot,
  DiagnosisEvidenceLink,
  Hypothesis,
  HypothesisEvidenceLink,
  InvestigationMessage,
  InvestigationTraceEvent,
} from "./types";

export interface Phase3InvestigationStore extends InvestigationStore {
  claimIteration(iteration: AgentIteration, expectedLockVersion: number): Promise<boolean>;
  completeIteration(
    iterationId: string,
    status: AgentIteration["status"],
    decisionType: AgentIteration["decisionType"],
    publicRationale: string | null,
    completedAt: string,
  ): Promise<void>;
  saveHypotheses(items: Hypothesis[]): Promise<void>;
  updateHypothesis(item: Hypothesis): Promise<void>;
  saveHypothesisEvidenceLinks(items: HypothesisEvidenceLink[]): Promise<void>;
  saveTraceEvents(items: InvestigationTraceEvent[]): Promise<void>;
  saveMessage(message: InvestigationMessage): Promise<boolean>;
  saveDiagnosisEvidenceLinks(items: DiagnosisEvidenceLink[]): Promise<void>;
  saveApprovalSnapshot(snapshot: ApprovalSnapshot): Promise<void>;
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
