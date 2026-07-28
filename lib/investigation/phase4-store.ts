import type { Phase3InvestigationStore } from "./phase3-store";
import type {
  ActionCompletion,
  AuditEvent,
  InvestigationTraceEvent,
  VerificationPolicySnapshot,
  VerificationRun,
} from "./types";

export type ActionCompletionCommit = {
  completion: ActionCompletion;
  expectedLockVersion: number;
  expectedActionCompletedAt: string;
  auditEvents: AuditEvent[];
  traceEvent: InvestigationTraceEvent;
};

export type VerificationAttemptCommit = {
  verificationRun: VerificationRun;
  policySnapshot: VerificationPolicySnapshot;
  expectedLockVersion: number;
  expectedDiagnosisRevision: number;
  auditEvent: AuditEvent;
  traceEvent: InvestigationTraceEvent;
};

export interface Phase4InvestigationStore extends Phase3InvestigationStore {
  commitActionCompletion(input: ActionCompletionCommit): Promise<boolean>;
  commitVerificationAttempt(input: VerificationAttemptCommit): Promise<boolean>;
}

export function isPhase4Store(
  store: Phase3InvestigationStore,
): store is Phase4InvestigationStore {
  return "commitActionCompletion" in store
    && typeof store.commitActionCompletion === "function"
    && "commitVerificationAttempt" in store
    && typeof store.commitVerificationAttempt === "function";
}
