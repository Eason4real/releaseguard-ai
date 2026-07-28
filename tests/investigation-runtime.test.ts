import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import * as dbSchema from "../db/schema";
import { investigationRuntimeSchema } from "../db/runtime-schema";
import "./risk-detection.test";
import "./analytics-tools.test";
import "./retrieval.test";
import "./phase4-scenarios.test";
import "./phase4-agent-benchmark.test";
import "./phase4-ui.test";
import "./hypothesis-confidence.test";
import "./verification-evaluator.test";
import {
  decideProposedAction,
  executeApprovedGithubAction,
  RuntimeRequestError,
} from "../lib/investigation/action-runtime";
import {
  executeAndRecordTool,
  startInvestigation,
} from "../lib/investigation/runtime";
import { runFixtureInvestigation } from "../lib/investigation/fixture-runtime";
import { runAgentLoop } from "../lib/investigation/agent-loop";
import type {
  InvestigationDecision,
  InvestigationPlanner,
  PlannerContext,
} from "../lib/investigation/planner";
import {
  assertGenericRunTransition,
  assertRunTransition,
} from "../lib/investigation/state";
import { POST as githubIssueRoute } from "../app/api/github-issue/route";
import { handleInvestigatePost } from "../app/api/investigate/route";
import type { RunTransitionPatch } from "../lib/investigation/store";
import {
  assertGroundedFinalizationCommit,
  type GroundedFinalizationCommit,
} from "../lib/investigation/phase3-store";
import type {
  ActionCompletionCommit,
  Phase4InvestigationStore,
  VerificationAttemptCommit,
  VerificationEvaluationCommit,
  VerificationReopenCommit,
  VerificationRetryCommit,
} from "../lib/investigation/phase4-store";
import type {
  Approval,
  AuditEvent,
  Diagnosis,
  DiagnosisClaim,
  DiagnosisClaimEvidenceLink,
  Evidence,
  InvestigationAggregate,
  InvestigationRun,
  InvestigationRunStatus,
  ProposedAction,
  ToolCall,
  ToolResult,
  AgentIteration,
  ApprovalSnapshot,
  ActionCompletion,
  DiagnosisEvidenceLink,
  Hypothesis,
  HypothesisEvidenceLink,
  InvestigationMessage,
  InvestigationTraceEvent,
  VerificationPolicySnapshot,
  VerificationRun,
  VerificationEvidence,
  VerificationEvaluation,
} from "../lib/investigation/types";
import type { MetricFilters } from "../lib/analytics/types";
import type { VerificationFeedbackRecord } from "../lib/investigation/verification-evaluator";
import {
  ensureAndroid730RiskEvent,
  MemoryAnalyticsStore,
} from "../lib/fixtures/android-730";
import { continueInvestigation } from "../lib/investigation/revision-runtime";
import { submitInvestigationMessage } from "../lib/investigation/chat-runtime";
import { DeterministicInvestigationPlanner } from "../lib/investigation/deterministic-planner";
import { LLMInvestigationPlanner } from "../lib/investigation/llm-planner";
import { D1InvestigationStore } from "../lib/investigation/repository";
import {
  InMemoryFeedbackRetriever,
  InMemoryIncidentRetriever,
} from "../lib/retrieval/local-retrievers";
import { calculateHypothesisConfidence } from "../lib/investigation/confidence";
import {
  confirmActionCompletion,
  createVerificationAttempt,
  evaluateVerificationAttempt,
  listVerificationHistory,
  reopenAfterVerification,
  retryVerificationAttempt,
} from "../lib/investigation/verification-runtime";
import { handleActionCompletionPost } from "../app/api/investigations/[runId]/action-completion/route";
import {
  handleVerificationGet,
  handleVerificationPost,
} from "../app/api/investigations/[runId]/verifications/route";
import { handleVerificationEvaluatePost } from
  "../app/api/investigations/[runId]/verifications/[verificationRunId]/evaluate/route";

class MemoryStore implements Phase4InvestigationStore {
  analytics = new MemoryAnalyticsStore();
  runs = new Map<string, InvestigationRun>();
  calls = new Map<string, ToolCall>();
  results = new Map<string, ToolResult>();
  evidence = new Map<string, Evidence>();
  diagnoses = new Map<string, Diagnosis>();
  diagnosisClaims = new Map<string, DiagnosisClaim>();
  diagnosisClaimLinks = new Map<string, DiagnosisClaimEvidenceLink>();
  actions = new Map<string, ProposedAction>();
  approvals = new Map<string, Approval>();
  audits = new Map<string, AuditEvent>();
  iterations = new Map<string, AgentIteration>();
  hypotheses = new Map<string, Hypothesis>();
  hypothesisLinks = new Map<string, HypothesisEvidenceLink>();
  traces = new Map<string, InvestigationTraceEvent>();
  messages = new Map<string, InvestigationMessage>();
  diagnosisLinks = new Map<string, DiagnosisEvidenceLink>();
  snapshots = new Map<string, ApprovalSnapshot>();
  actionCompletions = new Map<string, ActionCompletion>();
  verificationRuns = new Map<string, VerificationRun>();
  verificationPolicies = new Map<string, VerificationPolicySnapshot>();
  verificationEvidence = new Map<string, VerificationEvidence>();
  verificationEvaluations = new Map<string, VerificationEvaluation>();
  verificationFeedback: VerificationFeedbackRecord[] = [];
  commands = new Set<string>();
  failNextEvidenceAssessmentCommit = false;
  failNextVerificationEvaluationCommit = false;
  lastGroundedFinalizationInput: GroundedFinalizationCommit | null = null;
  lastActionCompletionInput: ActionCompletionCommit | null = null;
  lastVerificationAttemptInput: VerificationAttemptCommit | null = null;
  lastVerificationEvaluationInput: VerificationEvaluationCommit | null = null;
  lastVerificationReopenInput: VerificationReopenCommit | null = null;
  lastVerificationRetryInput: VerificationRetryCommit | null = null;
  failNextGroundedFinalizationAt: null | "DIAGNOSIS" | "ACTION" | "APPROVAL"
    | "SNAPSHOT" | "TOOL_CALL" | "AUDIT" | "RUN_TRANSITION" = null;

  async createRun(run: InvestigationRun) {
    this.runs.set(run.id, structuredClone(run));
  }

  async transitionRun(runId: string, to: InvestigationRunStatus, patch: RunTransitionPatch = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    assertGenericRunTransition(run.status, to);
    const now = new Date().toISOString();
    this.runs.set(runId, { ...run, ...patch, status: to, updatedAt: now });
    const event: AuditEvent = {
      id: `AE-${crypto.randomUUID()}`,
      runId,
      proposedActionId: null,
      approvalId: null,
      toolCallId: null,
      type: "RUN_STATE_CHANGED",
      actor: "ReleaseGuard Runtime",
      details: { from: run.status, to },
      createdAt: now,
    };
    this.audits.set(event.id, event);
  }

  async createToolCall(call: ToolCall) {
    this.calls.set(call.id, structuredClone(call));
  }

  async markToolCallRunning(callId: string, startedAt: string) {
    const call = this.calls.get(callId);
    if (!call) throw new Error("Call not found");
    this.calls.set(callId, { ...call, status: "RUNNING", startedAt });
  }

  async completeToolCall(callId: string, result: ToolResult, completedAt: string) {
    const call = this.calls.get(callId);
    if (!call) throw new Error("Call not found");
    this.results.set(result.id, structuredClone(result));
    this.calls.set(callId, {
      ...call,
      status: "COMPLETED",
      resultId: result.id,
      completedAt,
    });
  }

  async saveEvidence(items: Evidence[]) {
    items.forEach((item) => this.evidence.set(item.id, structuredClone(item)));
  }

  async finalizeGroundedInvestigation(input: GroundedFinalizationCommit) {
    assertGroundedFinalizationCommit(input);
    const run = this.runs.get(input.runId);
    const iteration = this.iterations.get(input.iterationId);
    const selectedHypothesis = this.hypotheses.get(input.selectedHypothesis.id);
    if (
      !run
      || run.status !== "RUNNING"
      || run.activeIterationId !== input.iterationId
      || run.lockVersion !== input.expectedLockVersion
      || run.currentDiagnosisRevision !== input.expectedDiagnosisRevision
      || !iteration
      || iteration.runId !== input.runId
      || iteration.status !== "RUNNING"
      || !selectedHypothesis
      || selectedHypothesis.runId !== input.runId
      || selectedHypothesis.status !== input.selectedHypothesis.status
      || selectedHypothesis.confidence !== input.selectedHypothesis.confidence
      || selectedHypothesis.updatedAt !== input.selectedHypothesis.updatedAt
    ) throw new Error("FINALIZATION_PRECONDITION_FAILED");

    const staged = {
      diagnoses: structuredClone(this.diagnoses),
      diagnosisClaims: structuredClone(this.diagnosisClaims),
      diagnosisClaimLinks: structuredClone(this.diagnosisClaimLinks),
      actions: structuredClone(this.actions),
      approvals: structuredClone(this.approvals),
      snapshots: structuredClone(this.snapshots),
      calls: structuredClone(this.calls),
      audits: structuredClone(this.audits),
      traces: structuredClone(this.traces),
      iterations: structuredClone(this.iterations),
      runs: structuredClone(this.runs),
    };
    const failAt = (point: NonNullable<MemoryStore["failNextGroundedFinalizationAt"]>) => {
      if (this.failNextGroundedFinalizationAt !== point) return;
      this.failNextGroundedFinalizationAt = null;
      throw new Error(`INJECTED_FINALIZATION_${point}_FAILURE`);
    };
    staged.diagnoses.set(input.diagnosis.id, structuredClone(input.diagnosis));
    input.claims.forEach((item) =>
      staged.diagnosisClaims.set(item.id, structuredClone(item)));
    input.claimEvidenceLinks.forEach((item) =>
      staged.diagnosisClaimLinks.set(item.id, structuredClone(item)));
    failAt("DIAGNOSIS");
    if (input.proposedAction) {
      staged.actions.set(input.proposedAction.id, structuredClone(input.proposedAction));
    }
    failAt("ACTION");
    if (input.approval) staged.approvals.set(input.approval.id, structuredClone(input.approval));
    failAt("APPROVAL");
    if (input.approvalSnapshot) {
      staged.snapshots.set(input.approvalSnapshot.id, structuredClone(input.approvalSnapshot));
    }
    failAt("SNAPSHOT");
    if (input.actionToolCall) {
      staged.calls.set(input.actionToolCall.id, structuredClone(input.actionToolCall));
    }
    failAt("TOOL_CALL");
    input.auditEvents.forEach((item) => staged.audits.set(item.id, structuredClone(item)));
    staged.traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    failAt("AUDIT");
    staged.iterations.set(input.iterationId, {
      ...iteration,
      status: "COMPLETED",
      decisionType: "FINALIZE",
      publicRationale: input.publicRationale,
      completedAt: input.completedAt,
    });
    staged.runs.set(input.runId, {
      ...run,
      status: input.targetRunStatus,
      activeIterationId: null,
      lockVersion: input.expectedLockVersion + 1,
      currentDiagnosisRevision: input.diagnosis.revision,
      totalTokens: input.totalTokens,
      completedAt: null,
      updatedAt: input.completedAt,
    });
    failAt("RUN_TRANSITION");

    this.diagnoses = staged.diagnoses;
    this.diagnosisClaims = staged.diagnosisClaims;
    this.diagnosisClaimLinks = staged.diagnosisClaimLinks;
    this.actions = staged.actions;
    this.approvals = staged.approvals;
    this.snapshots = staged.snapshots;
    this.calls = staged.calls;
    this.audits = staged.audits;
    this.traces = staged.traces;
    this.iterations = staged.iterations;
    this.runs = staged.runs;
    this.lastGroundedFinalizationInput = structuredClone(input);
  }

  async saveAuditEvents(events: AuditEvent[]) {
    events.forEach((event) => this.audits.set(event.id, structuredClone(event)));
  }

  async decideApproval(
    approvalId: string,
    decision: "APPROVE" | "REJECT",
    patch: {
      reason: string | null;
      decidedBy: string;
      targetOwner: string | null;
      targetRepo: string | null;
      decidedAt: string;
    },
  ) {
    const entry = [...this.approvals.entries()].find(([, item]) => item.id === approvalId);
    if (!entry || entry[1].status !== "PENDING") return false;
    this.approvals.set(entry[0], {
      ...entry[1],
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      decision,
      ...patch,
    });
    return true;
  }

  async updateProposedActionStatus(
    actionId: string,
    from: ProposedAction["status"],
    to: ProposedAction["status"],
  ) {
    const entry = [...this.actions.entries()].find(([, item]) => item.id === actionId);
    if (!entry || entry[1].status !== from) return false;
    this.actions.set(entry[0], { ...entry[1], status: to, updatedAt: new Date().toISOString() });
    return true;
  }

  async updateActionToolCall(
    callId: string,
    from: ToolCall["status"],
    to: ToolCall["status"],
    patch: {
      approvalId?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    } = {},
  ) {
    const call = this.calls.get(callId);
    if (!call || call.status !== from) return false;
    this.calls.set(callId, { ...call, ...patch, status: to });
    return true;
  }

  async completeActionToolCall(
    callId: string,
    from: ToolCall["status"],
    result: ToolResult,
    completedAt: string,
  ) {
    const call = this.calls.get(callId);
    if (!call || call.status !== from) return false;
    this.results.set(result.id, structuredClone(result));
    this.calls.set(callId, {
      ...call,
      status: result.status === "SUCCESS" ? "SUCCESS" : "ERROR",
      resultId: result.id,
      completedAt,
    });
    return true;
  }

  async claimIteration(iteration: AgentIteration, expectedLockVersion: number) {
    const run = this.runs.get(iteration.runId);
    if (
      !run
      || run.status !== "RUNNING"
      || run.lockVersion !== expectedLockVersion
      || run.activeIterationId
    ) return false;
    this.runs.set(run.id, {
      ...run,
      activeIterationId: iteration.id,
      currentIteration: iteration.sequence,
      lockVersion: expectedLockVersion + 1,
      updatedAt: iteration.startedAt,
    });
    this.iterations.set(iteration.id, structuredClone(iteration));
    return true;
  }

  async completeIteration(
    iterationId: string,
    status: AgentIteration["status"],
    decisionType: AgentIteration["decisionType"],
    publicRationale: string | null,
    completedAt: string,
  ) {
    const iteration = this.iterations.get(iterationId);
    if (!iteration) return;
    this.iterations.set(iterationId, {
      ...iteration,
      status,
      decisionType,
      publicRationale,
      completedAt,
    });
    const run = this.runs.get(iteration.runId);
    if (run?.activeIterationId === iterationId) {
      this.runs.set(run.id, { ...run, activeIterationId: null, updatedAt: completedAt });
    }
  }

  async saveHypotheses(items: Hypothesis[]) {
    items.forEach((item) => this.hypotheses.set(item.id, structuredClone(item)));
  }

  async updateHypothesis(item: Hypothesis) {
    this.hypotheses.set(item.id, structuredClone(item));
  }

  async saveHypothesisEvidenceLinks(items: HypothesisEvidenceLink[]) {
    items.forEach((item) => this.hypothesisLinks.set(item.id, structuredClone(item)));
  }

  async commitEvidenceAssessment(input: {
    links: HypothesisEvidenceLink[];
    hypotheses: Hypothesis[];
    traceEvent: InvestigationTraceEvent;
    iterationId: string;
    rationale: string;
    completedAt: string;
  }) {
    const links = structuredClone(this.hypothesisLinks);
    const hypotheses = structuredClone(this.hypotheses);
    const traces = structuredClone(this.traces);
    const iterations = structuredClone(this.iterations);
    const runs = structuredClone(this.runs);
    input.links.forEach((item) => links.set(item.id, structuredClone(item)));
    input.hypotheses.forEach((item) => hypotheses.set(item.id, structuredClone(item)));
    traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    const iteration = iterations.get(input.iterationId);
    if (!iteration || iteration.status !== "RUNNING") {
      throw new Error("Evidence Assessment iteration 不处于 RUNNING。");
    }
    iterations.set(input.iterationId, {
      ...iteration,
      status: "COMPLETED",
      decisionType: "ASSESS_EVIDENCE",
      publicRationale: input.rationale,
      completedAt: input.completedAt,
    });
    const run = runs.get(input.traceEvent.runId);
    if (!run || run.activeIterationId !== input.iterationId) {
      throw new Error("Evidence Assessment 未持有 Run lock。");
    }
    runs.set(run.id, { ...run, activeIterationId: null, updatedAt: input.completedAt });
    if (this.failNextEvidenceAssessmentCommit) {
      this.failNextEvidenceAssessmentCommit = false;
      throw new Error("INJECTED_ASSESSMENT_COMMIT_FAILURE");
    }
    this.hypothesisLinks = links;
    this.hypotheses = hypotheses;
    this.traces = traces;
    this.iterations = iterations;
    this.runs = runs;
  }

  async commitHumanHypothesis(input: {
    hypothesis: Hypothesis;
    message: InvestigationMessage;
    traceEvent: InvestigationTraceEvent;
    iterationId: string;
    completedAt: string;
  }) {
    const hypotheses = structuredClone(this.hypotheses);
    const messages = structuredClone(this.messages);
    const traces = structuredClone(this.traces);
    const iterations = structuredClone(this.iterations);
    const runs = structuredClone(this.runs);
    if ([...messages.values()].some((item) =>
      item.runId === input.message.runId
      && item.clientRequestId === input.message.clientRequestId)) {
      throw new Error("MESSAGE_ALREADY_EXISTS");
    }
    hypotheses.set(input.hypothesis.id, structuredClone(input.hypothesis));
    messages.set(input.message.id, structuredClone(input.message));
    traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    const iteration = iterations.get(input.iterationId);
    if (!iteration || iteration.status !== "RUNNING") {
      throw new Error("Human Hypothesis iteration 不处于 RUNNING。");
    }
    iterations.set(input.iterationId, {
      ...iteration,
      status: "COMPLETED",
      decisionType: "CREATE_HYPOTHESES",
      publicRationale: "产品经理新增竞争假设",
      completedAt: input.completedAt,
    });
    const run = runs.get(input.hypothesis.runId);
    if (!run || run.activeIterationId !== input.iterationId) {
      throw new Error("Human Hypothesis 未持有 Run lock。");
    }
    runs.set(run.id, { ...run, activeIterationId: null, updatedAt: input.completedAt });
    this.hypotheses = hypotheses;
    this.messages = messages;
    this.traces = traces;
    this.iterations = iterations;
    this.runs = runs;
  }

  async saveTraceEvents(items: InvestigationTraceEvent[]) {
    items.forEach((item) => this.traces.set(item.id, structuredClone(item)));
  }

  async saveMessage(message: InvestigationMessage) {
    const key = `${message.runId}:${message.clientRequestId}`;
    if ([...this.messages.values()].some((item) =>
      `${item.runId}:${item.clientRequestId}` === key)) return false;
    this.messages.set(message.id, structuredClone(message));
    return true;
  }

