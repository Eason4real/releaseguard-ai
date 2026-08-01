import type { MetricBucket, MetricFilters } from "../../lib/analytics/types";
import type { Phase4InvestigationStore } from "../../lib/investigation/phase4-store";
import type {
  ActionCompletionCommit,
  VerificationAttemptCommit,
  VerificationEvaluationCommit,
} from "../../lib/investigation/phase4-store";
import {
  assertGroundedFinalizationCommit,
  type ModelCallReservationInput,
  type GroundedFinalizationCommit,
} from "../../lib/investigation/phase3-store";
import { MODEL_CALL_HARD_LIMIT } from "../../lib/investigation/model-call-budget";
import { assertGenericRunTransition } from "../../lib/investigation/state";
import type { RunTransitionPatch } from "../../lib/investigation/store";
import type * as T from "../../lib/investigation/types";
import type { VerificationFeedbackRecord } from "../../lib/investigation/verification-evaluator";
import type { AnalyticsStore } from "../../lib/analytics/store";
import type {
  GithubActionClaimInput,
  GithubActionDispatchInput,
  GithubActionReconciliationInput,
  GithubActionSettlementInput,
} from "../../lib/investigation/github-action-state";
import { normalizeGithubTarget } from "../../lib/investigation/github-action-state";

const copy = <V>(value: V): V => structuredClone(value);

export type LiveEvalObservability = {
  plannerStopDecision: {
    iteration: number;
    reasonCode: string;
    reason: string;
    rationale: string;
  } | null;
  guardEvents: Array<{
    eventType: "DUPLICATE_TOOL_CALL";
    iteration: number | null;
    proposedToolName: string | null;
    proposedArguments: Record<string, unknown> | null;
    proposedFingerprint: string | null;
    duplicateOfToolCallId: string | null;
    duplicateOfFingerprint: string | null;
    resolution: "REJECTED_AND_STOPPED_INCONCLUSIVE";
  }>;
  hypothesisTransitions: Array<{
    runId: string;
    iterationId: string | null;
    hypothesisId: string;
    before: Pick<T.Hypothesis, "status" | "confidence" | "supportScore" | "contradictionScore"> | null;
    after: Pick<T.Hypothesis, "status" | "confidence" | "supportScore" | "contradictionScore">;
  }>;
  finalizeAttempts: Array<{
    runId: string;
    iterationId: string;
    validationResult: "ACCEPTED" | "REJECTED";
    rejectionReason: string | null;
  }>;
};

const hypothesisState = (item: T.Hypothesis) => ({
  status: item.status,
  confidence: item.confidence,
  supportScore: item.supportScore,
  contradictionScore: item.contradictionScore,
});

export class LiveEvalStore implements Phase4InvestigationStore {
  readonly runs = new Map<string, T.InvestigationRun>();
  readonly calls = new Map<string, T.ToolCall>();
  readonly results = new Map<string, T.ToolResult>();
  readonly evidence = new Map<string, T.Evidence>();
  readonly diagnoses = new Map<string, T.Diagnosis>();
  readonly diagnosisClaims = new Map<string, T.DiagnosisClaim>();
  readonly diagnosisClaimLinks = new Map<string, T.DiagnosisClaimEvidenceLink>();
  readonly actions = new Map<string, T.ProposedAction>();
  readonly approvals = new Map<string, T.Approval>();
  readonly audits = new Map<string, T.AuditEvent>();
  readonly iterations = new Map<string, T.AgentIteration>();
  readonly hypotheses = new Map<string, T.Hypothesis>();
  readonly hypothesisLinks = new Map<string, T.HypothesisEvidenceLink>();
  readonly traces = new Map<string, T.InvestigationTraceEvent>();
  readonly messages = new Map<string, T.InvestigationMessage>();
  readonly snapshots = new Map<string, T.ApprovalSnapshot>();
  readonly actionCompletions = new Map<string, T.ActionCompletion>();
  readonly verificationRuns = new Map<string, T.VerificationRun>();
  readonly verificationPolicies = new Map<string, T.VerificationPolicySnapshot>();
  readonly verificationEvidence = new Map<string, T.VerificationEvidence>();
  readonly verificationEvaluations = new Map<string, T.VerificationEvaluation>();
  readonly commands = new Set<string>();
  readonly observability: LiveEvalObservability = {
    plannerStopDecision: null,
    guardEvents: [],
    hypothesisTransitions: [],
    finalizeAttempts: [],
  };
  verificationMetricBuckets: MetricBucket[] = [];
  verificationFeedback: VerificationFeedbackRecord[] = [];

