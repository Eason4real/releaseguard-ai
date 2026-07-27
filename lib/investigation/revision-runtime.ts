import type { Phase3InvestigationStore } from "./phase3-store";
import type { AuditEvent, InvestigationTraceEvent } from "./types";
import { RuntimeRequestError } from "./action-runtime";
import { assertActiveHypothesisInvariant } from "./hypothesis-invariants";

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export async function continueInvestigation(
  store: Phase3InvestigationStore,
  input: {
    runId: string;
    clientRequestId: string;
    reason?: string | null;
  },
) {
  const aggregate = await store.getAggregate(input.runId);
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);
  try {
    assertActiveHypothesisInvariant(aggregate);
  } catch (error) {
    throw new RuntimeRequestError(
      "ACTIVE_HYPOTHESIS_LEGACY_INVARIANT",
      error instanceof Error ? error.message : "Run 中未拒绝 Hypothesis 超过上限。",
      409,
    );
  }
  if (aggregate.run.status !== "WAITING_APPROVAL") {
    throw new RuntimeRequestError(
      "RUN_NOT_WAITING_APPROVAL",
      "只有处于待审批状态的调查可以继续。",
      409,
    );
  }
  const approval = aggregate.approval;
  const action = aggregate.proposedAction;
  if (!approval || approval.status !== "PENDING" || !action || action.status !== "PENDING_APPROVAL") {
    throw new RuntimeRequestError(
      "PENDING_APPROVAL_REQUIRED",
      "当前审批已经处理，不能撤回后继续调查。",
      409,
    );
  }
  const actionCall = aggregate.toolCalls.find((item) =>
    item.proposedActionId === action.id && item.name === "create_github_issue");
  if (!actionCall || actionCall.status !== "WAITING_APPROVAL") {
    throw new RuntimeRequestError("ACTION_ALREADY_STARTED", "Action 已开始或状态不正确。", 409);
  }
  const recorded = await store.recordRuntimeCommand({
    id: createId("CMD"),
    runId: input.runId,
    clientRequestId: input.clientRequestId,
    commandType: "CONTINUE_INVESTIGATION",
    resultReference: approval.id,
    createdAt: new Date().toISOString(),
  });
  if (!recorded) return store.getAggregate(input.runId);

  const snapshot = aggregate.approvalSnapshots.find((item) => item.approvalId === approval.id) ?? null;
  const now = new Date().toISOString();
  const withdrawn = await store.withdrawPendingRevision({
    runId: input.runId,
    approvalId: approval.id,
    proposedActionId: action.id,
    actionToolCallId: actionCall.id,
    snapshotId: snapshot?.id ?? null,
    now,
  });
  if (!withdrawn) {
    throw new RuntimeRequestError("REVISION_RACE", "审批状态已变化，无法继续调查。", 409);
  }
  const reason = input.reason?.trim().slice(0, 2_000) || "产品经理要求补充调查";
  const events: AuditEvent[] = [
    {
      id: createId("AE"),
      runId: input.runId,
      proposedActionId: action.id,
      approvalId: approval.id,
      toolCallId: actionCall.id,
      type: "APPROVAL_WITHDRAWN",
      actor: "Product Manager · Workspace Owner",
      details: { reason, revision: approval.revision },
      createdAt: now,
    },
    {
      id: createId("AE"),
      runId: input.runId,
      proposedActionId: action.id,
      approvalId: approval.id,
      toolCallId: actionCall.id,
      type: "INVESTIGATION_REOPENED",
      actor: "ReleaseGuard Runtime",
      details: { reason, nextRevision: approval.revision + 1 },
      createdAt: now,
    },
  ];
  await store.saveAuditEvents(events);
  const trace: InvestigationTraceEvent = {
    id: createId("ITE"),
    runId: input.runId,
    iterationId: null,
    sequence: (aggregate.traceEvents.at(-1)?.sequence ?? 0) + 1,
    type: "INVESTIGATION_REOPENED",
    actor: "HUMAN",
    publicSummary: reason,
    details: { withdrawnApprovalId: approval.id, revision: approval.revision },
    createdAt: now,
  };
  await store.saveTraceEvents([trace]);
  await store.transitionRun(input.runId, "RUNNING", {
    completedAt: null,
    stopReason: null,
  });
  return store.getAggregate(input.runId);
}