  async commitActionCompletion(input: ActionCompletionCommit) {
    const completion = input.completion;
    const run = this.runs.get(completion.runId);
    const diagnosis = this.diagnoses.get(completion.diagnosisId);
    const action = this.actions.get(completion.proposedActionId);
    const approval = this.approvals.get(completion.approvalId);
    const call = [...this.calls.values()].find((item) =>
      item.proposedActionId === completion.proposedActionId
      && item.approvalId === completion.approvalId);
    if (
      !run
      || run.status !== "WAITING_ACTION_COMPLETION"
      || run.activeIterationId !== null
      || run.lockVersion !== input.expectedLockVersion
      || run.currentDiagnosisRevision !== completion.revision
      || !diagnosis
      || diagnosis.runId !== completion.runId
      || diagnosis.revision !== completion.revision
      || diagnosis.groundingStatus !== "GROUNDED"
      || !action
      || action.status !== "SUCCEEDED"
      || action.diagnosisId !== diagnosis.id
      || action.revision !== completion.revision
      || !approval
      || approval.status !== "APPROVED"
      || approval.decision !== "APPROVE"
      || approval.proposedActionId !== action.id
      || approval.revision !== completion.revision
      || !call
      || call.status !== "SUCCESS"
      || call.completedAt !== input.expectedActionCompletedAt
      || [...this.actionCompletions.values()].some((item) =>
        item.runId === completion.runId
        && (item.clientRequestId === completion.clientRequestId
          || item.proposedActionId === completion.proposedActionId))
    ) return false;

    const completions = structuredClone(this.actionCompletions);
    const audits = structuredClone(this.audits);
    const traces = structuredClone(this.traces);
    const runs = structuredClone(this.runs);
    completions.set(completion.id, structuredClone(completion));
    input.auditEvents.forEach((event) => audits.set(event.id, structuredClone(event)));
    traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    runs.set(run.id, {
      ...run,
      status: "WAITING_VERIFICATION",
      activeIterationId: null,
      lockVersion: input.expectedLockVersion + 1,
      completedAt: null,
      updatedAt: completion.createdAt,
    });
    this.actionCompletions = completions;
    this.audits = audits;
    this.traces = traces;
    this.runs = runs;
    this.lastActionCompletionInput = structuredClone(input);
    return true;
  }

  async commitVerificationAttempt(input: VerificationAttemptCommit) {
    const verification = input.verificationRun;
    const run = this.runs.get(verification.runId);
    const diagnosis = this.diagnoses.get(verification.diagnosisId);
    const completion = verification.actionCompletionId
      ? this.actionCompletions.get(verification.actionCompletionId)
      : null;
    const action = completion ? this.actions.get(completion.proposedActionId) : null;
    const approval = completion ? this.approvals.get(completion.approvalId) : null;
    const sourceValid = verification.anchorType === "OBSERVE_DIAGNOSIS"
      ? verification.actionCompletionId === null
        && diagnosis?.disposition === "OBSERVE"
        && diagnosis.createdAt === verification.anchorAt
      : Boolean(
          completion
          && completion.runId === verification.runId
          && completion.diagnosisId === verification.diagnosisId
          && completion.revision === input.expectedDiagnosisRevision
          && completion.effectiveAt === verification.anchorAt
          && action?.diagnosisId === verification.diagnosisId
          && action.revision === input.expectedDiagnosisRevision
          && action.status === "SUCCEEDED"
          && approval?.proposedActionId === action.id
          && approval.revision === input.expectedDiagnosisRevision
          && approval.status === "APPROVED"
          && approval.decision === "APPROVE",
        );
    const hasActive = [...this.verificationRuns.values()].some((item) =>
      item.runId === verification.runId
      && ["PENDING", "WAITING_WINDOW", "RUNNING"].includes(item.status));
    const duplicate = [...this.verificationRuns.values()].some((item) =>
      item.runId === verification.runId
      && (item.clientRequestId === verification.clientRequestId
        || item.attempt === verification.attempt));
    if (
      !run
      || run.status !== "WAITING_VERIFICATION"
      || run.activeIterationId !== null
      || run.lockVersion !== input.expectedLockVersion
      || run.currentDiagnosisRevision !== input.expectedDiagnosisRevision
      || !diagnosis
      || diagnosis.runId !== verification.runId
      || diagnosis.revision !== input.expectedDiagnosisRevision
      || diagnosis.groundingStatus !== "GROUNDED"
      || input.policySnapshot.verificationRunId !== verification.id
      || input.policySnapshot.runId !== verification.runId
      || input.policySnapshot.anchorAt !== verification.anchorAt
      || !input.policySnapshot.metricKey.trim()
      || !sourceValid
      || hasActive
      || duplicate
    ) return false;

    const verificationRuns = structuredClone(this.verificationRuns);
    const policies = structuredClone(this.verificationPolicies);
    const audits = structuredClone(this.audits);
    const traces = structuredClone(this.traces);
    const runs = structuredClone(this.runs);
    verificationRuns.set(verification.id, structuredClone(verification));
    policies.set(input.policySnapshot.id, structuredClone(input.policySnapshot));
    audits.set(input.auditEvent.id, structuredClone(input.auditEvent));
    traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    runs.set(run.id, {
      ...run,
      lockVersion: input.expectedLockVersion + 1,
      updatedAt: verification.createdAt,
    });
    this.verificationRuns = verificationRuns;
    this.verificationPolicies = policies;
    this.audits = audits;
    this.traces = traces;
    this.runs = runs;
    this.lastVerificationAttemptInput = structuredClone(input);
    return true;
  }

  async queryVerificationMetricBuckets(input: {
    metricKey: string; filters: MetricFilters; startTime: string; endTime: string;
  }) {
    return this.analytics.queryMetricBuckets(input);
  }

  async queryVerificationFeedback(input: {
    filters: MetricFilters; startTime: string; endTime: string;
  }) {
    return structuredClone(this.verificationFeedback.filter((item) =>
      item.timestamp >= input.startTime && item.timestamp < input.endTime));
  }

  async markVerificationWaitingWindow(input: {
    runId: string; verificationRunId: string; expectedLockVersion: number; updatedAt: string;
  }) {
    const run = this.runs.get(input.runId);
    const verification = this.verificationRuns.get(input.verificationRunId);
    if (!run || run.status !== "WAITING_VERIFICATION"
      || run.lockVersion !== input.expectedLockVersion
      || !verification || verification.runId !== input.runId
      || !["PENDING", "WAITING_WINDOW"].includes(verification.status)) return false;
    this.verificationRuns.set(verification.id, {
      ...verification, status: "WAITING_WINDOW", updatedAt: input.updatedAt,
    });
    return true;
  }

  async beginVerificationEvaluation(input: {
    runId: string; verificationRunId: string; clientRequestId: string;
    expectedLockVersion: number; startedAt: string;
  }) {
    const run = this.runs.get(input.runId);
    const verification = this.verificationRuns.get(input.verificationRunId);
    if (!run || run.status !== "WAITING_VERIFICATION" || run.activeIterationId !== null
      || run.lockVersion !== input.expectedLockVersion
      || !verification || verification.runId !== input.runId
      || !["PENDING", "WAITING_WINDOW"].includes(verification.status)) return false;
    const guard = `VERIFICATION_EVALUATION:${verification.id}:${input.clientRequestId}`;
    const runs = structuredClone(this.runs);
    const verifications = structuredClone(this.verificationRuns);
    runs.set(run.id, { ...run, status: "VERIFYING", activeIterationId: guard,
      lockVersion: run.lockVersion + 1, updatedAt: input.startedAt });
    verifications.set(verification.id, { ...verification, status: "RUNNING", updatedAt: input.startedAt });
    this.runs = runs;
    this.verificationRuns = verifications;
    return true;
  }

  async commitVerificationEvaluation(input: VerificationEvaluationCommit) {
    if (this.failNextVerificationEvaluationCommit) {
      this.failNextVerificationEvaluationCommit = false;
      return false;
    }
    const { evaluation } = input;
    const run = this.runs.get(evaluation.runId);
    const verification = this.verificationRuns.get(evaluation.verificationRunId);
    const guard = `VERIFICATION_EVALUATION:${evaluation.verificationRunId}:${evaluation.clientRequestId}`;
    if (!run || run.status !== "VERIFYING" || run.activeIterationId !== guard
      || run.lockVersion !== input.expectedLockVersion
      || !verification || verification.runId !== evaluation.runId || verification.status !== "RUNNING"
      || verification.attempt !== input.expectedVerificationAttempt
      || this.verificationEvaluations.has(evaluation.verificationRunId)
      || [...this.verificationEvaluations.values()].some((item) =>
        item.runId === evaluation.runId && item.clientRequestId === evaluation.clientRequestId)
      || input.evidence.some((item) => item.runId !== evaluation.runId
        || item.verificationRunId !== evaluation.verificationRunId)) return false;
    const verifications = structuredClone(this.verificationRuns);
    const evaluations = structuredClone(this.verificationEvaluations);
    const evidence = structuredClone(this.verificationEvidence);
    const audits = structuredClone(this.audits);
    const traces = structuredClone(this.traces);
    const runs = structuredClone(this.runs);
    evaluations.set(evaluation.verificationRunId, structuredClone(evaluation));
    input.evidence.forEach((item) => evidence.set(item.id, structuredClone(item)));
    input.auditEvents.forEach((item) => audits.set(item.id, structuredClone(item)));
    traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    verifications.set(verification.id, { ...verification, status: evaluation.outcome,
      updatedAt: evaluation.createdAt, completedAt: evaluation.createdAt });
    const runStatus = evaluation.outcome === "INCONCLUSIVE"
      ? "VERIFICATION_INCONCLUSIVE" : evaluation.outcome;
    runs.set(run.id, { ...run, status: runStatus, activeIterationId: null,
      lockVersion: run.lockVersion + 1, updatedAt: evaluation.createdAt,
      completedAt: evaluation.createdAt });
    this.verificationRuns = verifications;
    this.verificationEvaluations = evaluations;
    this.verificationEvidence = evidence;
    this.audits = audits;
    this.traces = traces;
    this.runs = runs;
    this.lastVerificationEvaluationInput = structuredClone(input);
    return true;
  }

  async commitVerificationReopen(input: VerificationReopenCommit) {
    const run = this.runs.get(input.runId);
    const verification = this.verificationRuns.get(input.verificationRunId);
    const key = `${input.runId}:REOPEN_VERIFICATION:${input.clientRequestId}`;
    const expectedRunStatus = verification?.status === "INCONCLUSIVE"
      ? "VERIFICATION_INCONCLUSIVE" : verification?.status;
    const latestAttempt = Math.max(...[...this.verificationRuns.values()]
      .filter((item) => item.runId === input.runId).map((item) => item.attempt));
    if (!run || run.status !== expectedRunStatus
      || run.activeIterationId !== null || run.lockVersion !== input.expectedLockVersion
      || !verification || verification.runId !== input.runId
      || !["PARTIALLY_RESOLVED", "NOT_RECOVERED", "INCONCLUSIVE"].includes(verification.status)
      || verification.attempt !== latestAttempt
      || this.commands.has(key)) return false;
    const runs = structuredClone(this.runs);
    const audits = structuredClone(this.audits);
    const traces = structuredClone(this.traces);
    const commands = structuredClone(this.commands);
    runs.set(run.id, { ...run, status: "RUNNING", activeIterationId: null,
      completedAt: null,
      lockVersion: run.lockVersion + 1, updatedAt: input.createdAt });
    audits.set(input.auditEvent.id, structuredClone(input.auditEvent));
    traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    commands.add(key);
    this.runs = runs; this.audits = audits;
    this.traces = traces; this.commands = commands;
    this.lastVerificationReopenInput = structuredClone(input);
    return true;
  }

  async commitVerificationRetry(input: VerificationRetryCommit) {
    const run = this.runs.get(input.verificationRun.runId);
    const previous = this.verificationRuns.get(input.previousVerificationRunId);
    const key = `${input.verificationRun.runId}:RETRY_VERIFICATION:${input.clientRequestId}`;
    const expectedRunStatus = previous?.status === "INCONCLUSIVE"
      ? "VERIFICATION_INCONCLUSIVE" : previous?.status;
    const latestAttempt = Math.max(...[...this.verificationRuns.values()]
      .filter((item) => item.runId === input.verificationRun.runId).map((item) => item.attempt));
    if (!run || run.status !== expectedRunStatus
      || run.activeIterationId !== null || run.lockVersion !== input.expectedLockVersion
      || run.currentDiagnosisRevision !== input.expectedDiagnosisRevision
      || !previous || previous.runId !== run.id
      || !["PARTIALLY_RESOLVED", "NOT_RECOVERED", "INCONCLUSIVE"].includes(previous.status)
      || previous.attempt !== latestAttempt
      || input.verificationRun.attempt !== previous.attempt + 1
      || input.verificationRun.attempt > 3
      || input.policySnapshot.verificationWindowMinutes > 480
      || this.commands.has(key)
      || [...this.verificationRuns.values()].some((item) => item.runId === run.id
        && (item.attempt === input.verificationRun.attempt
          || item.clientRequestId === input.verificationRun.clientRequestId))) return false;
    const runs = structuredClone(this.runs);
    const verifications = structuredClone(this.verificationRuns);
    const policies = structuredClone(this.verificationPolicies);
    const audits = structuredClone(this.audits);
    const traces = structuredClone(this.traces);
    const commands = structuredClone(this.commands);
    runs.set(run.id, { ...run, status: "WAITING_VERIFICATION", activeIterationId: null,
      completedAt: null, lockVersion: run.lockVersion + 1,
      updatedAt: input.verificationRun.createdAt });
    verifications.set(input.verificationRun.id, structuredClone(input.verificationRun));
    policies.set(input.policySnapshot.id, structuredClone(input.policySnapshot));
    audits.set(input.auditEvent.id, structuredClone(input.auditEvent));
    traces.set(input.traceEvent.id, structuredClone(input.traceEvent));
    commands.add(key);
    this.runs = runs; this.verificationRuns = verifications; this.verificationPolicies = policies;
    this.audits = audits; this.traces = traces; this.commands = commands;
    this.lastVerificationRetryInput = structuredClone(input);
    return true;
  }

  async recordRuntimeCommand(input: {
    id: string;
    runId: string;
    clientRequestId: string;
    commandType: string;
    resultReference: string | null;
    createdAt: string;
  }) {
    const key = `${input.runId}:${input.commandType}:${input.clientRequestId}`;
    if (this.commands.has(key)) return false;
    this.commands.add(key);
    return true;
  }

  async withdrawPendingRevision(input: {
    runId: string;
    approvalId: string;
    proposedActionId: string;
    actionToolCallId: string;
    snapshotId: string | null;
    now: string;
  }) {
    const approval = this.approvals.get(input.approvalId);
    const action = this.actions.get(input.proposedActionId);
    const call = this.calls.get(input.actionToolCallId);
    if (
      !approval || approval.status !== "PENDING"
      || !action || action.status !== "PENDING_APPROVAL"
      || !call || call.status !== "WAITING_APPROVAL"
    ) return false;
    this.approvals.set(approval.id, {
      ...approval,
      status: "WITHDRAWN",
      withdrawnAt: input.now,
      reason: "继续调查，撤回当前审批快照",
    });
    this.actions.set(action.id, {
      ...action,
      status: "SUPERSEDED",
      supersededAt: input.now,
      updatedAt: input.now,
    });
    this.calls.set(call.id, { ...call, status: "CANCELLED", completedAt: input.now });
    if (input.snapshotId) {
      const snapshot = this.snapshots.get(input.snapshotId);
      if (snapshot) this.snapshots.set(snapshot.id, {
        ...snapshot,
        lifecycleStatus: "WITHDRAWN",
        withdrawnAt: input.now,
      });
    }
    return true;
  }

  async getAggregate(runId: string): Promise<InvestigationAggregate | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    const calls = [...this.calls.values()]
      .filter((call) => call.runId === runId)
      .sort((left, right) => left.order - right.order)
      .map((call) => ({
        ...structuredClone(call),
        result: call.resultId ? structuredClone(this.results.get(call.resultId) ?? null) : null,
      }));
    const diagnoses = [...this.diagnoses.values()]
      .filter((item) => item.runId === runId)
      .sort((left, right) => left.revision - right.revision);
    const actions = [...this.actions.values()]
      .filter((item) => item.runId === runId)
      .sort((left, right) => left.revision - right.revision);
    const approvals = [...this.approvals.values()]
      .filter((item) => item.runId === runId)
      .sort((left, right) => left.revision - right.revision);
    const [riskEvent, release] = await Promise.all([
      run.riskEventId ? this.analytics.getRiskEvent(run.riskEventId) : null,
      run.releaseId ? this.analytics.getRelease(run.releaseId) : null,
    ]);
    return {
      run: structuredClone(run),
      riskEvent: structuredClone(riskEvent),
      release: structuredClone(release),
      toolCalls: calls,
      evidence: [...this.evidence.values()]
        .filter((item) => item.runId === runId)
        .map((item) => structuredClone(item)),
      diagnosis: structuredClone(diagnoses.at(-1) ?? null),
      diagnoses: structuredClone(diagnoses),
      proposedAction: structuredClone(actions.at(-1) ?? null),
      proposedActions: structuredClone(actions),
      approval: structuredClone(approvals.at(-1) ?? null),
      approvals: structuredClone(approvals),
      auditEvents: [...this.audits.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((item) => structuredClone(item)),
      iterations: structuredClone([...this.iterations.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.sequence - right.sequence)),
      hypotheses: structuredClone([...this.hypotheses.values()]
        .filter((item) => item.runId === runId)),
      hypothesisEvidenceLinks: structuredClone([...this.hypothesisLinks.values()]
        .filter((item) => item.runId === runId)),
      traceEvents: structuredClone([...this.traces.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.sequence - right.sequence)),
      messages: structuredClone([...this.messages.values()]
        .filter((item) => item.runId === runId)),
      diagnosisClaims: structuredClone([...this.diagnosisClaims.values()]
        .filter((item) => item.runId === runId)),
      diagnosisClaimEvidenceLinks: structuredClone([...this.diagnosisClaimLinks.values()]
        .filter((item) => item.runId === runId)),
      diagnosisEvidenceLinks: structuredClone([...this.diagnosisLinks.values()]
        .filter((item) => item.runId === runId)),
      approvalSnapshots: structuredClone([...this.snapshots.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.revision - right.revision)),
      actionCompletions: structuredClone([...this.actionCompletions.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))),
      verificationRuns: structuredClone([...this.verificationRuns.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.attempt - right.attempt)),
      verificationPolicySnapshots: structuredClone([...this.verificationPolicies.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))),
      verificationEvidence: structuredClone([...this.verificationEvidence.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))),
      verificationEvaluations: structuredClone([...this.verificationEvaluations.values()]
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))),
    };
  }

  async getLatestAggregate() {
    const latest = [...this.runs.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt))[0];
    return latest ? this.getAggregate(latest.id) : null;
  }
}

class AtomicBatchD1Statement {
  constructor(
    readonly query: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new AtomicBatchD1Statement(this.query, params);
  }
}

class AtomicBatchD1Client {
  committedQueries: string[] = [];
  batchCalls = 0;
  failPattern: RegExp | null = null;
  zeroChangePattern: RegExp | null = null;

  prepare(query: string) {
    return new AtomicBatchD1Statement(query);
  }

  async batch(statements: AtomicBatchD1Statement[]) {
    this.batchCalls += 1;
    const staged = [...this.committedQueries];
    for (const statement of statements) {
      if (this.failPattern?.test(statement.query)) {
        throw new Error("INJECTED_D1_BATCH_FAILURE");
      }
      staged.push(statement.query);
    }
    this.committedQueries = staged;
    return statements.map((statement) => ({
      success: true,
      results: [],
      meta: { changes: this.zeroChangePattern?.test(statement.query) ? 0 : 1 },
    }));
  }
}

const fixture = () => runFixtureInvestigation(
  new MemoryStore(),
  "为什么 Android 7.3.0 发布后，优惠券领取成功率突然下降？",
);

async function executedFixtureAction(store = new MemoryStore()) {
  const initial = await runFixtureInvestigation(store, "P4.3A action completion case");
  const actionId = initial.proposedAction!.id;
  await decideProposedAction(store, {
    runId: initial.run.id,
    proposedActionId: actionId,
    decision: "APPROVE",
    reason: "批准创建受控工作项",
    targetOwner: "example",
    targetRepo: "releaseguard-demo",
  });
  let githubCalls = 0;
  await executeApprovedGithubAction(store, {
    runId: initial.run.id,
    proposedActionId: actionId,
    token: "test-token",
  }, async (_input, init) => {
    githubCalls += 1;
    if (!init?.method) return Response.json([]);
    return Response.json({
      number: 93,
      title: "[P1] ReleaseGuard follow-up",
      html_url: "https://github.com/example/releaseguard-demo/issues/93",
      created_at: "2026-07-28T01:00:00.000Z",
    }, { status: 201 });
  });
  const aggregate = (await store.getAggregate(initial.run.id))!;
  const actionCall = aggregate.toolCalls.find((item) => item.proposedActionId === actionId)!;
  return { store, aggregate, actionId, actionCall, githubCalls };
}

