import type { Phase3InvestigationStore } from "./phase3-store";
import type {
  ActionCompletion,
  AuditEvent,
  InvestigationTraceEvent,
  VerificationPolicySnapshot,
  VerificationRun,
  VerificationEvidence,
  VerificationEvaluation,
} from "./types";
import type { MetricBucket, MetricFilters } from "../analytics/types";
import type { VerificationFeedbackRecord } from "./verification-evaluator";

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

export type VerificationEvaluationCommit = {
  evaluation: VerificationEvaluation;
  evidence: VerificationEvidence[];
  auditEvents: AuditEvent[];
  traceEvent: InvestigationTraceEvent;
  expectedLockVersion: number;
  expectedVerificationAttempt: number;
};

export type VerificationReopenCommit = {
  runId: string;
  verificationRunId: string;
  clientRequestId: string;
  auditEvent: AuditEvent;
  traceEvent: InvestigationTraceEvent;
  expectedLockVersion: number;
  createdAt: string;
};

export type VerificationRetryCommit = VerificationAttemptCommit & {
  previousVerificationRunId: string;
  clientRequestId: string;
};

export interface Phase4InvestigationStore extends Phase3InvestigationStore {
  commitActionCompletion(input: ActionCompletionCommit): Promise<boolean>;
  commitVerificationAttempt(input: VerificationAttemptCommit): Promise<boolean>;
  beginVerificationEvaluation(input: {
    runId: string; verificationRunId: string; clientRequestId: string;
    expectedLockVersion: number; startedAt: string;
  }): Promise<boolean>;
  markVerificationWaitingWindow(input: {
    runId: string; verificationRunId: string; expectedLockVersion: number; updatedAt: string;
  }): Promise<boolean>;
  commitVerificationEvaluation(input: VerificationEvaluationCommit): Promise<boolean>;
  commitVerificationReopen(input: VerificationReopenCommit): Promise<boolean>;
  commitVerificationRetry(input: VerificationRetryCommit): Promise<boolean>;
  queryVerificationMetricBuckets(input: {
    metricKey: string; filters: MetricFilters; startTime: string; endTime: string;
  }): Promise<MetricBucket[]>;
  queryVerificationFeedback(input: {
    filters: MetricFilters; startTime: string; endTime: string;
  }): Promise<VerificationFeedbackRecord[]>;
}

export function isPhase4Store(
  store: Phase3InvestigationStore,
): store is Phase4InvestigationStore {
  const candidate = store as Partial<Phase4InvestigationStore>;
  return [
    candidate.commitActionCompletion,
    candidate.commitVerificationAttempt,
    candidate.beginVerificationEvaluation,
    candidate.markVerificationWaitingWindow,
    candidate.commitVerificationEvaluation,
    candidate.commitVerificationReopen,
    candidate.commitVerificationRetry,
    candidate.queryVerificationMetricBuckets,
    candidate.queryVerificationFeedback,
  ].every((method) => typeof method === "function");
}
