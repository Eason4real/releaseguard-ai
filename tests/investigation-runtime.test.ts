import assert from "node:assert/strict";
import test from "node:test";
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
  finalizeInvestigation,
  fixtureDiagnosis,
  startInvestigation,
} from "../lib/investigation/runtime";
import { runFixtureInvestigation } from "../lib/investigation/fixture-runtime";
import { runAgentLoop } from "../lib/investigation/agent-loop";
import type { InvestigationPlanner, PlannerContext } from "../lib/investigation/planner";
import { assertRunTransition } from "../lib/investigation/state";
import { POST as githubIssueRoute } from "../app/api/github-issue/route";
import { handleInvestigatePost } from "../app/api/investigate/route";
import type { RunTransitionPatch } from "../lib/investigation/store";
import type { Phase3InvestigationStore } from "../lib/investigation/phase3-store";
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
import {
  InMemoryFeedbackRetriever,
  InMemoryIncidentRetriever,
} from "../lib/retrieval/local-retrievers";

class MemoryStore implements Phase3InvestigationStore {
  analytics = new MemoryAnalyticsStore();
  runs = new Map<string, InvestigationRun>();
  calls = new Map<string, ToolCall>();
  results = new Map<string, ToolResult>();
  evidence = new Map<string, Evidence>();
  diagnoses = new Map<string, Diagnosis>();
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

  async saveDiagnosis(diagnosis: Diagnosis) {
    this.diagnoses.set(diagnosis.id, structuredClone(diagnosis));
  }

  async saveProposedAction(action: ProposedAction) {
    this.actions.set(action.id, structuredClone(action));
  }

  async saveApproval(approval: Approval) {
    this.approvals.set(approval.id, structuredClone(approval));
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

  async saveDiagnosisEvidenceLinks(items: DiagnosisEvidenceLink[]) {
    items.forEach((item) => this.diagnosisLinks.set(item.id, structuredClone(item)));
  }

  async saveApprovalSnapshot(snapshot: ApprovalSnapshot) {
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
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
  assert.equal(aggregate.diagnosisEvidenceLinks.length, 5);
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

test("EMPTY and ERROR investigation ToolResults persist without failing the run", async () => {
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
  await finalizeInvestigation(store, {
    runId,
    diagnosis: fixtureDiagnosis(),
    totalTokens: 0,
    evidenceCount: 0,
  });
  assert.equal((await store.getAggregate(runId))?.run.status, "WAITING_APPROVAL");
});

test("invalid InvestigationRun transitions are rejected", () => {
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
        diagnosis: fixtureDiagnosis(),
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
        diagnosis: fixtureDiagnosis(),
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

test("P4.1 rejects HIGH FINALIZE from both planner types when all hypotheses are rejected", async () => {
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
          diagnosis: { ...fixtureDiagnosis(), confidence: "HIGH" },
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

test("P4.1 LLMPlanner and DeterministicPlanner implement the same decision contract", async () => {
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
});