const afterInstant = (value: string, milliseconds = 1_000) =>
  new Date(Date.parse(value) + milliseconds).toISOString();

async function completedFixtureAction(clientRequestId = `completion-${crypto.randomUUID()}`) {
  const executed = await executedFixtureAction();
  const completion = await confirmActionCompletion(executed.store, {
    runId: executed.aggregate.run.id,
    clientRequestId,
    effectiveAt: afterInstant(executed.actionCall.completedAt!),
    changeReference: "deploy/releaseguard-2026-07-28",
    note: "变更已完成发布。",
  });
  return {
    ...executed,
    completion,
    aggregate: (await executed.store.getAggregate(executed.aggregate.run.id))!,
  };
}

const hypothesis = (
  runId: string,
  id: string,
  statement: string,
  status: Hypothesis["status"] = "ACTIVE",
): Hypothesis => ({
  id,
  runId,
  revision: 1,
  statement,
  supportIf: `支持 ${statement} 的条件`,
  refuteIf: `反驳 ${statement} 的条件`,
  status,
  confidence: "LOW",
  supportScore: 0,
  contradictionScore: 0,
  confidenceReason: "等待显式 Evidence Assessment",
  createdBy: "AGENT",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
});

const hypothesisLink = (
  runId: string,
  evidenceId: string,
  hypothesisId: string,
  relation: HypothesisEvidenceLink["relation"] = "SUPPORTS",
  linkedBy: HypothesisEvidenceLink["linkedBy"] = "AGENT",
): HypothesisEvidenceLink => ({
  id: `HEL-${crypto.randomUUID()}`,
  runId,
  hypothesisId,
  evidenceId,
  relation,
  explanation: "显式测试关系",
  linkedBy,
  createdAt: "2026-07-27T00:00:00.000Z",
});

async function runningInvestigationWithHypotheses() {
  const store = new MemoryStore();
  const { event, release } = await ensureAndroid730RiskEvent(store.analytics);
  const runId = await startInvestigation(store, {
    question: "P4.1 competing hypothesis test",
    provider: "test",
    model: "test-model",
    incidentId: event.id,
    riskEventId: event.id,
    releaseId: release.id,
  });
  const hypotheses = [
    hypothesis(runId, "HYP-RELEASE", "发布回归导致领券失败"),
    hypothesis(runId, "HYP-OUTAGE", "第三方依赖故障导致领券失败"),
  ];
  await store.saveHypotheses(hypotheses);
  return { store, runId, event, release, hypotheses };
}

async function runningInvestigationWithPartialMatrix() {
  const setup = await runningInvestigationWithHypotheses();
  const third = hypothesis(setup.runId, "HYP-DATA", "指标采集缺陷造成假性下降");
  await setup.store.saveHypotheses([third]);
  await executeAndRecordTool(setup.store, {
    runId: setup.runId,
    name: "get_release",
    args: { release_id: "REL-ANDROID-730" },
    iteration: 1,
    order: 1,
    analytics: setup.store.analytics,
  });
  const aggregate = (await setup.store.getAggregate(setup.runId))!;
  await setup.store.saveHypothesisEvidenceLinks([
    hypothesisLink(
      setup.runId,
      aggregate.evidence[0].id,
      setup.hypotheses[0].id,
      "SUPPORTS",
      "RUNTIME",
    ),
  ]);
  return {
    ...setup,
    hypotheses: [...setup.hypotheses, third],
    evidenceId: aggregate.evidence[0].id,
  };
}

async function groundedReadyInvestigation() {
  const setup = await runningInvestigationWithHypotheses();
  await executeAndRecordTool(setup.store, {
    runId: setup.runId,
    name: "get_release",
    args: { release_id: setup.release.id },
    iteration: 1,
    order: 1,
    analytics: setup.store.analytics,
  });
  await executeAndRecordTool(setup.store, {
    runId: setup.runId,
    name: "query_metric",
    args: {
      metric_key: setup.event.metricKey,
      start_time: setup.event.firstBreachedAt,
      end_time: setup.event.lastBreachedAt,
      filters: setup.event.filters,
      granularity_minutes: 5,
      include_baseline: true,
    },
    iteration: 1,
    order: 2,
    analytics: setup.store.analytics,
  });
  await executeAndRecordTool(setup.store, {
    runId: setup.runId,
    name: "segment_metric",
    args: {
      metric_key: setup.event.metricKey,
      start_time: setup.event.firstBreachedAt,
      end_time: setup.event.lastBreachedAt,
      filters: { platform: "Android" },
      dimension: "app_version",
      limit: 10,
    },
    iteration: 1,
    order: 3,
    analytics: setup.store.analytics,
  });
  const collected = (await setup.store.getAggregate(setup.runId))!;
  const links = collected.evidence.flatMap((item) => setup.hypotheses.map((candidate, index) =>
    hypothesisLink(
      setup.runId,
      item.id,
      candidate.id,
      index === 0 ? "SUPPORTS" : "CONTRADICTS",
    )));
  await setup.store.saveHypothesisEvidenceLinks(links);
  for (const candidate of setup.hypotheses) {
    const calculated = calculateHypothesisConfidence(
      collected.evidence,
      links.filter((item) => item.hypothesisId === candidate.id),
    );
    await setup.store.updateHypothesis({ ...candidate, ...calculated });
  }
  return { ...setup, aggregate: (await setup.store.getAggregate(setup.runId))! };
}

function groundedFinalizeDecision(
  aggregate: InvestigationAggregate,
): Extract<InvestigationDecision, { type: "FINALIZE" }> {
  const selected = aggregate.hypotheses.find((item) => item.status === "SUPPORTED")
    ?? aggregate.hypotheses.find((item) => item.status === "CONFIRMED")!;
  const supportingIds = new Set(aggregate.hypothesisEvidenceLinks
    .filter((item) => item.hypothesisId === selected.id && item.relation === "SUPPORTS")
    .map((item) => item.evidenceId));
  const evidenceIds = (...categories: string[]) => aggregate.evidence
    .filter((item) => supportingIds.has(item.id) && categories.includes(item.category))
    .map((item) => item.id);
  return {
    type: "FINALIZE",
    selectedHypothesisId: selected.id,
    diagnosis: {
      summary: "当前 Run 的发布、指标与分群证据共同支持所选假设。",
      claims: [
        {
          type: "ROOT_CAUSE",
          statement: selected.statement,
          evidenceIds: aggregate.evidence
            .filter((item) => supportingIds.has(item.id) && item.category !== "SIMILAR_INCIDENT")
            .map((item) => item.id),
        },
        {
          type: "CAUSAL_STEP",
          statement: "发布变更与当前失败机制在时间上和产品路径上相符。",
          evidenceIds: evidenceIds("RELEASE_CHANGE"),
        },
        {
          type: "AFFECTED_METRIC",
          statement: "coupon_claim_success_rate 显著低于动态基线。",
          evidenceIds: evidenceIds("PRODUCT_METRIC"),
        },
        {
          type: "AFFECTED_SEGMENT",
          statement: "异常集中在 Android 7.3.0。",
          evidenceIds: evidenceIds("SEGMENT_METRIC"),
        },
        {
          type: "LIMITATION",
          limitationType: "SCOPE_LIMITATION",
          statement: "现有分析仅覆盖 Android 7.3.0，无法判断其他历史版本。",
          evidenceIds: [],
        },
      ],
    },
    disposition: "FIX",
    rationale: "使用当前 Run Evidence 形成 grounded diagnosis。",
  };
}

async function observedGroundedInvestigation() {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.disposition = "OBSERVE";
  const aggregate = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner: { type: "DETERMINISTIC", async plan() { return decision; } },
    analytics: setup.store.analytics,
  });
  return { ...setup, aggregate: aggregate! };
}

test("Android fixture creates a persisted Approval and waiting Action ToolCall", async () => {
  const store = new MemoryStore();
  const aggregate = await runFixtureInvestigation(
    store,
    "为什么 Android 7.3.0 发布后，优惠券领取成功率突然下降？",
  );

  assert.equal(aggregate.run.status, "WAITING_APPROVAL");
  assert.equal(aggregate.toolCalls.length, 6);
  assert.equal(aggregate.toolCalls.filter((call) => call.proposedActionId === null).length, 5);
  assert.ok(aggregate.toolCalls.slice(0, 5).every((call) => call.result?.status === "SUCCESS"));
  assert.equal(aggregate.evidence.length, 5);
  assert.equal(aggregate.diagnosis?.confidence, "HIGH");
  assert.equal(aggregate.proposedAction?.status, "PENDING_APPROVAL");
  assert.equal(aggregate.approval?.status, "PENDING");
  assert.equal(
    aggregate.toolCalls.find((call) => call.name === "create_github_issue")?.status,
    "WAITING_APPROVAL",
  );
  assert.ok(aggregate.auditEvents.some((event) => event.type === "PROPOSED_ACTION_CREATED"));
  assert.ok(aggregate.auditEvents.some((event) => event.type === "APPROVAL_REQUESTED"));
  assert.equal(aggregate.iterations.length, 12);
  assert.equal(aggregate.traceEvents.filter((item) => item.type === "PLANNER_DECISION").length, 12);
  assert.equal(aggregate.hypotheses.length, 3);
  assert.equal(aggregate.hypotheses[0].confidence, "HIGH");
  assert.equal(aggregate.hypotheses[0].status, "SUPPORTED");
  assert.equal(aggregate.hypotheses[1].status, "REJECTED");
  assert.equal(aggregate.hypotheses[2].status, "WEAKENED");
  assert.equal(aggregate.hypothesisEvidenceLinks.length, 13);
  assert.ok(aggregate.toolCalls
    .filter((call) => call.proposedActionId === null)
    .every((call) => call.agentIterationId));
  assert.equal(
    aggregate.iterations.filter((item) => item.decisionType === "ASSESS_EVIDENCE").length,
    5,
  );
  assert.equal(aggregate.hypothesisEvidenceLinks.some((item) => item.linkedBy === "RUNTIME"), false);
  assert.equal(aggregate.diagnosis?.groundingStatus, "GROUNDED");
  assert.equal(aggregate.diagnosis?.selectedHypothesisId, aggregate.hypotheses[0].id);
  assert.equal(aggregate.diagnosisClaims.length, 5);
  assert.equal(aggregate.diagnosisClaimEvidenceLinks.length, 7);
  assert.equal(aggregate.diagnosisEvidenceLinks.length, 0);
  assert.equal(aggregate.approvalSnapshots.length, 1);
  assert.equal(aggregate.approvalSnapshots[0].lifecycleStatus, "ACTIVE");

  const reloaded = await store.getAggregate(aggregate.run.id);
  assert.deepEqual(reloaded, aggregate);
  assert.notDeepEqual(
    aggregate.toolCalls[0].result?.output,
    aggregate.evidence[0],
    "raw ToolResult output and derived Evidence must remain separate objects",
  );
});

test("POST /api/investigate instantiates DeterministicPlanner and completes the Phase 3 demo", async () => {
  const store = new MemoryStore();
  const response = await handleInvestigatePost(
    new Request("http://releaseguard.test/api/investigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "为什么 Android 7.3.0 后优惠券领取成功率下降？",
        fixture: true,
      }),
    }),
    {
      store,
      analytics: store.analytics,
      createRetrievers: async () => ({
        feedbackRetriever: new InMemoryFeedbackRetriever(),
        incidentRetriever: new InMemoryIncidentRetriever(),
      }),
    },
  );
  const payload = await response.json() as {
    mode: string;
    runStatus: string;
    investigation: InvestigationAggregate;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.mode, "fixture");
  assert.equal(payload.investigation.run.plannerType, "DETERMINISTIC");
  assert.equal(payload.runStatus, "WAITING_APPROVAL");
  assert.equal(payload.investigation.iterations.length, 12);
  assert.equal(
    payload.investigation.toolCalls.filter((call) => call.proposedActionId === null).length,
    5,
  );
  assert.ok(payload.investigation.diagnosis);
  assert.ok(payload.investigation.proposedAction);
  assert.ok(payload.investigation.approval);
});

test("Case A: approve executes the frozen action and reaches WAITING_ACTION_COMPLETION", async () => {
  const store = new MemoryStore();
  const initial = await runFixtureInvestigation(store, "Android case");
  const actionId = initial.proposedAction!.id;
  await decideProposedAction(store, {
    runId: initial.run.id,
    proposedActionId: actionId,
    decision: "APPROVE",
    reason: "证据充分，同意执行",
    targetOwner: "example",
    targetRepo: "releaseguard-demo",
  });

  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    if (!init?.method) return Response.json([]);
    return Response.json({
      number: 88,
      title: "[P1] Android repair",
      html_url: "https://github.com/example/releaseguard-demo/issues/88",
      created_at: "2026-07-26T10:00:00.000Z",
    }, { status: 201 });
  };
  const output = await executeApprovedGithubAction(store, {
    runId: initial.run.id,
    proposedActionId: actionId,
    token: "test-token",
  }, fetcher);
  assert.equal(output.number, 88);
  assert.equal(calls, 2);

  const completed = await store.getAggregate(initial.run.id);
  assert.equal(completed?.run.status, "WAITING_ACTION_COMPLETION");
  assert.equal(completed?.run.completedAt, null);
  assert.equal(completed?.approval?.status, "APPROVED");
  assert.equal(completed?.proposedAction?.status, "SUCCEEDED");
  const actionCall = completed?.toolCalls.find((call) => call.proposedActionId === actionId);
  assert.equal(actionCall?.status, "SUCCESS");
  assert.equal(actionCall?.result?.status, "SUCCESS");
  assert.ok(completed?.auditEvents.some((event) => event.type === "ACTION_EXECUTION_STARTED"));
  assert.ok(completed?.auditEvents.some((event) => event.type === "ACTION_SUCCEEDED"));

  await assert.rejects(
    executeApprovedGithubAction(store, {
      runId: initial.run.id,
      proposedActionId: actionId,
      token: "test-token",
    }, fetcher),
    (error: unknown) =>
      error instanceof RuntimeRequestError && error.code === "ACTION_ALREADY_EXECUTED",
  );
  assert.equal(calls, 2, "replayed execution must not call GitHub again");
});

test("P4.3A confirms Action completion and atomically enters WAITING_VERIFICATION", async () => {
  const executed = await executedFixtureAction();
  const completion = await confirmActionCompletion(executed.store, {
    runId: executed.aggregate.run.id,
    clientRequestId: "action-completion-success",
    effectiveAt: afterInstant(executed.actionCall.completedAt!),
    changeReference: "deploy/android-7.3.0-hotfix",
    note: "生产发布已完成。",
  });
  const completed = await executed.store.getAggregate(executed.aggregate.run.id);
  assert.equal(completed?.run.status, "WAITING_VERIFICATION");
  assert.equal(completed?.run.completedAt, null);
  assert.equal(completed?.actionCompletions.length, 1);
  assert.equal(completed?.actionCompletions[0].id, completion.id);
  assert.equal(completion.confirmedBy, "Product Manager · Workspace Owner");
  assert.ok(completed?.auditEvents.some((event) =>
    event.type === "ACTION_COMPLETION_CONFIRMED"));
  assert.ok(completed?.auditEvents.some((event) =>
    event.type === "RUN_STATE_CHANGED"
    && event.details.from === "WAITING_ACTION_COMPLETION"
    && event.details.to === "WAITING_VERIFICATION"));
  assert.ok(completed?.traceEvents.some((event) =>
    event.type === "ACTION_COMPLETION_CONFIRMED"));
});

test("P4.3A generic transition cannot bypass ActionCompletion", async () => {
  const executed = await executedFixtureAction();
  await assert.rejects(
    executed.store.transitionRun(executed.aggregate.run.id, "WAITING_VERIFICATION"),
    /Protected InvestigationRun transition requires commitActionCompletion/,
  );
  const blocked = await executed.store.getAggregate(executed.aggregate.run.id);
  assert.equal(blocked?.run.status, "WAITING_ACTION_COMPLETION");
  assert.equal(blocked?.actionCompletions.length, 0);

  await confirmActionCompletion(executed.store, {
    runId: executed.aggregate.run.id,
    clientRequestId: "completion-after-protected-transition",
    effectiveAt: afterInstant(executed.actionCall.completedAt!),
    changeReference: "deploy/protected-transition",
  });
  const completed = await executed.store.getAggregate(executed.aggregate.run.id);
  assert.equal(completed?.run.status, "WAITING_VERIFICATION");
  assert.equal(completed?.actionCompletions.length, 1);
  assert.doesNotThrow(() =>
    assertGenericRunTransition("RUNNING", "WAITING_VERIFICATION"));
});