  constructor(readonly analytics: AnalyticsStore) {}

  async createRun(run: T.InvestigationRun) { this.runs.set(run.id, copy(run)); }

  async transitionRun(runId: string, to: T.InvestigationRunStatus, patch: RunTransitionPatch = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    assertGenericRunTransition(run.status, to);
    this.runs.set(runId, { ...run, ...patch, status: to, updatedAt: new Date().toISOString() });
  }

  async createToolCall(call: T.ToolCall) { this.calls.set(call.id, copy(call)); }
  async markToolCallRunning(callId: string, startedAt: string) {
    const call = this.calls.get(callId);
    if (!call) throw new Error("Call not found");
    this.calls.set(callId, { ...call, status: "RUNNING", startedAt });
  }
  async completeToolCall(callId: string, result: T.ToolResult, completedAt: string) {
    const call = this.calls.get(callId);
    if (!call) throw new Error("Call not found");
    this.results.set(result.id, copy(result));
    this.calls.set(callId, { ...call, status: "COMPLETED", resultId: result.id, completedAt });
  }
  async saveEvidence(items: T.Evidence[]) { items.forEach((item) => this.evidence.set(item.id, copy(item))); }
  async saveAuditEvents(items: T.AuditEvent[]) { items.forEach((item) => this.audits.set(item.id, copy(item))); }
  async reserveModelCall(input: ModelCallReservationInput) {
    const run = this.runs.get(input.runId);
    if (!run) throw new Error("Run not found");
    if (run.status !== "RUNNING" || run.activeIterationId !== input.iterationId) {
      throw new Error("MODEL_CALL_RESERVATION_PRECONDITION_FAILED");
    }
    const maxModelCalls = Math.min(run.maxModelCalls, MODEL_CALL_HARD_LIMIT);
    if (run.modelCallCount >= maxModelCalls) {
      return { reserved: false as const, modelCallCount: run.modelCallCount, maxModelCalls };
    }
    const modelCallCount = run.modelCallCount + 1;
    this.runs.set(run.id, { ...run, modelCallCount, updatedAt: input.reservedAt });
    const reservation = { id: input.reservationId, ordinal: modelCallCount,
      maxModelCalls, reservedAt: input.reservedAt };
    this.audits.set(input.reservationId, {
      id: input.reservationId, runId: input.runId, proposedActionId: null,
      approvalId: null, toolCallId: null, type: "PLANNER_MODEL_CALL_RESERVED",
      actor: "ReleaseGuard Runtime", details: { reservationId: reservation.id,
        reservationOrdinal: reservation.ordinal, maxModelCalls,
        iterationId: input.iterationId, iterationSequence: input.iterationSequence,
        provider: input.provider, model: input.model, attemptIndex: input.attemptIndex },
      createdAt: input.reservedAt,
    });
    return { reserved: true as const, reservation };
  }

