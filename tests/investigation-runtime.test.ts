import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import * as dbSchema from "../db/schema";
import "./risk-detection.test";
import "./analytics-tools.test";
import "./retrieval.test";
import "./phase4-scenarios.test";
import "./hypothesis-confidence.test";
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
import { assertRunTransition } from "../lib/investigation/state";
import { POST as githubIssueRoute } from "../app/api/github-issue/route";
import { handleInvestigatePost } from "../app/api/investigate/route";
import type { RunTransitionPatch } from "../lib/investigation/store";
import {
  assertGroundedFinalizationCommit,
  type GroundedFinalizationCommit,
  type Phase3InvestigationStore,
} from "../lib/investigation/phase3-store";
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
  DiagnosisEvidenceLink,
  Hypothesis,
  HypothesisEvidenceLink,
  InvestigationMessage,
  InvestigationTraceEvent,
} from "../lib/investigation/types";
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

class MemoryStore implements Phase3InvestigationStore {
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
  commands = new Set<string>();
  failNextEvidenceAssessmentCommit = false;
  lastGroundedFinalizationInput: GroundedFinalizationCommit | null = null;
  failNextGroundedFinalizationAt: null | "DIAGNOSIS" | "ACTION" | "APPROVAL"
    | "SNAPSHOT" | "TOOL_CALL" | "AUDIT" | "RUN_TRANSITION" = null;

  async createRun(run: InvestigationRun) {
    this.runs.set(run.id, structuredClone(run));
  }

  async transitionRun(runId: string, to: InvestigationRunStatus, patch: RunTransitionPatch = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    assertRunTransition(run.status, to);
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
    return statements.map(() => ({
      success: true,
      results: [],
      meta: { changes: 1 },
    }));
  }
}

const fixture = () => runFixtureInvestigation(
  new MemoryStore(),
  "为什么 Android 7.3.0 发布后，优惠券领取成功率突然下降？",
);

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

test("Case A: approve executes the frozen action and reaches WAITING_VERIFICATION", async () => {
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
  assert.equal(completed?.run.status, "WAITING_VERIFICATION");
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