test("P4.3A rejects completion without successful Action or approved revision", async () => {
  const approvedStore = new MemoryStore();
  const approved = await runFixtureInvestigation(approvedStore, "approved but not executed");
  await decideProposedAction(approvedStore, {
    runId: approved.run.id,
    proposedActionId: approved.proposedAction!.id,
    decision: "APPROVE",
    targetOwner: "example",
    targetRepo: "releaseguard-demo",
  });
  const approvedRun = approvedStore.runs.get(approved.run.id)!;
  approvedStore.runs.set(approvedRun.id, {
    ...approvedRun,
    status: "WAITING_ACTION_COMPLETION",
  });
  await assert.rejects(
    confirmActionCompletion(approvedStore, {
      runId: approved.run.id,
      clientRequestId: "completion-without-success",
      effectiveAt: new Date().toISOString(),
      changeReference: "deploy/not-executed",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "ACTION_COMPLETION_CONTEXT_INVALID",
  );

  const unapprovedStore = new MemoryStore();
  const unapproved = await runFixtureInvestigation(unapprovedStore, "unapproved completion");
  const unapprovedRun = unapprovedStore.runs.get(unapproved.run.id)!;
  const unapprovedAction = unapprovedStore.actions.get(unapproved.proposedAction!.id)!;
  unapprovedStore.runs.set(unapprovedRun.id, {
    ...unapprovedRun,
    status: "WAITING_ACTION_COMPLETION",
  });
  unapprovedStore.actions.set(unapprovedAction.id, {
    ...unapprovedAction,
    status: "SUCCEEDED",
  });
  await assert.rejects(
    confirmActionCompletion(unapprovedStore, {
      runId: unapproved.run.id,
      clientRequestId: "completion-without-approval",
      effectiveAt: new Date().toISOString(),
      changeReference: "deploy/unapproved",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "ACTION_COMPLETION_CONTEXT_INVALID",
  );
});

test("P4.3A rejects stale revision and effectiveAt before Action completion", async () => {
  const stale = await executedFixtureAction();
  const staleRun = stale.store.runs.get(stale.aggregate.run.id)!;
  stale.store.runs.set(staleRun.id, {
    ...staleRun,
    currentDiagnosisRevision: staleRun.currentDiagnosisRevision + 1,
  });
  await assert.rejects(
    confirmActionCompletion(stale.store, {
      runId: stale.aggregate.run.id,
      clientRequestId: "stale-completion",
      effectiveAt: afterInstant(stale.actionCall.completedAt!),
      changeReference: "deploy/stale",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "CURRENT_GROUNDED_DIAGNOSIS_REQUIRED",
  );

  const early = await executedFixtureAction();
  await assert.rejects(
    confirmActionCompletion(early.store, {
      runId: early.aggregate.run.id,
      clientRequestId: "early-completion",
      effectiveAt: afterInstant(early.actionCall.completedAt!, -60_000),
      changeReference: "deploy/too-early",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "EFFECTIVE_AT_BEFORE_ACTION",
  );
});

test("P4.3A Action completion is idempotent, concurrent-safe, and never re-executes GitHub", async () => {
  const sequential = await executedFixtureAction();
  const input = {
    runId: sequential.aggregate.run.id,
    clientRequestId: "completion-idempotent",
    effectiveAt: afterInstant(sequential.actionCall.completedAt!),
    changeReference: "deploy/idempotent",
  };
  const first = await confirmActionCompletion(sequential.store, input);
  const replay = await confirmActionCompletion(sequential.store, input);
  assert.equal(replay.id, first.id);
  assert.equal(sequential.store.actionCompletions.size, 1);
  assert.equal(sequential.githubCalls, 2);

  const concurrent = await executedFixtureAction();
  const attempts = await Promise.allSettled([
    confirmActionCompletion(concurrent.store, {
      runId: concurrent.aggregate.run.id,
      clientRequestId: "completion-race-a",
      effectiveAt: afterInstant(concurrent.actionCall.completedAt!),
      changeReference: "deploy/race-a",
    }),
    confirmActionCompletion(concurrent.store, {
      runId: concurrent.aggregate.run.id,
      clientRequestId: "completion-race-b",
      effectiveAt: afterInstant(concurrent.actionCall.completedAt!),
      changeReference: "deploy/race-b",
    }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  assert.equal(concurrent.store.actionCompletions.size, 1);
  assert.equal((await concurrent.store.getAggregate(concurrent.aggregate.run.id))?.run.status,
    "WAITING_VERIFICATION");
  assert.equal(concurrent.githubCalls, 2);
});

test("P4.3A Action verification uses effectiveAt and freezes server policy", async () => {
  const completed = await completedFixtureAction("completion-for-verification");
  const result = await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-action-1",
  });
  assert.equal(result.verificationRun.anchorType, "ACTION_COMPLETION");
  assert.equal(result.verificationRun.anchorAt, completed.completion.effectiveAt);
  assert.equal(result.verificationRun.actionCompletionId, completed.completion.id);
  assert.ok(["PENDING", "WAITING_WINDOW"].includes(result.verificationRun.status));
  assert.equal(result.policySnapshot.anchorAt, completed.completion.effectiveAt);
  assert.equal(result.policySnapshot.policyVersion, "P4.3B_V1");
  assert.equal(result.policySnapshot.baselineValue, completed.aggregate.riskEvent?.baselineValue);
  assert.equal(result.policySnapshot.incidentObservedValue,
    completed.aggregate.riskEvent?.observedValue);
  assert.equal(result.policySnapshot.direction, completed.aggregate.riskEvent?.direction);
  assert.equal(result.policySnapshot.metricKey, completed.aggregate.riskEvent?.metricKey);
  assert.deepEqual(result.policySnapshot.affectedFilters,
    completed.aggregate.riskEvent?.filters);
  assert.equal(result.policySnapshot.controlFilters, null);
  assert.notEqual(result.policySnapshot.metricKey,
    completed.aggregate.diagnosis?.affectedMetrics[0]);
  assert.equal(result.policySnapshot.minimumSampleSize,
    completed.aggregate.riskEvent?.minSampleSize);
  const persisted = (await completed.store.getAggregate(completed.aggregate.run.id))!;
  const audit = persisted.auditEvents.find((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED");
  const trace = persisted.traceEvents.find((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED");
  assert.equal(audit?.proposedActionId, completed.aggregate.proposedAction?.id);
  assert.equal(audit?.approvalId, completed.aggregate.approval?.id);
  assert.equal(audit?.details.actionCompletionId, completed.completion.id);
  assert.equal(trace?.details.actionCompletionId, completed.completion.id);
});

test("P4.3A OBSERVE verification needs no ActionCompletion and anchors to Diagnosis", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.disposition = "OBSERVE";
  const observed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner: { type: "DETERMINISTIC", async plan() { return decision; } },
    analytics: setup.store.analytics,
  });
  const result = await createVerificationAttempt(setup.store, {
    runId: setup.runId,
    clientRequestId: "verification-observe-1",
  });
  assert.equal(observed?.run.status, "WAITING_VERIFICATION");
  assert.equal(observed?.actionCompletions.length, 0);
  assert.equal(observed?.proposedActions.length, 0);
  assert.equal(observed?.approvals.length, 0);
  assert.equal(result.verificationRun.anchorType, "OBSERVE_DIAGNOSIS");
  assert.equal(result.verificationRun.anchorAt, observed?.diagnosis?.createdAt);
  assert.equal(result.verificationRun.actionCompletionId, null);
  assert.deepEqual(result.policySnapshot.affectedFilters, observed?.riskEvent?.filters);
});

test("P4.3A OBSERVE revision ignores a superseded Action from the previous revision", async () => {
  const store = new MemoryStore();
  const first = await runFixtureInvestigation(store, "OBSERVE revision after superseded Action");
  await continueInvestigation(store, {
    runId: first.run.id,
    clientRequestId: "verification-observe-revision-continue",
    reason: "新证据表明无需外部 Action，改为持续观察。",
  });
  const reopened = (await store.getAggregate(first.run.id))!;
  const decision = groundedFinalizeDecision(reopened);
  decision.disposition = "OBSERVE";
  const observed = await runAgentLoop(store, {
    runId: first.run.id,
    planner: { type: "DETERMINISTIC", async plan() { return decision; } },
    analytics: store.analytics,
  });

  assert.equal(observed?.run.status, "WAITING_VERIFICATION");
  assert.equal(observed?.proposedActions.length, 1);
  assert.equal(observed?.proposedAction?.status, "SUPERSEDED");
  assert.equal(observed?.diagnosis?.disposition, "OBSERVE");
  const result = await createVerificationAttempt(store, {
    runId: first.run.id,
    clientRequestId: "verification-observe-revision-1",
  });
  assert.equal(result.verificationRun.anchorType, "OBSERVE_DIAGNOSIS");
  assert.equal(result.verificationRun.anchorAt, observed?.diagnosis?.createdAt);
  assert.equal(result.verificationRun.actionCompletionId, null);
  const persisted = (await store.getAggregate(first.run.id))!;
  const audit = persisted.auditEvents.find((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED");
  const trace = persisted.traceEvents.find((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED");
  assert.equal(audit?.proposedActionId, null);
  assert.equal(audit?.approvalId, null);
  assert.equal(audit?.details.actionCompletionId, null);
  assert.equal(trace?.details.proposedActionId, null);
  assert.equal(trace?.details.approvalId, null);
  assert.equal(trace?.details.actionCompletionId, null);
  assert.ok(persisted.proposedActions.some((item) => item.id === first.proposedAction?.id));
  assert.ok(persisted.approvals.some((item) => item.id === first.approval?.id));
});

test("P4.3A Action verification binds only the current Diagnosis revision", async () => {
  const store = new MemoryStore();
  const first = await runFixtureInvestigation(store, "Action revision source context");
  await continueInvestigation(store, {
    runId: first.run.id,
    clientRequestId: "verification-action-revision-continue",
    reason: "补充证据后生成新的 Action revision。",
  });
  const second = await submitInvestigationMessage(store, {
    runId: first.run.id,
    clientRequestId: "verification-action-revision-hypothesis",
    intent: "ADD_HYPOTHESIS",
    content: "异常可能主要集中在 Android 7.3.0 新用户。",
    planner: new DeterministicInvestigationPlanner(),
    analytics: store.analytics,
  });
  assert.equal(second?.diagnosis?.revision, 2);
  assert.notEqual(second?.proposedAction?.id, first.proposedAction?.id);
  const event = store.analytics.events.get(second!.riskEvent!.id)!;
  store.analytics.events.set(event.id, {
    ...event,
    filters: { ...event.filters, userType: "NEW" },
  });
  await decideProposedAction(store, {
    runId: first.run.id,
    proposedActionId: second!.proposedAction!.id,
    decision: "APPROVE",
    targetOwner: "example",
    targetRepo: "releaseguard-demo",
  });
  await executeApprovedGithubAction(store, {
    runId: first.run.id,
    proposedActionId: second!.proposedAction!.id,
    token: "test-token",
  }, async (_input, init) => {
    if (!init?.method) return Response.json([]);
    return Response.json({
      number: 94,
      title: "Revision 2 follow-up",
      html_url: "https://github.com/example/releaseguard-demo/issues/94",
      created_at: "2026-07-28T02:00:00.000Z",
    }, { status: 201 });
  });
  const executed = (await store.getAggregate(first.run.id))!;
  const actionCall = executed.toolCalls.find((item) =>
    item.proposedActionId === second!.proposedAction!.id)!;
  const completion = await confirmActionCompletion(store, {
    runId: first.run.id,
    clientRequestId: "completion-action-revision-2",
    effectiveAt: afterInstant(actionCall.completedAt!),
    changeReference: "deploy/revision-2",
  });
  await createVerificationAttempt(store, {
    runId: first.run.id,
    clientRequestId: "verification-action-revision-2",
  });
  const persisted = (await store.getAggregate(first.run.id))!;
  const audit = persisted.auditEvents.find((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED");
  const trace = persisted.traceEvents.find((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED");
  assert.equal(completion.revision, 2);
  assert.equal(audit?.proposedActionId, second?.proposedAction?.id);
  assert.equal(audit?.approvalId, second?.approval?.id);
  assert.equal(audit?.details.actionCompletionId, completion.id);
  assert.equal(trace?.details.diagnosisRevision, 2);
  assert.notEqual(audit?.proposedActionId, first.proposedAction?.id);
  assert.notEqual(audit?.approvalId, first.approval?.id);
});

test("P4.3A gates Verification creation and enforces one active attempt", async () => {
  const store = new MemoryStore();
  const pending = await runFixtureInvestigation(store, "not waiting verification");
  await assert.rejects(
    createVerificationAttempt(store, {
      runId: pending.run.id,
      clientRequestId: "verification-too-early",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "RUN_NOT_WAITING_VERIFICATION",
  );

  const completed = await completedFixtureAction("completion-active-verification");
  const first = await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-active-1",
  });
  const replay = await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-active-1",
  });
  assert.equal(replay.verificationRun.id, first.verificationRun.id);
  await assert.rejects(
    createVerificationAttempt(completed.store, {
      runId: completed.aggregate.run.id,
      clientRequestId: "verification-active-2",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "ACTIVE_VERIFICATION_EXISTS",
  );
});

test("P4.3A concurrent Verification creation produces one active attempt", async () => {
  const completed = await completedFixtureAction("completion-verification-race");
  const results = await Promise.allSettled([
    createVerificationAttempt(completed.store, {
      runId: completed.aggregate.run.id,
      clientRequestId: "verification-race-a",
    }),
    createVerificationAttempt(completed.store, {
      runId: completed.aggregate.run.id,
      clientRequestId: "verification-race-b",
    }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(completed.store.verificationRuns.size, 1);
  assert.equal(completed.store.verificationPolicies.size, 1);
});

test("P4.3A preserves completed Verification history when a later attempt is created", async () => {
  const completed = await completedFixtureAction("completion-history");
  const first = await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-history-1",
  });
  const completedAt = "2026-07-28T08:00:00.000Z";
  completed.store.verificationRuns.set(first.verificationRun.id, {
    ...first.verificationRun,
    status: "RESOLVED",
    completedAt,
    updatedAt: completedAt,
  });
  const immutableFirst = structuredClone(completed.store.verificationRuns.get(first.verificationRun.id));
  const second = await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-history-2",
  });
  assert.equal(second.verificationRun.attempt, 2);
  assert.deepEqual(completed.store.verificationRuns.get(first.verificationRun.id), immutableFirst);
  assert.equal((await listVerificationHistory(completed.store, completed.aggregate.run.id)).length, 2);
});

test("P4.3A API ignores client policy and target overrides", async () => {
  const completed = await completedFixtureAction("completion-policy-api");
  const response = await handleVerificationPost(new Request(
    `http://localhost/api/investigations/${completed.aggregate.run.id}/verifications`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "verification-policy-api",
        anchorAt: "1999-01-01T00:00:00.000Z",
        metricKey: "attacker_metric",
        affectedFilters: { region: "ATTACKER" },
        controlFilters: { userType: "ATTACKER" },
        policyVersion: "attacker-policy",
        verificationWindowMinutes: 1,
        minimumSampleSize: 1,
        metricRecoveryThreshold: 0,
      }),
    },
  ), completed.aggregate.run.id, completed.store);
  const payload = await response.json() as {
    verificationRun: VerificationRun;
    policySnapshot: VerificationPolicySnapshot;
  };
  assert.equal(response.status, 200);
  assert.equal(payload.verificationRun.anchorAt, completed.completion.effectiveAt);
  assert.equal(payload.policySnapshot.metricKey, completed.aggregate.riskEvent?.metricKey);
  assert.deepEqual(payload.policySnapshot.affectedFilters,
    completed.aggregate.riskEvent?.filters);
  assert.equal(payload.policySnapshot.controlFilters, null);
  assert.equal(payload.policySnapshot.policyVersion, "P4.3B_V1");
  assert.equal(payload.policySnapshot.verificationWindowMinutes, 120);
  assert.equal(payload.policySnapshot.minimumSampleSize,
    completed.aggregate.riskEvent?.minSampleSize);
  assert.equal(payload.policySnapshot.metricRecoveryThreshold, 0.9);
  const historyResponse = await handleVerificationGet(completed.aggregate.run.id, completed.store);
  const history = await historyResponse.json() as { verifications: unknown[] };
  assert.equal(history.verifications.length, 1);
});

test("P4.3A rejects unresolved canonical metric without partial Verification state", async () => {
  const observed = await observedGroundedInvestigation();
  const run = observed.store.runs.get(observed.runId)!;
  observed.store.runs.set(run.id, { ...run, riskEventId: null });
  for (const [id, call] of observed.store.calls) {
    if (call.name === "query_metric" || call.name === "segment_metric") {
      observed.store.calls.set(id, {
        ...call,
        arguments: { ...call.arguments, metric_key: "" },
      });
    }
  }
  for (const [id, claim] of observed.store.diagnosisClaims) {
    if (claim.diagnosisId === observed.aggregate.diagnosis?.id
      && claim.type === "AFFECTED_SEGMENT") {
      observed.store.diagnosisClaims.delete(id);
    }
  }

  await assert.rejects(
    createVerificationAttempt(observed.store, {
      runId: observed.runId,
      clientRequestId: "verification-unresolved-metric",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "VERIFICATION_TARGET_UNRESOLVED",
  );
  assert.equal(observed.store.verificationRuns.size, 0);
  assert.equal(observed.store.verificationPolicies.size, 0);
  assert.equal([...observed.store.audits.values()].filter((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED").length, 0);
});

test("P4.3A rejects natural-language segment without canonical filters", async () => {
  const observed = await observedGroundedInvestigation();
  const run = observed.store.runs.get(observed.runId)!;
  observed.store.runs.set(run.id, { ...run, riskEventId: null });
  await assert.rejects(
    createVerificationAttempt(observed.store, {
      runId: observed.runId,
      clientRequestId: "verification-unresolved-segment",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "VERIFICATION_TARGET_UNRESOLVED",
  );
  assert.equal(observed.store.verificationRuns.size, 0);
  assert.equal(observed.store.verificationPolicies.size, 0);
});

test("P4.3A rejects a segment dimension missing from RiskEvent filters", async () => {
  const observed = await observedGroundedInvestigation();
  const event = observed.store.analytics.events.get(observed.aggregate.riskEvent!.id)!;
  observed.store.analytics.events.set(event.id, {
    ...event,
    filters: { platform: "Android" },
  });

  await assert.rejects(
    createVerificationAttempt(observed.store, {
      runId: observed.runId,
      clientRequestId: "verification-partial-segment-filters",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "VERIFICATION_TARGET_UNRESOLVED",
  );
  assert.equal(observed.store.verificationRuns.size, 0);
  assert.equal(observed.store.verificationPolicies.size, 0);
  assert.equal([...observed.store.audits.values()].filter((event) =>
    event.type === "VERIFICATION_ATTEMPT_CREATED").length, 0);
});

test("P4.3A Verification Policy snapshot remains immutable and executable", async () => {
  const completed = await completedFixtureAction("completion-policy-immutable");
  const first = await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-policy-immutable",
  });
  const frozen = structuredClone(first.policySnapshot);
  const event = completed.store.analytics.events.get(completed.aggregate.riskEvent!.id)!;
  completed.store.analytics.events.set(event.id, {
    ...event,
    metricKey: "mutated_metric",
    filters: { region: "MUTATED" },
    minSampleSize: 1,
  });
  const replay = await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-policy-immutable",
  });
  assert.deepEqual(replay.policySnapshot, frozen);
  assert.equal(frozen.metricKey, completed.aggregate.riskEvent?.metricKey);
  assert.deepEqual(frozen.affectedFilters, completed.aggregate.riskEvent?.filters);
  assert.equal(frozen.controlFilters, null);
  assert.deepEqual(
    { metricKey: frozen.metricKey, filters: frozen.affectedFilters },
    {
      metricKey: completed.aggregate.riskEvent?.metricKey,
      filters: completed.aggregate.riskEvent?.filters,
    },
  );
});

test("P4.3A action-completion API persists server actor and immutable record", async () => {
  const executed = await executedFixtureAction();
  const response = await handleActionCompletionPost(new Request(
    `http://localhost/api/investigations/${executed.aggregate.run.id}/action-completion`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "completion-api",
        effectiveAt: afterInstant(executed.actionCall.completedAt!),
        changeReference: "deploy/api-confirmed",
        note: "API confirmation",
        confirmedBy: "attacker",
      }),
    },
  ), executed.aggregate.run.id, executed.store);
  const payload = await response.json() as { actionCompletion: ActionCompletion };
  assert.equal(response.status, 200);
  assert.equal(payload.actionCompletion.confirmedBy, "Product Manager · Workspace Owner");
  assert.equal(executed.store.actionCompletions.size, 1);
});

test("P4.3A legacy Action Run never fabricates effectiveAt", async () => {
  const legacy = await executedFixtureAction();
  await assert.rejects(
    legacy.store.transitionRun(legacy.aggregate.run.id, "WAITING_VERIFICATION"),
    /Protected InvestigationRun transition requires commitActionCompletion/,
  );
  const run = legacy.store.runs.get(legacy.aggregate.run.id)!;
  const diagnosis = legacy.store.diagnoses.get(legacy.aggregate.diagnosis!.id)!;
  legacy.store.runs.set(run.id, { ...run, status: "WAITING_VERIFICATION" });
  legacy.store.diagnoses.set(diagnosis.id, {
    ...diagnosis,
    groundingStatus: "LEGACY_UNVERIFIED",
  });
  await assert.rejects(
    createVerificationAttempt(legacy.store, {
      runId: legacy.aggregate.run.id,
      clientRequestId: "legacy-verification",
    }),
    (error: unknown) => error instanceof RuntimeRequestError
      && error.code === "LEGACY_ACTION_AWAITING_EFFECTIVE_TIME",
  );
  assert.equal(legacy.store.actionCompletions.size, 0);
  assert.equal(legacy.store.verificationRuns.size, 0);
});

test("P4.3A D1 completion and Verification creation each use one atomic batch", async () => {
  const completed = await completedFixtureAction("completion-d1-contract");
  await createVerificationAttempt(completed.store, {
    runId: completed.aggregate.run.id,
    clientRequestId: "verification-d1-contract",
  });
  assert.ok(completed.store.lastActionCompletionInput);
  assert.ok(completed.store.lastVerificationAttemptInput);

  const failedClient = new AtomicBatchD1Client();
  failedClient.failPattern = /insert into ["`]action_completions["`]/i;
  const failedDb = drizzle(failedClient as never, { schema: dbSchema });
  const failedStore = new D1InvestigationStore(async () => failedDb);
  await assert.rejects(
    failedStore.commitActionCompletion(
      structuredClone(completed.store.lastActionCompletionInput),
    ),
    /INJECTED_D1_BATCH_FAILURE/,
  );
  assert.equal(failedClient.batchCalls, 1);
  assert.deepEqual(failedClient.committedQueries, []);

  const client = new AtomicBatchD1Client();
  const db = drizzle(client as never, { schema: dbSchema });
  const d1Store = new D1InvestigationStore(async () => db);
  await d1Store.commitActionCompletion(
    structuredClone(completed.store.lastActionCompletionInput),
  );
  await d1Store.commitVerificationAttempt(
    structuredClone(completed.store.lastVerificationAttemptInput),
  );
  assert.equal(client.batchCalls, 2);
  const sqlText = client.committedQueries.join("\n");
  for (const table of [
    "action_completions",
    "verification_runs",
    "verification_policy_snapshots",
    "audit_events",
    "investigation_trace_events",
    "investigation_runs",
  ]) assert.match(sqlText, new RegExp(table));
});

test("Case B: rejection is persisted and never calls GitHub", async () => {
  const store = new MemoryStore();
  const initial = await runFixtureInvestigation(store, "Android case");
  const actionId = initial.proposedAction!.id;
  await decideProposedAction(store, {
    runId: initial.run.id,
    proposedActionId: actionId,
    decision: "REJECT",
    reason: "证据还不足",
  });
  const rejected = await store.getAggregate(initial.run.id);
  assert.equal(rejected?.run.status, "CLOSED_NO_ACTION");
  assert.equal(rejected?.approval?.status, "REJECTED");
  assert.equal(rejected?.proposedAction?.status, "REJECTED");
  assert.ok(rejected?.run.completedAt);
  assert.equal(
    rejected?.toolCalls.find((call) => call.proposedActionId === actionId)?.status,
    "DENIED",
  );
  assert.ok(rejected?.auditEvents.some((event) => event.type === "APPROVAL_REJECTED"));

  let called = false;
  await assert.rejects(
    executeApprovedGithubAction(store, {
      runId: initial.run.id,
      proposedActionId: actionId,
      token: "test-token",
    }, async () => {
      called = true;
      return Response.json([]);
    }),
    (error: unknown) =>
      error instanceof RuntimeRequestError && error.code === "APPROVAL_REQUIRED",
  );
  assert.equal(called, false);
});

test("Case C: forged and mismatched action requests are rejected", async () => {
  const store = new MemoryStore();
  const initial = await runFixtureInvestigation(store, "Android case");
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return Response.json([]);
  };

  await assert.rejects(
    executeApprovedGithubAction(store, {
      runId: initial.run.id,
      proposedActionId: initial.proposedAction!.id,
      token: "test-token",
    }, fetcher),
    (error: unknown) =>
      error instanceof RuntimeRequestError && error.code === "APPROVAL_REQUIRED",
  );
  await assert.rejects(
    executeApprovedGithubAction(store, {
      runId: initial.run.id,
      proposedActionId: "PA-forged",
      token: "test-token",
    }, fetcher),
    (error: unknown) =>
      error instanceof RuntimeRequestError && error.code === "ACTION_RUN_MISMATCH",
  );
  assert.equal(called, false);
});

test("Case C: legacy client-supplied issue content is rejected at the API boundary", async () => {
  const response = await githubIssueRoute(new Request("http://localhost/api/github-issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { owner: "attacker", repo: "wrong-target", token: "test-token" },
      incident: {
        title: "forged title",
        rootCause: "forged root cause",
        severity: "CRITICAL",
      },
    }),
  }));
  const payload = await response.json() as { code: string };
  assert.equal(response.status, 400);
  assert.equal(payload.code, "ACTION_REFERENCE_REQUIRED");
});

test("Case C: a valid approval cannot execute when the Run state is forged", async () => {
  const store = new MemoryStore();
  const initial = await runFixtureInvestigation(store, "Android case");
  await decideProposedAction(store, {
    runId: initial.run.id,
    proposedActionId: initial.proposedAction!.id,
    decision: "APPROVE",
    targetOwner: "example",
    targetRepo: "repo",
  });
  const run = store.runs.get(initial.run.id)!;
  store.runs.set(run.id, { ...run, status: "RUNNING" });
  await assert.rejects(
    executeApprovedGithubAction(store, {
      runId: run.id,
      proposedActionId: initial.proposedAction!.id,
      token: "test-token",
    }),
    (error: unknown) =>
      error instanceof RuntimeRequestError && error.code === "RUN_NOT_READY_FOR_ACTION",
  );
});

test("EMPTY and ERROR investigation ToolResults persist without bypassing grounded finalization", async () => {
  const store = new MemoryStore();
  const runId = await startInvestigation(store, {
    question: "测试空结果和错误结果",
    provider: "test",
    model: "fixture",
  });
  const emptyResult = await executeAndRecordTool(store, {
    runId,
    name: "search_user_feedback",
    args: { keyword: "__empty__" },
    iteration: 1,
    order: 1,
  });
  const errorResult = await executeAndRecordTool(store, {
    runId,
    name: "query_metrics",
    args: { version: "Android 7.3.0" },
    iteration: 1,
    order: 2,
  });
  assert.equal(emptyResult.result.status, "EMPTY");
  assert.equal(errorResult.result.status, "ERROR");
  const aggregate = await store.getAggregate(runId);
  assert.equal(aggregate?.run.status, "RUNNING");
  assert.equal(aggregate?.diagnosis, null);
  assert.equal(aggregate?.proposedAction, null);
});

test("invalid InvestigationRun transitions are rejected", () => {
  assert.doesNotThrow(
    () => assertRunTransition("RUNNING", "WAITING_VERIFICATION"),
  );
  assert.throws(
    () => assertRunTransition("RUNNING", "CLOSED_NO_ACTION"),
    /Invalid InvestigationRun transition/,
  );
  assert.doesNotThrow(
    () => assertRunTransition("ACTION_EXECUTING", "WAITING_ACTION_COMPLETION"),
  );
  assert.throws(
    () => assertRunTransition("ACTION_EXECUTING", "WAITING_VERIFICATION"),
    /Invalid InvestigationRun transition/,
  );
  assert.throws(
    () => assertRunTransition("WAITING_VERIFICATION", "RUNNING"),
    /Invalid InvestigationRun transition/,
  );
});

test("fixture helper remains callable", async () => {
  assert.equal((await fixture()).run.status, "WAITING_APPROVAL");
});

test("Phase 3 chat explanation is persisted and idempotent", async () => {
  const store = new MemoryStore();
  const aggregate = await runFixtureInvestigation(store, "Android case");
  const request = {
    runId: aggregate.run.id,
    clientRequestId: "chat-explain-1",
    intent: "EXPLAIN" as const,
    content: "为什么认为是重试与幂等锁冲突？",
    citedEvidenceIds: [aggregate.evidence[0].id],
  };
  const first = await submitInvestigationMessage(store, request);
  assert.equal(first?.messages.length, 2);
  assert.deepEqual(first?.messages[1].citedEvidenceIds, [aggregate.evidence[0].id]);
  const replay = await submitInvestigationMessage(store, request);
  assert.equal(replay?.messages.length, 2);
});

test("Phase 3 continue investigation preserves revision 1 and creates revision 2", async () => {
  const store = new MemoryStore();
  const first = await runFixtureInvestigation(store, "Android case");
  const oldDiagnosis = structuredClone(first.diagnosis);
  const oldSnapshot = structuredClone(first.approvalSnapshots[0]);
  const reopened = await continueInvestigation(store, {
    runId: first.run.id,
    clientRequestId: "continue-1",
    reason: "需要验证是否主要影响新用户",
  });
  assert.equal(reopened?.run.status, "RUNNING");
  assert.equal(reopened?.approval?.status, "WITHDRAWN");
  assert.equal(reopened?.proposedAction?.status, "SUPERSEDED");
  assert.equal(reopened?.approvalSnapshots[0].lifecycleStatus, "WITHDRAWN");
  assert.deepEqual(reopened?.approvalSnapshots[0].frozenPayload, oldSnapshot.frozenPayload);
  assert.equal(reopened?.approvalSnapshots[0].checksum, oldSnapshot.checksum);
  assert.deepEqual(reopened?.diagnoses[0], oldDiagnosis);

  const completed = await submitInvestigationMessage(store, {
    runId: first.run.id,
    clientRequestId: "hypothesis-1",
    intent: "ADD_HYPOTHESIS",
    content: "异常可能主要集中在 Android 7.3.0 新用户。",
    planner: new DeterministicInvestigationPlanner(),
    analytics: store.analytics,
  });
  assert.equal(completed?.run.status, "WAITING_APPROVAL");
  assert.equal(completed?.diagnoses.length, 2);
  assert.equal(completed?.diagnoses[1].revision, 2);
  assert.equal(completed?.proposedActions.length, 2);
  assert.equal(completed?.approvals.length, 2);
  assert.equal(completed?.approvalSnapshots.length, 2);
  assert.equal(completed?.approvalSnapshots[0].lifecycleStatus, "WITHDRAWN");
  assert.equal(completed?.approvalSnapshots[1].lifecycleStatus, "ACTIVE");
  assert.ok(completed?.toolCalls.some((item) =>
    item.triggerMessageId && item.name === "segment_metric"));
  assert.ok(completed?.hypotheses.some((item) =>
    item.createdBy === "HUMAN" && item.statement.includes("新用户")));
});

test("P4.1 stores competing hypotheses and never adds default SUPPORTS links", async () => {
  const { store, runId, event, hypotheses } = await runningInvestigationWithHypotheses();
  await executeAndRecordTool(store, {
    runId,
    name: "get_release",
    args: { release_id: "REL-ANDROID-730" },
    iteration: 1,
    order: 1,
    analytics: store.analytics,
  });
  await executeAndRecordTool(store, {
    runId,
    name: "query_metric",
    args: {
      metric_key: event.metricKey,
      start_time: event.firstBreachedAt,
      end_time: event.lastBreachedAt,
      filters: event.filters,
      granularity_minutes: 5,
      include_baseline: true,
    },
    iteration: 1,
    order: 2,
    analytics: store.analytics,
  });
  const beforeAssessment = await store.getAggregate(runId);
  assert.equal(beforeAssessment?.hypotheses.length, 2);
  assert.equal(beforeAssessment?.evidence.length, 2);
  assert.equal(beforeAssessment?.hypothesisEvidenceLinks.length, 0);

  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan(context) {
      const linked = new Set(context.aggregate.hypothesisEvidenceLinks.map((item) => item.evidenceId));
      const pending = context.aggregate.evidence.filter((item) => !linked.has(item.id));
      if (pending.length > 0) {
        return {
          type: "ASSESS_EVIDENCE",
          assessments: pending.map((item) => ({
            evidenceId: item.id,
            relations: hypotheses.map((candidate, index) => ({
              targetHypothesisId: candidate.id,
              relation: index === 0 ? "SUPPORTS" as const : "NEUTRAL" as const,
              explanation: "批量显式评价当前证据。",
            })),
          })),
          rationale: "一次评价两个 Evidence 与两个 Hypothesis。",
        };
      }
      return {
        type: "STOP_INCONCLUSIVE",
        reason: "测试完成",
        rationale: "评价已持久化，结束测试运行。",
      };
    },
  };
  const completed = await runAgentLoop(store, { runId, planner, analytics: store.analytics });
  assert.equal(completed?.hypothesisEvidenceLinks.length, 4);
  assert.deepEqual(
    new Set(completed?.hypothesisEvidenceLinks.map((item) => item.relation)),
    new Set(["SUPPORTS", "NEUTRAL"]),
  );
  assert.equal(completed?.hypotheses[0].confidence, "HIGH");
  assert.equal(completed?.hypotheses[0].status, "SUPPORTED");
  assert.equal(completed?.hypotheses[1].supportScore, 0);
  assert.equal(completed?.hypotheses[1].status, "ACTIVE");
});

test("P4.1 blocks CALL_TOOL while Evidence assessment is pending", async () => {
  const { store, runId, hypotheses } = await runningInvestigationWithHypotheses();
  await executeAndRecordTool(store, {
    runId,
    name: "get_release",
    args: { release_id: "REL-ANDROID-730" },
    iteration: 1,
    order: 1,
    analytics: store.analytics,
  });
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() {
      return {
        type: "CALL_TOOL",
        toolName: "query_metric",
        arguments: {},
        targetHypothesisIds: hypotheses.map((item) => item.id),
        testIntent: "DISCRIMINATE",
        rationale: "尝试绕过 pending Evidence gate。",
      };
    },
  };
  await assert.rejects(
    runAgentLoop(store, { runId, planner, analytics: store.analytics }),
    /PENDING_EVIDENCE_ASSESSMENT/,
  );
  assert.equal(store.calls.size, 1);
  assert.equal((await store.getAggregate(runId))?.run.status, "FAILED");
});

test("P4.1 blocks FINALIZE and incomplete assessment while Evidence is pending", async () => {
  const finalizeCase = await runningInvestigationWithHypotheses();
  await executeAndRecordTool(finalizeCase.store, {
    runId: finalizeCase.runId,
    name: "get_release",
    args: { release_id: "REL-ANDROID-730" },
    iteration: 1,
    order: 1,
    analytics: finalizeCase.store.analytics,
  });
  const finalizePlanner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() {
      return {
        type: "FINALIZE",
        selectedHypothesisId: finalizeCase.hypotheses[0].id,
        diagnosis: { summary: "待评价 Evidence 不得绕过。", claims: [] },
        disposition: "FIX",
        rationale: "尝试绕过 pending Evidence gate。",
      };
    },
  };
  await assert.rejects(
    runAgentLoop(finalizeCase.store, {
      runId: finalizeCase.runId,
      planner: finalizePlanner,
      analytics: finalizeCase.store.analytics,
    }),
    /PENDING_EVIDENCE_ASSESSMENT/,
  );
  assert.equal((await finalizeCase.store.getAggregate(finalizeCase.runId))?.diagnosis, null);

  const incompleteCase = await runningInvestigationWithHypotheses();
  await executeAndRecordTool(incompleteCase.store, {
    runId: incompleteCase.runId,
    name: "get_release",
    args: { release_id: "REL-ANDROID-730" },
    iteration: 1,
    order: 1,
    analytics: incompleteCase.store.analytics,
  });
  const evidenceId = (await incompleteCase.store.getAggregate(incompleteCase.runId))!.evidence[0].id;
  const incompletePlanner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() {
      return {
        type: "ASSESS_EVIDENCE",
        assessments: [{
          evidenceId,
          relations: [{
            targetHypothesisId: incompleteCase.hypotheses[0].id,
            relation: "SUPPORTS",
            explanation: "故意漏掉第二个 Active Hypothesis。",
          }],
        }],
        rationale: "无效的部分评价。",
      };
    },
  };
  await assert.rejects(
    runAgentLoop(incompleteCase.store, {
      runId: incompleteCase.runId,
      planner: incompletePlanner,
      analytics: incompleteCase.store.analytics,
    }),
    /必须评价所有 Active Hypothesis/,
  );
  assert.equal(incompleteCase.store.hypothesisLinks.size, 0);
});

test("P4.1 treats a legacy partial Evidence x Hypothesis matrix as pending", async () => {
  const setup = await runningInvestigationWithPartialMatrix();
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan(context) {
      const active = context.aggregate.hypotheses.filter((item) => item.status !== "REJECTED");
      const links = new Set(context.aggregate.hypothesisEvidenceLinks.map((item) =>
        `${item.evidenceId}:${item.hypothesisId}`));
      const pending = context.aggregate.evidence.filter((evidence) =>
        active.some((candidate) => !links.has(`${evidence.id}:${candidate.id}`)));
      if (pending.length > 0) {
        return {
          type: "ASSESS_EVIDENCE",
          assessments: pending.map((evidence) => ({
            evidenceId: evidence.id,
            relations: active.map((candidate) => ({
              targetHypothesisId: candidate.id,
              relation: candidate.id === setup.hypotheses[0].id
                ? "SUPPORTS" as const
                : "NEUTRAL" as const,
              explanation: "补齐 legacy partial matrix。",
            })),
          })),
          rationale: "历史 Evidence 必须重新形成完整显式矩阵。",
        };
      }
      return {
        type: "ASK_HUMAN",
        question: "矩阵已完整，是否继续？",
        rationale: "暂停以检查持久化结果。",
      };
    },
  };
  const completed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner,
    analytics: setup.store.analytics,
  });
  const links = completed!.hypothesisEvidenceLinks.filter((item) =>
    item.evidenceId === setup.evidenceId);
  assert.equal(links.length, 3);
  assert.equal(new Set(links.map((item) => item.hypothesisId)).size, 3);
  assert.equal(links.filter((item) => item.linkedBy === "RUNTIME").length, 1);
  assert.equal(links.filter((item) => item.linkedBy === "AGENT").length, 2);
  assert.equal(completed?.run.status, "WAITING_HUMAN_INPUT");
});

test("P4.1 partial matrix blocks both CALL_TOOL and FINALIZE", async () => {
  const callCase = await runningInvestigationWithPartialMatrix();
  const callPlanner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() {
      return {
        type: "CALL_TOOL",
        toolName: "query_metric",
        arguments: {},
        targetHypothesisIds: callCase.hypotheses.map((item) => item.id),
        testIntent: "DISCRIMINATE",
        rationale: "尝试绕过 partial matrix gate。",
      };
    },
  };
  await assert.rejects(
    runAgentLoop(callCase.store, {
      runId: callCase.runId,
      planner: callPlanner,
      analytics: callCase.store.analytics,
    }),
    /PENDING_EVIDENCE_ASSESSMENT/,
  );
  assert.equal(callCase.store.calls.size, 1);

  const finalizeCase = await runningInvestigationWithPartialMatrix();
  const finalizePlanner: InvestigationPlanner = {
    type: "LLM",
    async plan() {
      return {
        type: "FINALIZE",
        selectedHypothesisId: finalizeCase.hypotheses[0].id,
        diagnosis: { summary: "Partial matrix 不得绕过。", claims: [] },
        disposition: "FIX",
        rationale: "尝试绕过 partial matrix gate。",
      };
    },
  };
  await assert.rejects(
    runAgentLoop(finalizeCase.store, {
      runId: finalizeCase.runId,
      planner: finalizePlanner,
      analytics: finalizeCase.store.analytics,
    }),
    /PENDING_EVIDENCE_ASSESSMENT/,
  );
  assert.equal((await finalizeCase.store.getAggregate(finalizeCase.runId))?.diagnosis, null);
});

test("P4.1 adding H3 makes previously assessed Evidence pending again", async () => {
  const setup = await runningInvestigationWithHypotheses();
  await executeAndRecordTool(setup.store, {
    runId: setup.runId,
    name: "get_release",
    args: { release_id: "REL-ANDROID-730" },
    iteration: 1,
    order: 1,
    analytics: setup.store.analytics,
  });
  const matrixPlanner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan(context) {
      const active = context.aggregate.hypotheses.filter((item) => item.status !== "REJECTED");
      const pairs = new Set(context.aggregate.hypothesisEvidenceLinks.map((item) =>
        `${item.evidenceId}:${item.hypothesisId}`));
      const pending = context.aggregate.evidence.filter((evidence) =>
        active.some((candidate) => !pairs.has(`${evidence.id}:${candidate.id}`)));
      if (pending.length > 0) {
        return {
          type: "ASSESS_EVIDENCE",
          assessments: pending.map((evidence) => ({
            evidenceId: evidence.id,
            relations: active.map((candidate) => ({
              targetHypothesisId: candidate.id,
              relation: "NEUTRAL" as const,
              explanation: "对当前全部 Active Hypothesis 显式补评。",
            })),
          })),
          rationale: "补齐新增 Hypothesis 后的 Evidence matrix。",
        };
      }
      return {
        type: "ASK_HUMAN",
        question: "矩阵已完整。",
        rationale: "测试暂停。",
      };
    },
  };
  const initiallyAssessed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner: matrixPlanner,
    analytics: setup.store.analytics,
  });
  assert.equal(initiallyAssessed?.hypothesisEvidenceLinks.length, 2);

  const afterHuman = await submitInvestigationMessage(setup.store, {
    runId: setup.runId,
    clientRequestId: "add-h3-after-assessment",
    intent: "ADD_HYPOTHESIS",
    content: "指标采集缺陷造成假性下降",
    planner: matrixPlanner,
    analytics: setup.store.analytics,
  });
  assert.equal(afterHuman?.hypotheses.filter((item) => item.status !== "REJECTED").length, 3);
  assert.equal(afterHuman?.hypothesisEvidenceLinks.length, 3);
  assert.equal(
    new Set(afterHuman?.hypothesisEvidenceLinks.map((item) => item.hypothesisId)).size,
    3,
  );
});

test("P4.1 serializes concurrent human hypotheses at the three-active limit", async () => {
  const setup = await runningInvestigationWithHypotheses();
  const pausePlanner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() {
      return {
        type: "ASK_HUMAN",
        question: "测试暂停。",
        rationale: "人工新增完成后暂停。",
      };
    },
  };
  const results = await Promise.allSettled([
    submitInvestigationMessage(setup.store, {
      runId: setup.runId,
      clientRequestId: "concurrent-h3-a",
      intent: "ADD_HYPOTHESIS",
      content: "并发候选假设 A",
      planner: pausePlanner,
      analytics: setup.store.analytics,
    }),
    submitInvestigationMessage(setup.store, {
      runId: setup.runId,
      clientRequestId: "concurrent-h3-b",
      intent: "ADD_HYPOTHESIS",
      content: "并发候选假设 B",
      planner: pausePlanner,
      analytics: setup.store.analytics,
    }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  const aggregate = await setup.store.getAggregate(setup.runId);
  assert.equal(aggregate?.hypotheses.filter((item) => item.status !== "REJECTED").length, 3);
});

test("P4.1 rejects a fourth human hypothesis and legacy over-limit recovery", async () => {
  const atLimit = await runningInvestigationWithHypotheses();
  await atLimit.store.saveHypotheses([
    hypothesis(atLimit.runId, "HYP-THIRD", "第三个有效假设"),
  ]);
  const pausePlanner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() {
      return {
        type: "ASK_HUMAN",
        question: "测试暂停。",
        rationale: "不应执行。",
      };
    },
  };
  await assert.rejects(
    submitInvestigationMessage(atLimit.store, {
      runId: atLimit.runId,
      clientRequestId: "fourth-hypothesis",
      intent: "ADD_HYPOTHESIS",
      content: "不允许的第四个假设",
      planner: pausePlanner,
      analytics: atLimit.store.analytics,
    }),
    /最多同时保留三个/,
  );
  assert.equal((await atLimit.store.getAggregate(atLimit.runId))?.hypotheses.length, 3);

  const legacy = await runningInvestigationWithHypotheses();
  await legacy.store.saveHypotheses([
    hypothesis(legacy.runId, "HYP-LEGACY-3", "Legacy 假设 3"),
    hypothesis(legacy.runId, "HYP-LEGACY-4", "Legacy 假设 4"),
  ]);
  let plannerCalled = false;
  const planner: InvestigationPlanner = {
    type: "LLM",
    async plan() {
      plannerCalled = true;
      return {
        type: "STOP_INCONCLUSIVE",
        reason: "不应执行",
        rationale: "不应执行",
      };
    },
  };
  await assert.rejects(
    runAgentLoop(legacy.store, {
      runId: legacy.runId,
      planner,
      analytics: legacy.store.analytics,
    }),
    /ACTIVE_HYPOTHESIS_LEGACY_INVARIANT/,
  );
  assert.equal(plannerCalled, false);
  assert.equal((await legacy.store.getAggregate(legacy.runId))?.hypotheses.length, 4);
});

test("P4.1 Continue Investigation refuses a legacy over-limit Run without withdrawing approval", async () => {
  const store = new MemoryStore();
  const aggregate = await runFixtureInvestigation(store, "Android legacy limit case");
  await store.saveHypotheses([
    hypothesis(aggregate.run.id, "HYP-LEGACY-4", "迁移前遗留的第四个有效假设"),
    hypothesis(aggregate.run.id, "HYP-LEGACY-5", "迁移前遗留的第五个有效假设"),
  ]);
  await assert.rejects(
    continueInvestigation(store, {
      runId: aggregate.run.id,
      clientRequestId: "continue-over-limit",
      reason: "不应绕过 active hypothesis limit",
    }),
    /ACTIVE_HYPOTHESIS_LEGACY_INVARIANT/,
  );
  const unchanged = await store.getAggregate(aggregate.run.id);
  assert.equal(unchanged?.run.status, "WAITING_APPROVAL");
  assert.equal(unchanged?.approval?.status, "PENDING");
  assert.equal(unchanged?.hypotheses.filter((item) => item.status !== "REJECTED").length, 4);
});

test("P4.1 rejects FINALIZE from both planner types when all hypotheses are rejected", async () => {
  for (const plannerType of ["LLM", "DETERMINISTIC"] as const) {
    const setup = await runningInvestigationWithHypotheses();
    for (const item of setup.hypotheses) {
      await setup.store.updateHypothesis({ ...item, status: "REJECTED" });
    }
    const planner: InvestigationPlanner = {
      type: plannerType,
      async plan() {
        return {
          type: "FINALIZE",
          selectedHypothesisId: setup.hypotheses[0].id,
          diagnosis: {
            summary: "恶意尝试在没有有效假设时输出结论。",
            claims: [{
              type: "ROOT_CAUSE",
              statement: setup.hypotheses[0].statement,
              evidenceIds: [],
            }],
          },
          disposition: "FIX",
          rationale: "恶意尝试在没有有效假设时输出 HIGH。",
        };
      },
    };
    await assert.rejects(
      runAgentLoop(setup.store, {
        runId: setup.runId,
        planner,
        analytics: setup.store.analytics,
      }),
      /NO_ACTIVE_HYPOTHESIS/,
    );
    const failed = await setup.store.getAggregate(setup.runId);
    assert.equal(failed?.diagnosis, null);
    assert.equal(failed?.run.status, "FAILED");
  }
});

test("P4.2 persists a ROOT_CAUSE grounded by current Run Evidence", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() {
      return decision;
    },
  };
  const completed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner,
    analytics: setup.store.analytics,
  });
  assert.equal(completed?.run.status, "WAITING_APPROVAL");
  assert.equal(completed?.diagnosis?.groundingStatus, "GROUNDED");
  assert.equal(completed?.diagnosis?.selectedHypothesisId, decision.selectedHypothesisId);
  assert.equal(completed?.diagnosis?.confidence, "HIGH");
  const rootClaim = completed?.diagnosisClaims.find((item) => item.type === "ROOT_CAUSE");
  assert.ok(rootClaim);
  assert.ok(completed?.diagnosisClaimEvidenceLinks.some((item) =>
    item.claimId === rootClaim.id));
  assert.ok(completed?.proposedAction);
  assert.ok(completed?.approval);
});

test("P4.2 rejects ROOT_CAUSE without Evidence and creates no action or approval", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.diagnosis.claims.find((item) => item.type === "ROOT_CAUSE")!.evidenceIds = [];
  const planner: InvestigationPlanner = { type: "LLM", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /UNGROUNDED_CRITICAL_CLAIM/,
  );
  const failed = await setup.store.getAggregate(setup.runId);
  assert.equal(failed?.diagnosis, null);
  assert.equal(failed?.proposedAction, null);
  assert.equal(failed?.approval, null);
});

test("P4.2 rejects a Claim that cites Evidence from another Run", async () => {
  const setup = await groundedReadyInvestigation();
  const other = await groundedReadyInvestigation();
  const foreignEvidenceId = other.aggregate.evidence[0].id;
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.diagnosis.claims.find((item) => item.type === "ROOT_CAUSE")!.evidenceIds = [
    foreignEvidenceId,
  ];
  const planner: InvestigationPlanner = { type: "DETERMINISTIC", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /CROSS_RUN_EVIDENCE/,
  );
  assert.equal((await setup.store.getAggregate(setup.runId))?.diagnosis, null);
});

test("P4.2 rejects a RAG-only ROOT_CAUSE", async () => {
  const setup = await groundedReadyInvestigation();
  const ragEvidence: Evidence = {
    id: "EV-RAG-ONLY",
    runId: setup.runId,
    toolResultId: "TR-RAG-ONLY",
    category: "SIMILAR_INCIDENT",
    statement: "历史事故症状相似。",
    source: "Historical Incident Memory",
    strength: "HIGH",
    provenance: "public_reference",
    collectedAt: new Date().toISOString(),
  };
  await setup.store.saveEvidence([ragEvidence]);
  await setup.store.saveHypothesisEvidenceLinks(setup.hypotheses.map((candidate, index) =>
    hypothesisLink(
      setup.runId,
      ragEvidence.id,
      candidate.id,
      index === 0 ? "SUPPORTS" : "NEUTRAL",
    )));
  const aggregate = (await setup.store.getAggregate(setup.runId))!;
  const decision = groundedFinalizeDecision(aggregate);
  decision.diagnosis.claims.find((item) => item.type === "ROOT_CAUSE")!.evidenceIds = [
    ragEvidence.id,
  ];
  const planner: InvestigationPlanner = { type: "LLM", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /RAG_ONLY_ROOT_CAUSE/,
  );
});

test("P4.2 allows a LIMITATION without Evidence", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  const planner: InvestigationPlanner = { type: "DETERMINISTIC", async plan() { return decision; } };
  const completed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner,
    analytics: setup.store.analytics,
  });
  const limitation = completed?.diagnosisClaims.find((item) => item.type === "LIMITATION");
  assert.ok(limitation);
  assert.equal(
    completed?.diagnosisClaimEvidenceLinks.some((item) => item.claimId === limitation.id),
    false,
  );
  assert.equal(limitation.limitationType, "SCOPE_LIMITATION");
});

test("P4.2 accepts structured evidence-free limitation boundaries", async () => {
  const cases = [
    {
      limitationType: "DATA_GAP" as const,
      statement: "当前没有客户端 trace，因此无法确认具体重试机制。",
    },
    {
      limitationType: "SCOPE_LIMITATION" as const,
      statement: "反馈数据仅覆盖 US 用户，无法判断其他地区影响。",
    },
    {
      limitationType: "UNRESOLVED_UNCERTAINTY" as const,
      statement: "当前无法排除尚未接入的第三方依赖因素。",
    },
    {
      limitationType: "OBSERVABILITY_LIMITATION" as const,
      statement: "支付网关状态不可用，因此无法排除第三方故障。",
    },
  ];
  for (const boundary of cases) {
    const setup = await groundedReadyInvestigation();
    const decision = groundedFinalizeDecision(setup.aggregate);
    const limitation = decision.diagnosis.claims.find((item) => item.type === "LIMITATION");
    assert.ok(limitation && limitation.type === "LIMITATION");
    limitation.limitationType = boundary.limitationType;
    limitation.statement = boundary.statement;
    const completed = await runAgentLoop(setup.store, {
      runId: setup.runId,
      planner: { type: "DETERMINISTIC", async plan() { return decision; } },
      analytics: setup.store.analytics,
    });
    assert.equal(completed?.diagnosis?.groundingStatus, "GROUNDED");
  }
});

test("P4.2 rejects critical factual assertions disguised as LIMITATION", async () => {
  const cases = [
    {
      limitationType: "UNRESOLVED_UNCERTAINTY" as const,
      statement: "根因就是支付系统故障，可能影响所有用户。",
    },
    {
      limitationType: "UNRESOLVED_UNCERTAINTY" as const,
      statement: "新用户可能是主要受影响人群，目前尚不能完全确认。",
    },
    {
      limitationType: "UNRESOLVED_UNCERTAINTY" as const,
      statement: "指标下降可能来自第三方故障。",
    },
    {
      limitationType: "UNRESOLVED_UNCERTAINTY" as const,
      statement: "7.3.0 的重试逻辑导致转化下降，但仍有一些不确定性。",
    },
  ];
  for (const disguisedClaim of cases) {
    const setup = await groundedReadyInvestigation();
    const decision = groundedFinalizeDecision(setup.aggregate);
    const limitation = decision.diagnosis.claims.find((item) => item.type === "LIMITATION");
    assert.ok(limitation && limitation.type === "LIMITATION");
    limitation.limitationType = disguisedClaim.limitationType;
    limitation.statement = disguisedClaim.statement;
    await assert.rejects(
      runAgentLoop(setup.store, {
        runId: setup.runId,
        planner: { type: "LLM", async plan() { return decision; } },
        analytics: setup.store.analytics,
      }),
      /LIMITATION_(?:CONTAINS_CRITICAL_ASSERTION|BOUNDARY|SHAPE)/,
    );
    const failed = await setup.store.getAggregate(setup.runId);
    assert.equal(failed?.diagnoses.length, 0);
    assert.equal(failed?.proposedActions.length, 0);
    assert.equal(failed?.approvals.length, 0);
  }
});

test("P4.2 rejects a factual LIMITATION even when it cites Evidence", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  const limitation = decision.diagnosis.claims.find((item) => item.type === "LIMITATION");
  assert.ok(limitation && limitation.type === "LIMITATION");
  limitation.limitationType = "UNRESOLVED_UNCERTAINTY";
  limitation.statement = "当前无法确认全部影响范围，但新用户是主要受影响人群。";
  limitation.evidenceIds = [setup.aggregate.evidence[0].id];
  await assert.rejects(
    runAgentLoop(setup.store, {
      runId: setup.runId,
      planner: { type: "LLM", async plan() { return decision; } },
      analytics: setup.store.analytics,
    }),
    /INVALID_LIMITATION_SHAPE|LIMITATION_CONTAINS_CRITICAL_ASSERTION/,
  );
  const failed = await setup.store.getAggregate(setup.runId);
  assert.equal(failed?.diagnoses.length, 0);
  assert.equal(failed?.proposedActions.length, 0);
});

test("P4.2 does not use LIMITATION Evidence as Action grounding", async () => {
  const setup = await groundedReadyInvestigation();
  const limitationOnlyEvidence: Evidence = {
    id: `EV-LIMITATION-${crypto.randomUUID()}`,
    runId: setup.runId,
    toolResultId: setup.aggregate.evidence[0].toolResultId,
    category: "SIMILAR_INCIDENT",
    statement: "历史事故只说明尚有未覆盖场景。",
    source: "Historical Incident Memory",
    strength: "LOW",
    provenance: "public_reference",
    collectedAt: new Date().toISOString(),
  };
  await setup.store.saveEvidence([limitationOnlyEvidence]);
  await setup.store.saveHypothesisEvidenceLinks(setup.hypotheses.map((candidate) =>
    hypothesisLink(setup.runId, limitationOnlyEvidence.id, candidate.id, "NEUTRAL")));
  const aggregate = (await setup.store.getAggregate(setup.runId))!;
  const decision = groundedFinalizeDecision(aggregate);
  const limitation = decision.diagnosis.claims.find((item) => item.type === "LIMITATION");
  assert.ok(limitation && limitation.type === "LIMITATION");
  limitation.evidenceIds = [limitationOnlyEvidence.id];
  const criticalEvidenceCount = new Set(decision.diagnosis.claims
    .filter((claim) => claim.type !== "LIMITATION")
    .flatMap((claim) => claim.evidenceIds)).size;
  const completed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner: { type: "DETERMINISTIC", async plan() { return decision; } },
    analytics: setup.store.analytics,
  });
  assert.equal(completed?.proposedAction?.arguments.evidenceCount, criticalEvidenceCount);
  assert.doesNotMatch(completed?.proposedAction?.rationale ?? "", /历史事故|未覆盖场景/);
});

test("P4.2 rejects AFFECTED_METRIC without Evidence", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.diagnosis.claims.find((item) => item.type === "AFFECTED_METRIC")!.evidenceIds = [];
  const planner: InvestigationPlanner = { type: "DETERMINISTIC", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /UNGROUNDED_CRITICAL_CLAIM/,
  );
});

test("P4.2 rejects a ROOT_CAUSE that contradicts the selected Hypothesis", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.diagnosis.claims.find((item) => item.type === "ROOT_CAUSE")!.statement =
    "第三方依赖故障导致领券失败";
  const planner: InvestigationPlanner = { type: "LLM", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /ROOT_CAUSE_HYPOTHESIS_MISMATCH/,
  );
});

test("P4.2 rejects a REJECTED selected Hypothesis", async () => {
  const setup = await groundedReadyInvestigation();
  const rejected = setup.aggregate.hypotheses.find((item) => item.status === "REJECTED")!;
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.selectedHypothesisId = rejected.id;
  decision.diagnosis.claims.find((item) => item.type === "ROOT_CAUSE")!.statement =
    rejected.statement;
  const planner: InvestigationPlanner = { type: "DETERMINISTIC", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /REJECTED_HYPOTHESIS/,
  );
});

test("P4.2 rejects ACTIVE/LOW selected Hypothesis without a Finalize policy exception", async () => {
  const setup = await runningInvestigationWithHypotheses();
  const decision: Extract<InvestigationDecision, { type: "FINALIZE" }> = {
    type: "FINALIZE",
    selectedHypothesisId: setup.hypotheses[0].id,
    diagnosis: {
      summary: "低置信假设不得形成高置信结论。",
      claims: [{
        type: "ROOT_CAUSE",
        statement: setup.hypotheses[0].statement,
        evidenceIds: [],
      }],
    },
    disposition: "ESCALATE",
    rationale: "尝试绕过 finalization policy。",
  };
  const planner: InvestigationPlanner = { type: "LLM", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /HYPOTHESIS_NOT_FINALIZABLE/,
  );
});

test("P4.2 rejects critical Claim supported only by CONTRADICTS Evidence", async () => {
  const setup = await groundedReadyInvestigation();
  const contradicting: Evidence = {
    id: "EV-CONTRADICTING-ONLY",
    runId: setup.runId,
    toolResultId: "TR-CONTRADICTING-ONLY",
    category: "DATA_QUALITY",
    statement: "该证据直接反驳所选根因机制。",
    source: "test",
    strength: "HIGH",
    provenance: "runtime_generated",
    collectedAt: new Date().toISOString(),
  };
  await setup.store.saveEvidence([contradicting]);
  await setup.store.saveHypothesisEvidenceLinks(setup.hypotheses.map((candidate, index) =>
    hypothesisLink(
      setup.runId,
      contradicting.id,
      candidate.id,
      index === 0 ? "CONTRADICTS" : "NEUTRAL",
    )));
  const aggregate = (await setup.store.getAggregate(setup.runId))!;
  const decision = groundedFinalizeDecision(aggregate);
  decision.diagnosis.claims.find((item) => item.type === "CAUSAL_STEP")!.evidenceIds = [
    contradicting.id,
  ];
  const planner: InvestigationPlanner = { type: "DETERMINISTIC", async plan() { return decision; } };
  await assert.rejects(
    runAgentLoop(setup.store, { runId: setup.runId, planner, analytics: setup.store.analytics }),
    /UNSUPPORTED_CLAIM_EVIDENCE/,
  );
});

test("P4.2 ignores planner confidence and derives Diagnosis confidence from selected Hypothesis", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  const malicious = {
    ...decision,
    diagnosis: { ...decision.diagnosis, confidence: "LOW", groundingStatus: "GROUNDED" },
  } as unknown as InvestigationDecision;
  const planner: InvestigationPlanner = { type: "LLM", async plan() { return malicious; } };
  const completed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner,
    analytics: setup.store.analytics,
  });
  assert.equal(completed?.diagnosis?.confidence, "HIGH");
  assert.equal(completed?.diagnosis?.groundingStatus, "GROUNDED");
});

test("P4.2 FINALIZE rolls back every artifact at each injected persistence stage", async () => {
  const failurePoints = [
    "DIAGNOSIS",
    "ACTION",
    "APPROVAL",
    "SNAPSHOT",
    "TOOL_CALL",
    "AUDIT",
    "RUN_TRANSITION",
  ] as const;
  for (const failurePoint of failurePoints) {
    const setup = await groundedReadyInvestigation();
    const decision = groundedFinalizeDecision(setup.aggregate);
    setup.store.failNextGroundedFinalizationAt = failurePoint;
    await assert.rejects(
      runAgentLoop(setup.store, {
        runId: setup.runId,
        planner: { type: "DETERMINISTIC", async plan() { return decision; } },
        analytics: setup.store.analytics,
      }),
      new RegExp(`INJECTED_FINALIZATION_${failurePoint}_FAILURE`),
    );
    const failed = await setup.store.getAggregate(setup.runId);
    assert.equal(failed?.diagnoses.length, 0, `${failurePoint}: Diagnosis leaked`);
    assert.equal(failed?.diagnosisClaims.length, 0, `${failurePoint}: Claim leaked`);
    assert.equal(failed?.diagnosisClaimEvidenceLinks.length, 0, `${failurePoint}: Claim link leaked`);
    assert.equal(failed?.proposedActions.length, 0, `${failurePoint}: Action leaked`);
    assert.equal(failed?.approvals.length, 0, `${failurePoint}: Approval leaked`);
    assert.equal(failed?.approvalSnapshots.length, 0, `${failurePoint}: Snapshot leaked`);
    assert.equal(
      failed?.toolCalls.some((call) => call.proposedActionId !== null),
      false,
      `${failurePoint}: Action ToolCall leaked`,
    );
    assert.equal(
      failed?.auditEvents.some((event) => event.type === "DIAGNOSIS_FINALIZED"),
      false,
      `${failurePoint}: finalize audit leaked`,
    );
    assert.equal(
      failed?.traceEvents.some((event) =>
        event.type === "PLANNER_DECISION" && event.details.decisionType === "FINALIZE"),
      false,
      `${failurePoint}: finalize trace leaked`,
    );
  }
});

test("P4.2 D1 and MemoryStore use the same single-batch FINALIZE contract", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner: { type: "DETERMINISTIC", async plan() { return decision; } },
    analytics: setup.store.analytics,
  });
  const commit = setup.store.lastGroundedFinalizationInput;
  assert.ok(commit);

  const client = new AtomicBatchD1Client();
  const db = drizzle(client as never, { schema: dbSchema });
  const d1Store = new D1InvestigationStore(async () => db);
  client.failPattern = /insert into ["`]approval_snapshots["`]/i;
  await assert.rejects(
    d1Store.finalizeGroundedInvestigation(structuredClone(commit)),
    /INJECTED_D1_BATCH_FAILURE/,
  );
  assert.equal(client.batchCalls, 1);
  assert.deepEqual(client.committedQueries, []);

  client.failPattern = null;
  await d1Store.finalizeGroundedInvestigation(structuredClone(commit));
  assert.equal(client.batchCalls, 2);
  const committedSql = client.committedQueries.join("\n");
  for (const table of [
    "investigation_runs",
    "diagnoses",
    "diagnosis_claims",
    "diagnosis_claim_evidence_links",
    "proposed_actions",
    "approvals",
    "approval_snapshots",
    "tool_calls",
    "audit_events",
    "investigation_trace_events",
    "agent_iterations",
  ]) assert.match(committedSql, new RegExp(table));
});

test("P4.2 FINALIZE atomically creates one revision and duplicate invocation is idempotent", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan() { return decision; },
  };
  const first = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner,
    analytics: setup.store.analytics,
  });
  assert.equal(first?.run.status, "WAITING_APPROVAL");
  assert.equal(first?.run.activeIterationId, null);
  assert.equal(first?.run.currentDiagnosisRevision, 1);
  assert.equal(first?.diagnoses.length, 1);
  assert.equal(first?.proposedActions.length, 1);
  assert.equal(first?.approvals.length, 1);
  assert.equal(first?.approvalSnapshots.length, 1);
  assert.equal(first?.diagnosis?.revision, 1);
  assert.equal(first?.proposedAction?.revision, 1);
  assert.equal(first?.approval?.revision, 1);
  assert.equal(first?.approvalSnapshots[0].revision, 1);
  assert.equal(first?.iterations.at(-1)?.decisionType, "FINALIZE");
  assert.equal(first?.iterations.at(-1)?.status, "COMPLETED");

  const second = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner,
    analytics: setup.store.analytics,
  });
  assert.equal(second?.diagnoses.length, 1);
  assert.equal(second?.proposedActions.length, 1);
  assert.equal(second?.approvals.length, 1);
  assert.equal(second?.approvalSnapshots.length, 1);
});

test("P4.2 OBSERVE atomically enters WAITING_VERIFICATION without Action or Approval", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  decision.disposition = "OBSERVE";
  const completed = await runAgentLoop(setup.store, {
    runId: setup.runId,
    planner: { type: "DETERMINISTIC", async plan() { return decision; } },
    analytics: setup.store.analytics,
  });
  assert.equal(completed?.run.status, "WAITING_VERIFICATION");
  assert.equal(completed?.run.completedAt, null);
  assert.equal(completed?.run.currentDiagnosisRevision, 1);
  assert.equal(completed?.diagnoses.length, 1);
  assert.equal(completed?.diagnosisClaims.length, decision.diagnosis.claims.length);
  assert.equal(completed?.proposedActions.length, 0);
  assert.equal(completed?.approvals.length, 0);
  assert.equal(completed?.approvalSnapshots.length, 0);
  assert.equal(completed?.toolCalls.some((call) => call.proposedActionId !== null), false);
  const diagnosisFinalized = completed?.auditEvents.find((event) =>
    event.type === "DIAGNOSIS_FINALIZED");
  assert.ok(diagnosisFinalized);
  assert.equal(diagnosisFinalized?.createdAt, completed?.diagnosis?.createdAt);
  assert.ok(completed?.auditEvents.some((event) =>
    event.type === "RUN_STATE_CHANGED"
    && event.details.to === "WAITING_VERIFICATION"
    && event.details.disposition === "OBSERVE"));
  const finalTrace = completed?.traceEvents.find((event) =>
    event.type === "PLANNER_DECISION" && event.details.decisionType === "FINALIZE");
  assert.equal(finalTrace?.details.disposition, "OBSERVE");
  assert.equal(finalTrace?.details.targetRunStatus, "WAITING_VERIFICATION");
  assert.match(finalTrace?.publicSummary ?? "", /WAITING_VERIFICATION/);
  assert.doesNotMatch(finalTrace?.publicSummary ?? "", /closed|rejected|关闭|拒绝/i);
  assert.equal(completed?.iterations.at(-1)?.decisionType, "FINALIZE");
  assert.equal(completed?.iterations.at(-1)?.status, "COMPLETED");
});

test("P4.2 action dispositions still atomically enter WAITING_APPROVAL", async () => {
  for (const disposition of ["FIX", "ROLLBACK", "ESCALATE"] as const) {
    const setup = await groundedReadyInvestigation();
    const decision = groundedFinalizeDecision(setup.aggregate);
    decision.disposition = disposition;
    const completed = await runAgentLoop(setup.store, {
      runId: setup.runId,
      planner: { type: "DETERMINISTIC", async plan() { return decision; } },
      analytics: setup.store.analytics,
    });
    assert.equal(completed?.run.status, "WAITING_APPROVAL", disposition);
    assert.equal(completed?.run.completedAt, null, disposition);
    assert.ok(completed?.proposedAction, disposition);
    assert.ok(completed?.approval, disposition);
    assert.ok(completed?.approvalSnapshots[0], disposition);
    assert.ok(completed?.toolCalls.some((call) => call.proposedActionId !== null), disposition);
  }
});

test("P4.2 preserves revision N claims when revision N+1 is created", async () => {
  const store = new MemoryStore();
  const first = await runFixtureInvestigation(store, "Android grounded revision case");
  const revisionOneClaims = structuredClone(first.diagnosisClaims);
  const revisionOneLinks = structuredClone(first.diagnosisClaimEvidenceLinks);
  await continueInvestigation(store, {
    runId: first.run.id,
    clientRequestId: "p42-revision-continue",
    reason: "补充分群验证",
  });
  const completed = await submitInvestigationMessage(store, {
    runId: first.run.id,
    clientRequestId: "p42-revision-hypothesis",
    intent: "ADD_HYPOTHESIS",
    content: "异常可能主要集中在 Android 7.3.0 新用户。",
    planner: new DeterministicInvestigationPlanner(),
    analytics: store.analytics,
  });
  assert.equal(completed?.diagnoses.length, 2);
  assert.deepEqual(
    completed?.diagnosisClaims.filter((item) => item.diagnosisId === first.diagnosis!.id),
    revisionOneClaims,
  );
  assert.deepEqual(
    completed?.diagnosisClaimEvidenceLinks.filter((item) =>
      item.diagnosisId === first.diagnosis!.id),
    revisionOneLinks,
  );
  assert.equal(completed?.approvalSnapshots[1].diagnosisId, completed?.diagnoses[1].id);
});

test("P4.2 keeps legacy Diagnosis LEGACY_UNVERIFIED without fabricated Claims", async () => {
  const store = new MemoryStore();
  const runId = await startInvestigation(store, {
    question: "legacy diagnosis compatibility",
    provider: "legacy",
    model: "legacy",
  });
  const now = new Date().toISOString();
  const legacyDiagnosis: Diagnosis = {
    id: "DX-LEGACY",
    runId,
    selectedHypothesisId: null,
    groundingStatus: "LEGACY_UNVERIFIED",
    disposition: null,
    rootCause: "迁移前的旧结论",
    summary: "旧 Diagnosis 没有逐 claim grounding。",
    causalChain: [],
    affectedMetrics: [],
    affectedSegments: [],
    validatedClaims: ["旧版 validated claim"],
    unvalidatedClaims: [],
    confidence: "HIGH",
    severity: "HIGH",
    recommendedAction: "人工复核",
    revision: 1,
    status: "FINAL",
    supersedesDiagnosisId: null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.diagnoses.set(legacyDiagnosis.id, structuredClone(legacyDiagnosis));
  const loaded = await store.getAggregate(runId);
  assert.equal(loaded?.diagnosis?.groundingStatus, "LEGACY_UNVERIFIED");
  assert.equal(loaded?.diagnosis?.selectedHypothesisId, null);
  assert.equal(loaded?.diagnosisClaims.length, 0);
  assert.equal(loaded?.diagnosisClaimEvidenceLinks.length, 0);
});

test("P4.2 LLMPlanner rejects model-supplied confidence and grounding fields", async () => {
  const setup = await groundedReadyInvestigation();
  const decision = groundedFinalizeDecision(setup.aggregate);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          ...decision,
          diagnosis: {
            ...decision.diagnosis,
            confidence: "HIGH",
            groundingStatus: "GROUNDED",
          },
        }),
      },
    }],
  });
  try {
    await assert.rejects(
      new LLMInvestigationPlanner({
        provider: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "test-model",
        apiKey: "test-key",
      }).plan({
        aggregate: setup.aggregate,
        trigger: "INITIAL",
        humanMessage: null,
        remainingIterations: 4,
        remainingToolCalls: 2,
      }),
      /Grounded Contract/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P4.1 assessment commit is atomic under injected persistence failure", async () => {
  const setup = await runningInvestigationWithHypotheses();
  await executeAndRecordTool(setup.store, {
    runId: setup.runId,
    name: "get_release",
    args: { release_id: "REL-ANDROID-730" },
    iteration: 1,
    order: 1,
    analytics: setup.store.analytics,
  });
  setup.store.failNextEvidenceAssessmentCommit = true;
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan(context) {
      return {
        type: "ASSESS_EVIDENCE",
        assessments: context.aggregate.evidence.map((evidence) => ({
          evidenceId: evidence.id,
          relations: context.aggregate.hypotheses.map((candidate) => ({
            targetHypothesisId: candidate.id,
            relation: "SUPPORTS" as const,
            explanation: "原子失败注入测试。",
          })),
        })),
        rationale: "原子失败注入测试。",
      };
    },
  };
  await assert.rejects(
    runAgentLoop(setup.store, {
      runId: setup.runId,
      planner,
      analytics: setup.store.analytics,
    }),
    /INJECTED_ASSESSMENT_COMMIT_FAILURE/,
  );
  const failed = await setup.store.getAggregate(setup.runId);
  assert.equal(failed?.hypothesisEvidenceLinks.length, 0);
  assert.ok(failed?.hypotheses.every((item) =>
    item.status === "ACTIVE"
    && item.confidence === "LOW"
    && item.supportScore === 0
    && item.contradictionScore === 0));
  assert.equal(
    failed?.traceEvents.some((item) =>
      item.type === "PLANNER_DECISION"
      && item.details.decisionType === "ASSESS_EVIDENCE"),
    false,
  );
  assert.equal(failed?.run.status, "FAILED");
});

test("P4.2 LLMPlanner and DeterministicPlanner implement the same decision contract", async () => {
  const { store, runId } = await runningInvestigationWithHypotheses();
  store.hypotheses.clear();
  const aggregateWithoutHypotheses = (await store.getAggregate(runId))!;
  const context = (aggregate: InvestigationAggregate): PlannerContext => ({
    aggregate,
    trigger: "INITIAL",
    humanMessage: null,
    remainingIterations: 16,
    remainingToolCalls: 10,
  });
  const deterministicCreate = await new DeterministicInvestigationPlanner()
    .plan(context(aggregateWithoutHypotheses));
  assert.equal(deterministicCreate.type, "CREATE_HYPOTHESES");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          type: "CREATE_HYPOTHESES",
          hypotheses: [
            { statement: "发布回归", supportIf: "当前版本集中异常", refuteIf: "控制版本同幅异常" },
            { statement: "第三方故障", supportIf: "跨版本同步异常", refuteIf: "只有当前版本异常" },
          ],
          rationale: "建立两个竞争假设。",
        }),
      },
    }],
  });
  try {
    const llmCreate = await new LLMInvestigationPlanner({
      provider: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "test-model",
      apiKey: "test-key",
    }).plan(context(aggregateWithoutHypotheses));
    assert.equal(llmCreate.type, "CREATE_HYPOTHESES");
    if (llmCreate.type === "CREATE_HYPOTHESES") {
      assert.equal(llmCreate.hypotheses.length, 2);
      assert.deepEqual(
        Object.keys(llmCreate.hypotheses[0]).sort(),
        ["refuteIf", "statement", "supportIf"],
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const finalized = await runFixtureInvestigation(new MemoryStore(), "shared FINALIZE contract");
  const deterministicFinal = await new DeterministicInvestigationPlanner()
    .plan(context(finalized));
  assert.equal(deterministicFinal.type, "FINALIZE");
  if (deterministicFinal.type !== "FINALIZE") throw new Error("Expected FINALIZE");
  globalThis.fetch = async () => Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          type: "FINALIZE",
          selectedHypothesisId: deterministicFinal.selectedHypothesisId,
          diagnosis: deterministicFinal.diagnosis,
          disposition: deterministicFinal.disposition,
          rationale: "使用同一个 grounded FINALIZE contract。",
        }),
      },
    }],
  });
  try {
    const llmFinal = await new LLMInvestigationPlanner({
      provider: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "test-model",
      apiKey: "test-key",
    }).plan(context(finalized));
    assert.equal(llmFinal.type, "FINALIZE");
    if (llmFinal.type === "FINALIZE") {
      assert.deepEqual(
        Object.keys(llmFinal).sort(),
        ["diagnosis", "disposition", "rationale", "selectedHypothesisId", "type"],
      );
      assert.deepEqual(
        Object.keys(llmFinal.diagnosis).sort(),
        ["claims", "summary"],
      );
      assert.ok(llmFinal.diagnosis.claims.every((claim) =>
        Object.keys(claim).sort().join(",") === (claim.type === "LIMITATION"
          ? "evidenceIds,limitationType,statement,type"
          : "evidenceIds,statement,type")));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function seedVerificationMetric(
  store: MemoryStore,
  policy: VerificationPolicySnapshot,
  value: number,
  sampleSize = policy.minimumSampleSize,
) {
  store.analytics.buckets.clear();
  const start = Date.parse(policy.anchorAt) + policy.settlingPeriodMinutes * 60_000;
  const count = policy.verificationWindowMinutes / policy.granularityMinutes!;
  for (let index = 0; index < count; index += 1) {
    const bucketStart = new Date(start + index * policy.granularityMinutes! * 60_000).toISOString();
    const bucketEnd = new Date(start + (index + 1) * policy.granularityMinutes! * 60_000).toISOString();
    const bucket = {
      id: `verification-${policy.verificationRunId}-${index}`,
      metricKey: policy.metricKey, bucketStart, bucketEnd,
      granularityMinutes: policy.granularityMinutes!, numerator: null, denominator: null,
      value, sampleSize,
      platform: policy.affectedFilters.platform ?? null,
      appVersion: policy.affectedFilters.appVersion ?? null,
      region: policy.affectedFilters.region ?? null,
      userType: policy.affectedFilters.userType ?? null,
      dimensionSignature: "verification-fixture", releaseId: null,
      provenance: "deterministic_verification_fixture", createdAt: bucketStart,
    };
    store.analytics.buckets.set(bucket.id, bucket);
  }
}

async function observedVerification(value: number, requestId: string) {
  const setup = await observedGroundedInvestigation();
  const attempt = await createVerificationAttempt(setup.store, {
    runId: setup.runId, clientRequestId: `${requestId}-attempt`,
  });
  seedVerificationMetric(setup.store, attempt.policySnapshot, value);
  const end = Date.parse(attempt.policySnapshot.anchorAt)
    + (attempt.policySnapshot.settlingPeriodMinutes
      + attempt.policySnapshot.verificationWindowMinutes) * 60_000;
  const result = await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: attempt.verificationRun.id, clientRequestId: requestId,
  }, () => new Date(end + 1));
  return { ...setup, attempt, result };
}