  async decideApproval(approvalId: string, decision: "APPROVE" | "REJECT", patch: {
    reason: string | null; decidedBy: string; targetOwner: string | null;
    targetRepo: string | null; decidedAt: string;
  }) {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== "PENDING") return false;
    this.approvals.set(approvalId, { ...approval,
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decision, ...patch });
    return true;
  }

  async updateProposedActionStatus(id: string, from: T.ProposedAction["status"], to: T.ProposedAction["status"]) {
    const item = this.actions.get(id);
    if (!item || item.status !== from) return false;
    this.actions.set(id, { ...item, status: to, updatedAt: new Date().toISOString() });
    return true;
  }
  async updateActionToolCall(id: string, from: T.ToolCall["status"], to: T.ToolCall["status"], patch: {
    approvalId?: string | null; startedAt?: string | null; completedAt?: string | null;
  } = {}) {
    const item = this.calls.get(id);
    if (!item || item.status !== from) return false;
    this.calls.set(id, { ...item, ...patch, status: to });
    return true;
  }
  async completeActionToolCall(id: string, from: T.ToolCall["status"], result: T.ToolResult, completedAt: string) {
    const item = this.calls.get(id);
    if (!item || item.status !== from) return false;
    this.results.set(result.id, copy(result));
    this.calls.set(id, { ...item, status: result.status === "SUCCESS" ? "SUCCESS" : "ERROR",
      resultId: result.id, completedAt });
    return true;
  }

  async claimGithubAction(input: GithubActionClaimInput) {
    const run = this.runs.get(input.runId);
    const action = this.actions.get(input.proposedActionId);
    const approval = this.approvals.get(input.approvalId);
    const snapshot = this.snapshots.get(input.approvalSnapshotId);
    const call = this.calls.get(input.toolCallId);
    const initial = input.mode === "INITIAL";
    const target = approval?.targetOwner && approval.targetRepo
      ? normalizeGithubTarget({ owner: approval.targetOwner, repo: approval.targetRepo }) : null;
    if (!run || run.status !== (initial ? "WAITING_APPROVAL" : "ACTION_EXECUTING")
      || run.lockVersion !== input.expectedLockVersion || run.activeIterationId
      || !action || action.status !== (initial ? "APPROVED" : "EXECUTING")
      || !approval || approval.status !== "APPROVED" || approval.decision !== "APPROVE"
      || !target || target.owner !== input.frozenTarget.owner || target.repo !== input.frozenTarget.repo
      || !snapshot || snapshot.lifecycleStatus !== "ACTIVE" || snapshot.approvalId !== approval.id
      || !call || call.status !== (initial ? "WAITING_APPROVAL" : "RUNNING")
      || (!initial && (call.executionAttemptId !== input.previousAttemptId
        || call.executionLeaseExpiresAt !== input.previousLeaseExpiresAt
        || call.externalDispatchStartedAt !== null
        || !call.executionLeaseExpiresAt || call.executionLeaseExpiresAt >= input.claimedAt))) return false;
    this.runs.set(run.id, { ...run, status: "ACTION_EXECUTING",
      lockVersion: run.lockVersion + 1, updatedAt: input.claimedAt });
    this.actions.set(action.id, { ...action, status: "EXECUTING", updatedAt: input.claimedAt });
    this.calls.set(call.id, { ...call, status: "RUNNING", approvalId: approval.id,
      executionAttemptId: input.attemptId, executionLeaseExpiresAt: input.leaseExpiresAt,
      externalDispatchStartedAt: null, startedAt: input.claimedAt, completedAt: null, resultId: null });
    this.audits.set(input.auditEvent.id, copy(input.auditEvent));
    return true;
  }

  async markGithubActionDispatchStarted(input: GithubActionDispatchInput) {
    const call = this.calls.get(input.toolCallId);
    if (!call || call.status !== "RUNNING" || call.executionAttemptId !== input.attemptId
      || call.externalDispatchStartedAt) return false;
    this.calls.set(call.id, { ...call, externalDispatchStartedAt: input.dispatchedAt });
    this.audits.set(input.auditEvent.id, copy(input.auditEvent));
    return true;
  }

  private async settleGithubAction(input: GithubActionSettlementInput, success: boolean) {
    const run = this.runs.get(input.runId);
    const action = this.actions.get(input.proposedActionId);
    const call = this.calls.get(input.toolCallId);
    if (!run || run.status !== "ACTION_EXECUTING" || !action || !call
      || !["EXECUTING", "RECONCILIATION_REQUIRED"].includes(action.status)
      || !["RUNNING", "RECONCILIATION_REQUIRED"].includes(call.status)
      || call.executionAttemptId !== input.attemptId
      || input.result.status !== (success ? "SUCCESS" : "ERROR")) return false;
    this.calls.set(call.id, { ...call, status: "COMPLETED", resultId: input.result.id,
      completedAt: input.settledAt, executionLeaseExpiresAt: null });
    this.results.set(input.result.id, copy(input.result));
    this.actions.set(action.id, { ...action, status: success ? "SUCCEEDED" : "FAILED",
      updatedAt: input.settledAt });
    this.runs.set(run.id, { ...run, status: success ? "WAITING_ACTION_COMPLETION" : "FAILED",
      errorMessage: success ? null : input.result.errorMessage,
      completedAt: success ? null : input.settledAt, updatedAt: input.settledAt });
    this.audits.set(input.auditEvent.id, copy(input.auditEvent));
    return true;
  }
  async commitGithubActionSuccess(input: GithubActionSettlementInput) {
    return this.settleGithubAction(input, true);
  }
  async commitGithubActionFailure(input: GithubActionSettlementInput) {
    return this.settleGithubAction(input, false);
  }
  async markGithubActionReconciliationRequired(input: GithubActionReconciliationInput) {
    const action = this.actions.get(input.proposedActionId);
    const call = this.calls.get(input.toolCallId);
    if (!action || !call || call.executionAttemptId !== input.attemptId
      || !["EXECUTING", "RECONCILIATION_REQUIRED"].includes(action.status)
      || !["RUNNING", "RECONCILIATION_REQUIRED"].includes(call.status)) return false;
    this.actions.set(action.id, { ...action, status: "RECONCILIATION_REQUIRED",
      updatedAt: input.observedAt });
    this.calls.set(call.id, { ...call, status: "RECONCILIATION_REQUIRED",
      executionLeaseExpiresAt: null });
    this.audits.set(input.auditEvent.id, copy(input.auditEvent));
    return true;
  }

  async claimIteration(iteration: T.AgentIteration, expectedLockVersion: number) {
    const run = this.runs.get(iteration.runId);
    if (!run || run.status !== "RUNNING" || run.lockVersion !== expectedLockVersion || run.activeIterationId) return false;
    this.runs.set(run.id, { ...run, activeIterationId: iteration.id,
      currentIteration: iteration.sequence, lockVersion: expectedLockVersion + 1,
      updatedAt: iteration.startedAt });
    this.iterations.set(iteration.id, copy(iteration));
    return true;
  }
  async completeIteration(id: string, status: T.AgentIteration["status"],
    decisionType: T.AgentIteration["decisionType"], publicRationale: string | null, completedAt: string) {
    const iteration = this.iterations.get(id);
    if (!iteration) return;
    this.iterations.set(id, { ...iteration, status, decisionType, publicRationale, completedAt });
    const run = this.runs.get(iteration.runId);
    if (run?.activeIterationId === id) this.runs.set(run.id, { ...run, activeIterationId: null, updatedAt: completedAt });
  }
  async saveHypotheses(items: T.Hypothesis[]) {
    items.forEach((item) => {
      const before = this.hypotheses.get(item.id);
      this.observability.hypothesisTransitions.push({
        runId: item.runId,
        iterationId: this.runs.get(item.runId)?.activeIterationId ?? null,
        hypothesisId: item.id,
        before: before ? hypothesisState(before) : null,
        after: hypothesisState(item),
      });
      this.hypotheses.set(item.id, copy(item));
    });
  }
  async commitEvidenceAssessment(input: { links: T.HypothesisEvidenceLink[]; hypotheses: T.Hypothesis[];
    traceEvent: T.InvestigationTraceEvent; iterationId: string; rationale: string; completedAt: string }) {
    const iteration = this.iterations.get(input.iterationId);
    const run = this.runs.get(input.traceEvent.runId);
    if (!iteration || iteration.status !== "RUNNING" || !run || run.activeIterationId !== input.iterationId) {
      throw new Error("Evidence Assessment 未持有 Run lock。");
    }
    input.links.forEach((item) => this.hypothesisLinks.set(item.id, copy(item)));
    input.hypotheses.forEach((item) => {
      const before = this.hypotheses.get(item.id);
      this.observability.hypothesisTransitions.push({
        runId: item.runId,
        iterationId: input.iterationId,
        hypothesisId: item.id,
        before: before ? hypothesisState(before) : null,
        after: hypothesisState(item),
      });
      this.hypotheses.set(item.id, copy(item));
    });
    this.traces.set(input.traceEvent.id, copy(input.traceEvent));
    await this.completeIteration(input.iterationId, "COMPLETED", "ASSESS_EVIDENCE", input.rationale, input.completedAt);
  }
  async commitHumanHypothesis(input: { hypothesis: T.Hypothesis; message: T.InvestigationMessage;
    traceEvent: T.InvestigationTraceEvent; iterationId: string; completedAt: string }) {
    this.hypotheses.set(input.hypothesis.id, copy(input.hypothesis));
    this.messages.set(input.message.id, copy(input.message));
    this.traces.set(input.traceEvent.id, copy(input.traceEvent));
    await this.completeIteration(input.iterationId, "COMPLETED", "CREATE_HYPOTHESES", "Human hypothesis", input.completedAt);
  }
  async saveTraceEvents(items: T.InvestigationTraceEvent[]) { items.forEach((item) => this.traces.set(item.id, copy(item))); }
  async saveMessage(item: T.InvestigationMessage) {
    if ([...this.messages.values()].some((value) => value.runId === item.runId
      && value.clientRequestId === item.clientRequestId)) return false;
    this.messages.set(item.id, copy(item)); return true;
  }

  async finalizeGroundedInvestigation(input: GroundedFinalizationCommit) {
    const attempt: LiveEvalObservability["finalizeAttempts"][number] = {
      runId: input.runId,
      iterationId: input.iterationId,
      validationResult: "REJECTED",
      rejectionReason: null,
    };
    this.observability.finalizeAttempts.push(attempt);
    try {
      assertGroundedFinalizationCommit(input);
      const run = this.runs.get(input.runId);
      const iteration = this.iterations.get(input.iterationId);
      const selected = this.hypotheses.get(input.selectedHypothesis.id);
      if (!run || run.status !== "RUNNING" || run.activeIterationId !== input.iterationId
        || run.lockVersion !== input.expectedLockVersion || run.currentDiagnosisRevision !== input.expectedDiagnosisRevision
        || !iteration || iteration.status !== "RUNNING" || !selected
        || selected.status !== input.selectedHypothesis.status || selected.confidence !== input.selectedHypothesis.confidence
        || selected.updatedAt !== input.selectedHypothesis.updatedAt) throw new Error("FINALIZATION_PRECONDITION_FAILED");
      this.diagnoses.set(input.diagnosis.id, copy(input.diagnosis));
      input.claims.forEach((item) => this.diagnosisClaims.set(item.id, copy(item)));
      input.claimEvidenceLinks.forEach((item) => this.diagnosisClaimLinks.set(item.id, copy(item)));
      if (input.proposedAction) this.actions.set(input.proposedAction.id, copy(input.proposedAction));
      if (input.approval) this.approvals.set(input.approval.id, copy(input.approval));
      if (input.approvalSnapshot) this.snapshots.set(input.approvalSnapshot.id, copy(input.approvalSnapshot));
      if (input.actionToolCall) this.calls.set(input.actionToolCall.id, copy(input.actionToolCall));
      input.auditEvents.forEach((item) => this.audits.set(item.id, copy(item)));
      this.traces.set(input.traceEvent.id, copy(input.traceEvent));
      this.iterations.set(iteration.id, { ...iteration, status: "COMPLETED", decisionType: "FINALIZE",
        publicRationale: input.publicRationale, completedAt: input.completedAt });
      this.runs.set(run.id, { ...run, status: input.targetRunStatus, activeIterationId: null,
        lockVersion: input.expectedLockVersion + 1, currentDiagnosisRevision: input.diagnosis.revision,
        totalTokens: input.totalTokens, completedAt: null, updatedAt: input.completedAt });
      attempt.validationResult = "ACCEPTED";
    } catch (error) {
      attempt.rejectionReason = error instanceof Error ? error.message : "FINALIZATION_REJECTED";
      throw error;
    }
  }

  getObservability(runId: string): LiveEvalObservability {
    return copy({
      plannerStopDecision: this.observability.plannerStopDecision,
      guardEvents: this.observability.guardEvents.filter(() => true),
      hypothesisTransitions: this.observability.hypothesisTransitions.filter((item) =>
        item.runId === runId),
      finalizeAttempts: this.observability.finalizeAttempts.filter((item) => item.runId === runId),
    });
  }

  async recordRuntimeCommand(input: { runId: string; clientRequestId: string; commandType: string }) {
    const key = `${input.runId}:${input.commandType}:${input.clientRequestId}`;
    if (this.commands.has(key)) return false; this.commands.add(key); return true;
  }
  async withdrawPendingRevision() { return false; }

  async commitActionCompletion(input: ActionCompletionCommit) {
    const run = this.runs.get(input.completion.runId);
    if (!run || run.status !== "WAITING_ACTION_COMPLETION" || run.lockVersion !== input.expectedLockVersion) return false;
    this.actionCompletions.set(input.completion.id, copy(input.completion));
    input.auditEvents.forEach((item) => this.audits.set(item.id, copy(item)));
    this.traces.set(input.traceEvent.id, copy(input.traceEvent));
    this.runs.set(run.id, { ...run, status: "WAITING_VERIFICATION", lockVersion: run.lockVersion + 1,
      activeIterationId: null, completedAt: null, updatedAt: input.completion.createdAt });
    return true;
  }
  async commitVerificationAttempt(input: VerificationAttemptCommit) {
    const run = this.runs.get(input.verificationRun.runId);
    if (!run || run.status !== "WAITING_VERIFICATION" || run.lockVersion !== input.expectedLockVersion
      || run.currentDiagnosisRevision !== input.expectedDiagnosisRevision) return false;
    this.verificationRuns.set(input.verificationRun.id, copy(input.verificationRun));
    this.verificationPolicies.set(input.policySnapshot.id, copy(input.policySnapshot));
    this.audits.set(input.auditEvent.id, copy(input.auditEvent));
    this.traces.set(input.traceEvent.id, copy(input.traceEvent));
    this.runs.set(run.id, { ...run, lockVersion: run.lockVersion + 1, updatedAt: input.verificationRun.createdAt });
    return true;
  }
  async markVerificationWaitingWindow(input: { runId: string; verificationRunId: string;
    expectedLockVersion: number; updatedAt: string }) {
    const run = this.runs.get(input.runId); const item = this.verificationRuns.get(input.verificationRunId);
    if (!run || run.lockVersion !== input.expectedLockVersion || !item) return false;
    this.verificationRuns.set(item.id, { ...item, status: "WAITING_WINDOW", updatedAt: input.updatedAt }); return true;
  }
  async beginVerificationEvaluation(input: { runId: string; verificationRunId: string;
    clientRequestId: string; expectedLockVersion: number; startedAt: string }) {
    const run = this.runs.get(input.runId); const item = this.verificationRuns.get(input.verificationRunId);
    if (!run || run.status !== "WAITING_VERIFICATION" || run.lockVersion !== input.expectedLockVersion || !item) return false;
    this.verificationRuns.set(item.id, { ...item, status: "RUNNING", updatedAt: input.startedAt });
    this.runs.set(run.id, { ...run, status: "VERIFYING",
      activeIterationId: `VERIFICATION_EVALUATION:${item.id}:${input.clientRequestId}`,
      lockVersion: run.lockVersion + 1, updatedAt: input.startedAt }); return true;
  }
  async commitVerificationEvaluation(input: VerificationEvaluationCommit) {
    const run = this.runs.get(input.evaluation.runId);
    const item = this.verificationRuns.get(input.evaluation.verificationRunId);
    const guard = `VERIFICATION_EVALUATION:${input.evaluation.verificationRunId}:${input.evaluation.clientRequestId}`;
    if (!run || run.status !== "VERIFYING" || run.activeIterationId !== guard
      || run.lockVersion !== input.expectedLockVersion || !item || item.status !== "RUNNING") return false;
    this.verificationEvaluations.set(input.evaluation.verificationRunId, copy(input.evaluation));
    input.evidence.forEach((value) => this.verificationEvidence.set(value.id, copy(value)));
    input.auditEvents.forEach((value) => this.audits.set(value.id, copy(value)));
    this.traces.set(input.traceEvent.id, copy(input.traceEvent));
    this.verificationRuns.set(item.id, { ...item, status: input.evaluation.outcome,
      completedAt: input.evaluation.createdAt, updatedAt: input.evaluation.createdAt });
    const status = input.evaluation.outcome === "INCONCLUSIVE" ? "VERIFICATION_INCONCLUSIVE" : input.evaluation.outcome;
    this.runs.set(run.id, { ...run, status, activeIterationId: null, lockVersion: run.lockVersion + 1,
      completedAt: input.evaluation.createdAt, updatedAt: input.evaluation.createdAt }); return true;
  }
  async commitVerificationReopen() { return false; }
  async commitVerificationRetry() { return false; }
  async queryVerificationMetricBuckets(input: { metricKey: string; filters: MetricFilters;
    startTime: string; endTime: string }) {
    return copy(this.verificationMetricBuckets.filter((item) => item.metricKey === input.metricKey));
  }
  async queryVerificationFeedback() { return copy(this.verificationFeedback); }

  async getAggregate(runId: string): Promise<T.InvestigationAggregate | null> {
    const run = this.runs.get(runId); if (!run) return null;
    const calls = [...this.calls.values()].filter((item) => item.runId === runId)
      .sort((a, b) => a.order - b.order).map((item) => ({ ...copy(item),
        result: item.resultId ? copy(this.results.get(item.resultId) ?? null) : null }));
    const diagnoses = [...this.diagnoses.values()].filter((item) => item.runId === runId).sort((a, b) => a.revision - b.revision);
    const actions = [...this.actions.values()].filter((item) => item.runId === runId).sort((a, b) => a.revision - b.revision);
    const approvals = [...this.approvals.values()].filter((item) => item.runId === runId).sort((a, b) => a.revision - b.revision);
    const [riskEvent, release] = await Promise.all([run.riskEventId ? this.analytics.getRiskEvent(run.riskEventId) : null,
      run.releaseId ? this.analytics.getRelease(run.releaseId) : null]);
    const values = <V extends { runId: string }>(map: Map<string, V>) => copy([...map.values()].filter((item) => item.runId === runId));
    return { run: copy(run), riskEvent: copy(riskEvent), release: copy(release), toolCalls: calls,
      evidence: values(this.evidence), diagnosis: copy(diagnoses.at(-1) ?? null), diagnoses: copy(diagnoses),
      proposedAction: copy(actions.at(-1) ?? null), proposedActions: copy(actions),
      approval: copy(approvals.at(-1) ?? null), approvals: copy(approvals), auditEvents: values(this.audits),
      iterations: values(this.iterations).sort((a, b) => a.sequence - b.sequence), hypotheses: values(this.hypotheses),
      hypothesisEvidenceLinks: values(this.hypothesisLinks), traceEvents: values(this.traces).sort((a, b) => a.sequence - b.sequence),
      messages: values(this.messages), diagnosisClaims: values(this.diagnosisClaims),
      diagnosisClaimEvidenceLinks: values(this.diagnosisClaimLinks), diagnosisEvidenceLinks: [],
      approvalSnapshots: values(this.snapshots), actionCompletions: values(this.actionCompletions),
      verificationRuns: values(this.verificationRuns), verificationPolicySnapshots: values(this.verificationPolicies),
      verificationEvidence: values(this.verificationEvidence), verificationEvaluations: values(this.verificationEvaluations) };
  }
  async getLatestAggregate() {
    const latest = [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? this.getAggregate(latest.id) : null;
  }
}
