import assert from "node:assert/strict";
import test from "node:test";
import "./risk-detection.test";
import "./analytics-tools.test";
import "./retrieval.test";
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
import { MemoryAnalyticsStore } from "../lib/fixtures/android-730";
import { continueInvestigation } from "../lib/investigation/revision-runtime";
import { submitInvestigationMessage } from "../lib/investigation/chat-runtime";
import { DeterministicInvestigationPlanner } from "../lib/investigation/deterministic-planner";
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
  assert.equal(aggregate.iterations.length, 6);
  assert.equal(aggregate.traceEvents.filter((item) => item.type === "PLANNER_DECISION").length, 6);
  assert.equal(aggregate.hypotheses.length, 1);
  assert.equal(aggregate.hypotheses[0].confidence, "HIGH");
  assert.equal(aggregate.hypotheses[0].status, "SUPPORTED");
  assert.equal(aggregate.hypothesisEvidenceLinks.length, 5);
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
  assert.equal(payload.investigation.iterations.length, 6);
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