test("P4.3B immature window remains WAITING_WINDOW without evaluation", async () => {
  const setup = await observedGroundedInvestigation();
  const attempt = await createVerificationAttempt(setup.store, {
    runId: setup.runId, clientRequestId: "verification-window-attempt",
  });
  const result = await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: attempt.verificationRun.id,
    clientRequestId: "verification-window-evaluate",
  }, () => new Date(attempt.policySnapshot.anchorAt));
  assert.equal(result.verificationRun.status, "WAITING_WINDOW");
  assert.equal(result.evaluation, null);
  assert.equal((await setup.store.getAggregate(setup.runId))?.run.status, "WAITING_VERIFICATION");
});

test("P4.3B evaluation atomically persists evidence, outcome, and matching Run state", async () => {
  const resolved = await observedVerification(0.95, "verification-resolved");
  assert.equal(resolved.result.evaluation!.outcome, "RESOLVED");
  assert.equal(resolved.result.verificationRun.status, "RESOLVED");
  assert.equal(resolved.result.evidence.length, 1);
  const aggregate = (await resolved.store.getAggregate(resolved.runId))!;
  assert.equal(aggregate.run.status, "RESOLVED");
  assert.equal(aggregate.run.activeIterationId, null);
  assert.equal(aggregate.verificationEvaluations.length, 1);
  assert.equal(aggregate.verificationEvidence.length, 1);
});

test("P4.3B evaluate is idempotent and terminal history cannot be recomputed", async () => {
  const resolved = await observedVerification(0.95, "verification-idempotent");
  const before = structuredClone(await resolved.store.getAggregate(resolved.runId));
  const replay = await evaluateVerificationAttempt(resolved.store, {
    runId: resolved.runId, verificationRunId: resolved.attempt.verificationRun.id,
    clientRequestId: "different-terminal-request",
  }, () => new Date("2030-01-01T00:00:00.000Z"));
  assert.equal(replay.evaluation!.id, resolved.result.evaluation!.id);
  assert.deepEqual(await resolved.store.getAggregate(resolved.runId), before);
});

test("P4.3B failed atomic commit leaves no evidence or terminal outcome and can resume", async () => {
  const setup = await observedGroundedInvestigation();
  const attempt = await createVerificationAttempt(setup.store, {
    runId: setup.runId, clientRequestId: "verification-rollback-attempt",
  });
  seedVerificationMetric(setup.store, attempt.policySnapshot, 0.95);
  const end = Date.parse(attempt.policySnapshot.anchorAt)
    + (attempt.policySnapshot.settlingPeriodMinutes
      + attempt.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  setup.store.failNextVerificationEvaluationCommit = true;
  await assert.rejects(evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: attempt.verificationRun.id,
    clientRequestId: "verification-rollback-evaluate",
  }, () => new Date(end)), (error: unknown) => error instanceof RuntimeRequestError
    && error.code === "VERIFICATION_EVALUATION_COMMIT_RACE");
  const failed = (await setup.store.getAggregate(setup.runId))!;
  assert.equal(failed.run.status, "VERIFYING");
  assert.equal(failed.verificationEvidence.length, 0);
  assert.equal(failed.verificationEvaluations.length, 0);
  const recovered = await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: attempt.verificationRun.id,
    clientRequestId: "verification-rollback-evaluate",
  }, () => new Date(end));
  assert.equal(recovered.evaluation!.outcome, "RESOLVED");
});

test("P4.3B data read failure persists deterministic INCONCLUSIVE error evidence", async () => {
  const setup = await observedGroundedInvestigation();
  const attempt = await createVerificationAttempt(setup.store, {
    runId: setup.runId, clientRequestId: "verification-error-attempt",
  });
  setup.store.queryVerificationMetricBuckets = async () => {
    throw new Error("analytics unavailable");
  };
  const end = Date.parse(attempt.policySnapshot.anchorAt)
    + (attempt.policySnapshot.settlingPeriodMinutes
      + attempt.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  const result = await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: attempt.verificationRun.id,
    clientRequestId: "verification-error-evaluate",
  }, () => new Date(end));
  assert.equal(result.evaluation!.outcome, "INCONCLUSIVE");
  assert.equal(result.evaluation!.reasonCode, "REQUIRED_SIGNAL_QUERY_FAILED");
  assert.equal(result.evidence[0].qualityStatus, "ERROR");
  assert.equal(result.evidence[0].kind, "AFFECTED_METRIC");
  assert.equal((await setup.store.getAggregate(setup.runId))?.run.status,
    "VERIFICATION_INCONCLUSIVE");
});

test("P4.3B D1 evaluation commit is one atomic batch", async () => {
  const resolved = await observedVerification(0.95, "verification-d1-evaluation");
  const payload = resolved.store.lastVerificationEvaluationInput!;
  assert.ok(payload);

  const failedClient = new AtomicBatchD1Client();
  failedClient.failPattern = /insert into ["`]verification_evidence["`]/i;
  const failedStore = new D1InvestigationStore(async () =>
    drizzle(failedClient as never, { schema: dbSchema }));
  await assert.rejects(failedStore.commitVerificationEvaluation(structuredClone(payload)),
    /INJECTED_D1_BATCH_FAILURE/);
  assert.equal(failedClient.batchCalls, 1);
  assert.deepEqual(failedClient.committedQueries, []);

  const guardClient = new AtomicBatchD1Client();
  guardClient.zeroChangePattern = /update ["`]verification_runs["`] set ["`]status["`]/i;
  const guardStore = new D1InvestigationStore(async () =>
    drizzle(guardClient as never, { schema: dbSchema }));
  assert.equal(await guardStore.commitVerificationEvaluation(structuredClone(payload)), false);
  const guardedSql = guardClient.committedQueries.join("\n");
  assert.match(guardedSql, /COMMITTING/);
  assert.match(guardedSql, /verification_evaluations/);
  assert.match(guardedSql, /attempt/);

  const client = new AtomicBatchD1Client();
  const d1Store = new D1InvestigationStore(async () =>
    drizzle(client as never, { schema: dbSchema }));
  await d1Store.commitVerificationEvaluation(structuredClone(payload));
  assert.equal(client.batchCalls, 1);
  const sqlText = client.committedQueries.join("\n");
  for (const table of ["verification_evaluations", "verification_evidence",
    "verification_runs", "audit_events", "investigation_trace_events", "investigation_runs"]) {
    assert.match(sqlText, new RegExp(table));
  }
});

test("P4.3B D1 reopen and retry commits encode latest-attempt and exact-outcome guards", async () => {
  const reopenSetup = await observedVerification(0.5, "verification-d1-reopen-source");
  await reopenAfterVerification(reopenSetup.store, {
    runId: reopenSetup.runId, verificationRunId: reopenSetup.result.verificationRun.id,
    clientRequestId: "verification-d1-reopen-command",
  });
  const reopenClient = new AtomicBatchD1Client();
  const reopenStore = new D1InvestigationStore(async () =>
    drizzle(reopenClient as never, { schema: dbSchema }));
  await reopenStore.commitVerificationReopen(
    structuredClone(reopenSetup.store.lastVerificationReopenInput!));
  const reopenSql = reopenClient.committedQueries.join("\n");
  assert.match(reopenSql, /MAX\(vr_latest\.attempt\)/);
  assert.match(reopenSql, /VERIFICATION_INCONCLUSIVE/);
  assert.doesNotMatch(reopenSql, /agent_iterations/);

  const retrySetup = await observedVerification(0.8, "verification-d1-retry-source");
  await retryVerificationAttempt(retrySetup.store, {
    runId: retrySetup.runId, verificationRunId: retrySetup.result.verificationRun.id,
    clientRequestId: "verification-d1-retry-command",
  });
  const retryClient = new AtomicBatchD1Client();
  const retryStore = new D1InvestigationStore(async () =>
    drizzle(retryClient as never, { schema: dbSchema }));
  await retryStore.commitVerificationRetry(
    structuredClone(retrySetup.store.lastVerificationRetryInput!));
  const retrySql = retryClient.committedQueries.join("\n");
  assert.match(retrySql, /MAX\(vr_latest\.attempt\)/);
  assert.match(retrySql, /<= 3/);
  assert.match(retrySql, /<= 480/);
});

test("P4.3B runtime schema keeps verification reference columns on the policy table", () => {
  for (const statement of investigationRuntimeSchema.filter((sql) =>
    sql.startsWith("CREATE TABLE"))) {
    const columnNames = [...statement.matchAll(/^\s{4}([a-z_]+)\s/mg)].map((match) => match[1]);
    assert.equal(new Set(columnNames).size, columnNames.length, statement.slice(0, 80));
  }
  const policyTable = investigationRuntimeSchema.find((sql) =>
    sql.includes("CREATE TABLE IF NOT EXISTS verification_policy_snapshots"))!;
  for (const column of ["baseline_value", "incident_observed_value", "direction",
    "granularity_minutes", "control_baseline_value", "feedback_required",
    "feedback_minimum_sample_size", "minimum_improvement_threshold"]) {
    assert.match(policyTable, new RegExp(`\\b${column}\\b`));
  }
  const metricTable = investigationRuntimeSchema.find((sql) =>
    sql.includes("CREATE TABLE IF NOT EXISTS metric_buckets"))!;
  assert.doesNotMatch(metricTable, /baseline_value|incident_observed_value/);
});

test("P4.3B evaluate API ignores client-controlled recovery inputs", async () => {
  const setup = await observedGroundedInvestigation();
  const attempt = await createVerificationAttempt(setup.store, {
    runId: setup.runId, clientRequestId: "verification-api-attempt",
  });
  seedVerificationMetric(setup.store, attempt.policySnapshot, 0.5);
  const response = await handleVerificationEvaluatePost(new Request("http://localhost/evaluate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientRequestId: "verification-api-evaluate", outcome: "RESOLVED",
      threshold: 0, observedValue: 1, sampleSize: 999999 }),
  }), setup.runId, attempt.verificationRun.id, setup.store, () => new Date(
    Date.parse(attempt.policySnapshot.anchorAt)
      + (attempt.policySnapshot.settlingPeriodMinutes
        + attempt.policySnapshot.verificationWindowMinutes) * 60_000 + 1,
  ));
  const payload = await response.json() as { evaluation: VerificationEvaluation };
  assert.equal(response.status, 200);
  assert.equal(payload.evaluation.outcome, "NOT_RECOVERED");
});

test("P4.3B retry preserves old attempt and doubles the frozen observation window", async () => {
  const partial = await observedVerification(0.8, "verification-retry-source");
  const oldRun = structuredClone(partial.result.verificationRun);
  const oldPolicy = structuredClone(partial.attempt.policySnapshot);
  const retry = await retryVerificationAttempt(partial.store, {
    runId: partial.runId, verificationRunId: oldRun.id, clientRequestId: "verification-retry-command",
  });
  assert.equal(retry.verificationRun.attempt, oldRun.attempt + 1);
  assert.equal(retry.policySnapshot.verificationWindowMinutes,
    oldPolicy.verificationWindowMinutes * 2);
  assert.deepEqual(partial.store.verificationRuns.get(oldRun.id), oldRun);
  assert.deepEqual(partial.store.verificationPolicies.get(oldPolicy.id), oldPolicy);
  assert.equal((await partial.store.getAggregate(partial.runId))?.run.status, "WAITING_VERIFICATION");
});

test("P4.3B reopen preserves history without a synthetic PAUSED iteration and rejects RESOLVED", async () => {
  const notRecovered = await observedVerification(0.5, "verification-reopen-source");
  const actionsBefore = notRecovered.store.actions.size;
  const iterationsBefore = notRecovered.store.iterations.size;
  const historical = structuredClone(notRecovered.result.verificationRun);
  const reopened = await reopenAfterVerification(notRecovered.store, {
    runId: notRecovered.runId, verificationRunId: historical.id,
    clientRequestId: "verification-reopen-command", reason: "Product metric remains degraded",
  });
  assert.equal(reopened?.run.status, "RUNNING");
  assert.equal(notRecovered.store.iterations.size, iterationsBefore);
  assert.equal(notRecovered.store.actions.size, actionsBefore);
  assert.deepEqual(notRecovered.store.verificationRuns.get(historical.id), historical);
  const replay = await reopenAfterVerification(notRecovered.store, {
    runId: notRecovered.runId, verificationRunId: historical.id,
    clientRequestId: "verification-reopen-command", reason: "Product metric remains degraded",
  });
  assert.equal(replay?.iterations.length, reopened?.iterations.length);

  const resolved = await observedVerification(0.95, "verification-no-reopen");
  await assert.rejects(reopenAfterVerification(resolved.store, {
    runId: resolved.runId, verificationRunId: resolved.attempt.verificationRun.id,
    clientRequestId: "verification-resolved-reopen",
  }), (error: unknown) => error instanceof RuntimeRequestError
    && error.code === "RESOLVED_VERIFICATION_CANNOT_REOPEN");
});

test("P4.3B concurrent evaluators produce only one terminal evaluation", async () => {
  const setup = await observedGroundedInvestigation();
  const attempt = await createVerificationAttempt(setup.store, {
    runId: setup.runId, clientRequestId: "verification-concurrent-attempt",
  });
  seedVerificationMetric(setup.store, attempt.policySnapshot, 0.95);
  const end = Date.parse(attempt.policySnapshot.anchorAt)
    + (attempt.policySnapshot.settlingPeriodMinutes
      + attempt.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  const results = await Promise.allSettled([
    evaluateVerificationAttempt(setup.store, {
      runId: setup.runId, verificationRunId: attempt.verificationRun.id,
      clientRequestId: "verification-concurrent-a",
    }, () => new Date(end)),
    evaluateVerificationAttempt(setup.store, {
      runId: setup.runId, verificationRunId: attempt.verificationRun.id,
      clientRequestId: "verification-concurrent-b",
    }, () => new Date(end)),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(setup.store.verificationEvaluations.size, 1);
});

test("P4.3B control and feedback query failures retain exact signal provenance", async () => {
  const controlSetup = await observedGroundedInvestigation();
  const controlAttempt = await createVerificationAttempt(controlSetup.store, {
    runId: controlSetup.runId, clientRequestId: "verification-control-error-attempt",
  });
  const controlPolicy = controlSetup.store.verificationPolicies.get(controlAttempt.policySnapshot.id)!;
  controlSetup.store.verificationPolicies.set(controlPolicy.id, {
    ...controlPolicy, controlFilters: { platform: "IOS" }, controlBaselineValue: 1,
  });
  seedVerificationMetric(controlSetup.store, controlPolicy, 0.95);
  controlSetup.store.queryVerificationMetricBuckets = async (input) => {
    if (input.filters.platform === "IOS") throw new Error("control unavailable");
    return controlSetup.store.analytics.queryMetricBuckets(input);
  };
  const controlEnd = Date.parse(controlPolicy.anchorAt)
    + (controlPolicy.settlingPeriodMinutes + controlPolicy.verificationWindowMinutes) * 60_000 + 1;
  const controlResult = await evaluateVerificationAttempt(controlSetup.store, {
    runId: controlSetup.runId, verificationRunId: controlAttempt.verificationRun.id,
    clientRequestId: "verification-control-error-evaluate",
  }, () => new Date(controlEnd));
  assert.equal(controlResult.evaluation!.outcome, "INCONCLUSIVE");
  assert.deepEqual(controlResult.evidence.map((item) => item.kind).sort(),
    ["AFFECTED_METRIC", "CONTROL_METRIC"]);
  assert.equal(controlResult.evidence.find((item) => item.kind === "CONTROL_METRIC")!.qualityStatus,
    "ERROR");

  const feedbackSetup = await observedGroundedInvestigation();
  const feedbackAttempt = await createVerificationAttempt(feedbackSetup.store, {
    runId: feedbackSetup.runId, clientRequestId: "verification-feedback-error-attempt",
  });
  const feedbackPolicy = feedbackSetup.store.verificationPolicies.get(feedbackAttempt.policySnapshot.id)!;
  feedbackSetup.store.verificationPolicies.set(feedbackPolicy.id, { ...feedbackPolicy, feedbackRequired: true });
  seedVerificationMetric(feedbackSetup.store, feedbackPolicy, 0.95);
  feedbackSetup.store.queryVerificationFeedback = async (input) => {
    if (input.endTime === feedbackPolicy.anchorAt) throw new Error("reference unavailable");
    return [];
  };
  const feedbackEnd = Date.parse(feedbackPolicy.anchorAt)
    + (feedbackPolicy.settlingPeriodMinutes + feedbackPolicy.verificationWindowMinutes) * 60_000 + 1;
  const feedbackResult = await evaluateVerificationAttempt(feedbackSetup.store, {
    runId: feedbackSetup.runId, verificationRunId: feedbackAttempt.verificationRun.id,
    clientRequestId: "verification-feedback-error-evaluate",
  }, () => new Date(feedbackEnd));
  assert.equal(feedbackResult.evaluation!.outcome, "INCONCLUSIVE");
  assert.equal(feedbackResult.evidence.find((item) => item.kind === "FEEDBACK_REFERENCE")!.qualityStatus,
    "ERROR");
  assert.ok(feedbackResult.evidence.some((item) => item.kind === "FEEDBACK_VERIFICATION"));
  assert.equal(feedbackResult.evidence.some((item) =>
    item.kind === "AFFECTED_METRIC" && item.qualityStatus === "ERROR"), false);
});

test("P4.3B optional feedback is not queried and cannot contaminate metric outcome", async () => {
  const setup = await observedGroundedInvestigation();
  const attempt = await createVerificationAttempt(setup.store, {
    runId: setup.runId, clientRequestId: "verification-optional-feedback-attempt",
  });
  seedVerificationMetric(setup.store, attempt.policySnapshot, 0.95);
  let feedbackQueries = 0;
  setup.store.queryVerificationFeedback = async () => {
    feedbackQueries += 1;
    throw new Error("optional feedback unavailable");
  };
  const end = Date.parse(attempt.policySnapshot.anchorAt)
    + (attempt.policySnapshot.settlingPeriodMinutes
      + attempt.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  const result = await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: attempt.verificationRun.id,
    clientRequestId: "verification-optional-feedback-evaluate",
  }, () => new Date(end));
  assert.equal(result.evaluation!.outcome, "RESOLVED");
  assert.equal(feedbackQueries, 0);
});

test("P4.3B reopen requires the latest exact outcome and FAILED is not reopenable", async () => {
  const setup = await observedVerification(0.8, "verification-stale-reopen-source");
  const first = setup.result.verificationRun;
  const retry = await retryVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: first.id, clientRequestId: "verification-stale-retry",
  });
  seedVerificationMetric(setup.store, retry.policySnapshot, 0.8);
  const retryEnd = Date.parse(retry.policySnapshot.anchorAt)
    + (retry.policySnapshot.settlingPeriodMinutes
      + retry.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: retry.verificationRun.id,
    clientRequestId: "verification-stale-retry-evaluate",
  }, () => new Date(retryEnd));
  await assert.rejects(reopenAfterVerification(setup.store, {
    runId: setup.runId, verificationRunId: first.id, clientRequestId: "verification-stale-reopen",
  }), (error: unknown) => error instanceof RuntimeRequestError
    && error.code === "VERIFICATION_REOPEN_CONTEXT_STALE");
  const iterationsBefore = setup.store.iterations.size;
  const reopened = await reopenAfterVerification(setup.store, {
    runId: setup.runId, verificationRunId: retry.verificationRun.id,
    clientRequestId: "verification-latest-reopen",
  });
  assert.equal(reopened!.run.status, "RUNNING");
  assert.equal(setup.store.iterations.size, iterationsBefore);

  const failed = await observedVerification(0.5, "verification-failed-reopen-source");
  failed.store.verificationRuns.set(failed.result.verificationRun.id, {
    ...failed.result.verificationRun, status: "FAILED",
  });
  failed.store.runs.set(failed.runId, { ...(await failed.store.getAggregate(failed.runId))!.run,
    status: "FAILED" });
  await assert.rejects(reopenAfterVerification(failed.store, {
    runId: failed.runId, verificationRunId: failed.result.verificationRun.id,
    clientRequestId: "verification-failed-reopen",
  }), (error: unknown) => error instanceof RuntimeRequestError
    && error.code === "VERIFICATION_NOT_REOPENABLE");
});

test("P4.3B retry caps attempts and observation-window growth", async () => {
  const setup = await observedVerification(0.8, "verification-retry-cap-source");
  const retry2 = await retryVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: setup.result.verificationRun.id,
    clientRequestId: "verification-retry-cap-2",
  });
  seedVerificationMetric(setup.store, retry2.policySnapshot, 0.8);
  const end2 = Date.parse(retry2.policySnapshot.anchorAt)
    + (retry2.policySnapshot.settlingPeriodMinutes
      + retry2.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: retry2.verificationRun.id,
    clientRequestId: "verification-retry-cap-evaluate-2",
  }, () => new Date(end2));
  const retry3 = await retryVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: retry2.verificationRun.id,
    clientRequestId: "verification-retry-cap-3",
  });
  seedVerificationMetric(setup.store, retry3.policySnapshot, 0.8);
  const end3 = Date.parse(retry3.policySnapshot.anchorAt)
    + (retry3.policySnapshot.settlingPeriodMinutes
      + retry3.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  await evaluateVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: retry3.verificationRun.id,
    clientRequestId: "verification-retry-cap-evaluate-3",
  }, () => new Date(end3));
  await assert.rejects(retryVerificationAttempt(setup.store, {
    runId: setup.runId, verificationRunId: retry3.verificationRun.id,
    clientRequestId: "verification-retry-cap-4",
  }), (error: unknown) => error instanceof RuntimeRequestError
    && error.code === "VERIFICATION_ATTEMPT_LIMIT_REACHED");

  const windowSetup = await observedVerification(0.8, "verification-window-cap-source");
  const policy = windowSetup.store.verificationPolicies.get(windowSetup.attempt.policySnapshot.id)!;
  windowSetup.store.verificationPolicies.set(policy.id, { ...policy, verificationWindowMinutes: 300 });
  await assert.rejects(retryVerificationAttempt(windowSetup.store, {
    runId: windowSetup.runId, verificationRunId: windowSetup.result.verificationRun.id,
    clientRequestId: "verification-window-cap-retry",
  }), (error: unknown) => error instanceof RuntimeRequestError
    && error.code === "VERIFICATION_WINDOW_LIMIT_REACHED");
});

test("P4.3B OBSERVE and Action attempts share the same deterministic evaluator", async () => {
  const observed = await observedVerification(0.95, "verification-observe-shared");
  const action = await completedFixtureAction("verification-action-completion-shared");
  const attempt = await createVerificationAttempt(action.store, {
    runId: action.aggregate.run.id, clientRequestId: "verification-action-shared-attempt",
  });
  seedVerificationMetric(action.store, attempt.policySnapshot, 0.95);
  const end = Date.parse(attempt.policySnapshot.anchorAt)
    + (attempt.policySnapshot.settlingPeriodMinutes
      + attempt.policySnapshot.verificationWindowMinutes) * 60_000 + 1;
  const evaluated = await evaluateVerificationAttempt(action.store, {
    runId: action.aggregate.run.id, verificationRunId: attempt.verificationRun.id,
    clientRequestId: "verification-action-shared-evaluate",
  }, () => new Date(end));
  assert.equal(observed.result.evaluation!.outcome, "RESOLVED");
  assert.equal(evaluated.evaluation!.outcome, "RESOLVED");
  assert.equal(observed.result.evidence[0].provenance, evaluated.evidence[0].provenance);
});
