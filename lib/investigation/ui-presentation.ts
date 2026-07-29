import type {
  AuditEvent,
  Confidence,
  InvestigationAggregate,
  LegacyInvestigationResponse,
} from "./types";
import {
  resolveValidatedGithubIssue,
  type ValidatedGithubIssue,
} from "./github-action-state";

const plannerAuditLabels: Partial<Record<AuditEvent["type"], string>> = {
  PLANNER_MODEL_CALL_RESERVED: "模型调用额度已预留",
  PLANNER_MODEL_CALL_OBSERVED: "模型响应已观测",
  PLANNER_DECISION_REJECTED: "Planner decision 已拒绝",
  PLANNER_DECISION_ACCEPTED: "Planner decision 已接受",
  PLANNER_DECISION_REPAIR_ATTEMPTED: "Planner decision repair 已尝试",
  PLANNER_DECISION_REPAIRED: "Planner decision repair 已成功",
  PLANNER_DECISION_REPAIR_FAILED: "Planner decision repair 已耗尽",
  PLANNER_MODEL_CALL_BUDGET_EXHAUSTED: "模型调用预算已耗尽",
  PROPOSED_ACTION_CREATED: "ProposedAction 已创建",
  ACTION_EXECUTION_STARTED: "Action execution 已 claim",
  ACTION_EXECUTION_RECLAIMED: "Action execution lease 已恢复",
  ACTION_EXTERNAL_DISPATCH_STARTED: "GitHub create dispatch 已记录",
  ACTION_RECONCILIATION_REQUIRED: "GitHub 写入结果待核对",
  ACTION_RECONCILIATION_CHECKED: "GitHub marker 已核对",
  ACTION_SUCCEEDED: "ProposedAction 状态更新 · SUCCEEDED",
  ACTION_FAILED: "ProposedAction 状态更新 · FAILED",
};

export function resolveAuditEventLabel(event: AuditEvent) {
  return plannerAuditLabels[event.type] ?? event.type;
}

export type AuditTimelineRow = {
  id: string;
  at: string;
  actor: string;
  action: string;
  permission: string;
  source: "audit" | "derived";
  lifecycle: "created" | "claim" | "dispatch" | "success" | "failure" | "status" | "observation";
  sortOrder: number;
};

const auditEventOrder: Partial<Record<AuditEvent["type"], number>> = {
  PROPOSED_ACTION_CREATED: 30,
  APPROVAL_REQUESTED: 40,
  APPROVAL_APPROVED: 50,
  APPROVAL_REJECTED: 50,
  ACTION_EXECUTION_STARTED: 60,
  ACTION_EXECUTION_RECLAIMED: 60,
  ACTION_EXTERNAL_DISPATCH_STARTED: 70,
  ACTION_RECONCILIATION_REQUIRED: 80,
  ACTION_RECONCILIATION_CHECKED: 80,
  ACTION_SUCCEEDED: 90,
  ACTION_FAILED: 90,
};

const auditEventLifecycle = (
  type: AuditEvent["type"],
): AuditTimelineRow["lifecycle"] => {
  if (type === "PROPOSED_ACTION_CREATED") return "created";
  if (type === "ACTION_EXECUTION_STARTED" || type === "ACTION_EXECUTION_RECLAIMED") return "claim";
  if (type === "ACTION_EXTERNAL_DISPATCH_STARTED") return "dispatch";
  if (type === "ACTION_SUCCEEDED") return "success";
  if (type === "ACTION_FAILED") return "failure";
  return "observation";
};

const timestampValue = (value: string) => {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
};

export function sortAuditTimelineRows(rows: AuditTimelineRow[]): AuditTimelineRow[] {
  return [...rows].sort((left, right) => {
    const timestampDifference = timestampValue(left.at) - timestampValue(right.at);
    if (timestampDifference !== 0) return timestampDifference;
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

export function buildRuntimeAuditTimeline(
  aggregate: InvestigationAggregate,
): AuditTimelineRow[] {
  const rows: AuditTimelineRow[] = [{
    id: `derived:run-created:${aggregate.run.id}`,
    at: aggregate.run.createdAt,
    actor: "Runtime",
    action: `创建 InvestigationRun ${aggregate.run.id.slice(0, 18)}… · derived`,
    permission: "服务端",
    source: "derived",
    lifecycle: "created",
    sortOrder: 0,
  }];
  const hasAudit = (
    types: AuditEvent["type"][],
    proposedActionId?: string,
    toolCallId?: string,
  ) => aggregate.auditEvents.some((event) => types.includes(event.type)
    && (!proposedActionId || event.proposedActionId === proposedActionId)
    && (!toolCallId || event.toolCallId === toolCallId));

  for (const call of aggregate.toolCalls) {
    if (call.name === "create_github_issue" && call.proposedActionId) continue;
    const at = call.result?.createdAt ?? call.completedAt ?? call.startedAt ?? call.requestedAt;
    rows.push({
      id: `derived:tool:${call.id}`,
      at,
      actor: "Tool Runtime",
      action: `${call.name} · ${call.result?.status ?? call.status} · ${(call.result?.errorMessage ?? call.result?.id ?? "等待结果").slice(0, 180)} · derived`,
      permission: "只读",
      source: "derived",
      lifecycle: "observation",
      sortOrder: 20,
    });
  }

  if (aggregate.diagnosis && !hasAudit(["DIAGNOSIS_FINALIZED"])) {
    rows.push({
      id: `derived:diagnosis:${aggregate.diagnosis.id}`,
      at: aggregate.diagnosis.createdAt,
      actor: "Agent",
      action: `保存结构化 Diagnosis · ${aggregate.diagnosis.confidence} · derived`,
      permission: "只读",
      source: "derived",
      lifecycle: "created",
      sortOrder: 25,
    });
  }

  const action = aggregate.proposedAction;
  const actionCall = action
    ? aggregate.toolCalls.find((call) => call.proposedActionId === action.id
      && call.name === "create_github_issue") ?? null
    : null;
  if (action && !hasAudit(["PROPOSED_ACTION_CREATED"], action.id)) {
    rows.push({
      id: `derived:action-created:${action.id}`,
      at: action.createdAt,
      actor: "Runtime",
      action: `ProposedAction 已创建 · ${action.type} · PENDING_APPROVAL · derived`,
      permission: "待操作",
      source: "derived",
      lifecycle: "created",
      sortOrder: 30,
    });
  }

  if (action && actionCall) {
    if (actionCall.startedAt && !hasAudit([
      "ACTION_EXECUTION_STARTED", "ACTION_EXECUTION_RECLAIMED",
    ], action.id, actionCall.id)) {
      rows.push({
        id: `derived:action-claim:${actionCall.id}`,
        at: actionCall.startedAt,
        actor: "ReleaseGuard Action Runtime",
        action: "Action execution 已 claim · derived",
        permission: "服务端",
        source: "derived",
        lifecycle: "claim",
        sortOrder: 60,
      });
    }
    if (actionCall.externalDispatchStartedAt
      && !hasAudit(["ACTION_EXTERNAL_DISPATCH_STARTED"], action.id, actionCall.id)) {
      rows.push({
        id: `derived:action-dispatch:${actionCall.id}`,
        at: actionCall.externalDispatchStartedAt,
        actor: "ReleaseGuard Action Runtime",
        action: "GitHub create dispatch 已记录 · derived",
        permission: "服务端",
        source: "derived",
        lifecycle: "dispatch",
        sortOrder: 70,
      });
    }

    const resultTimestamp = actionCall.completedAt ?? actionCall.result?.createdAt ?? null;
    if (action.status === "SUCCEEDED" && resultTimestamp
      && !hasAudit(["ACTION_SUCCEEDED"], action.id, actionCall.id)) {
      rows.push({
        id: `derived:action-success:${action.id}`,
        at: resultTimestamp,
        actor: "ReleaseGuard Action Runtime",
        action: "ProposedAction 状态更新 · SUCCEEDED · derived",
        permission: "已授权",
        source: "derived",
        lifecycle: "success",
        sortOrder: 90,
      });
    } else if (action.status === "FAILED" && resultTimestamp
      && !hasAudit(["ACTION_FAILED"], action.id, actionCall.id)) {
      rows.push({
        id: `derived:action-failure:${action.id}`,
        at: resultTimestamp,
        actor: "ReleaseGuard Action Runtime",
        action: "ProposedAction 状态更新 · FAILED · derived",
        permission: "服务端",
        source: "derived",
        lifecycle: "failure",
        sortOrder: 90,
      });
    }
  }

  if (action && action.status === "APPROVED"
    && !hasAudit(["APPROVAL_APPROVED"], action.id)) {
    const approval = aggregate.approval?.proposedActionId === action.id ? aggregate.approval : null;
    if (approval?.decidedAt) {
      rows.push({
        id: `derived:action-approved:${action.id}`,
        at: approval.decidedAt,
        actor: approval.decidedBy ?? "Runtime",
        action: "ProposedAction 状态更新 · APPROVED · derived",
        permission: "已授权",
        source: "derived",
        lifecycle: "status",
        sortOrder: 50,
      });
    }
  }

  rows.push(...aggregate.auditEvents.map((event): AuditTimelineRow => ({
    id: `audit:${event.id}`,
    at: event.createdAt,
    actor: event.actor,
    action: `${resolveAuditEventLabel(event)} · ${JSON.stringify(event.details)}`,
    permission: "服务端留痕",
    source: "audit",
    lifecycle: auditEventLifecycle(event.type),
    sortOrder: auditEventOrder[event.type] ?? 45,
  })));

  return sortAuditTimelineRows(rows);
}

export type InvestigationPresentationStatus = "idle" | "running" | "live" | "error" | "not_configured";

export function presentationStatusFromRun(
  investigation: LegacyInvestigationResponse,
): InvestigationPresentationStatus {
  if (investigation.runStatus === "FAILED") return "error";
  if (investigation.runStatus === "PENDING" || investigation.runStatus === "RUNNING") return "running";
  return "live";
}

export function canApplyInvestigationResponse(
  requestGeneration: number,
  currentGeneration: number,
  expectedRunId: string | null,
  responseRunId: string,
) {
  return requestGeneration === currentGeneration
    && (expectedRunId === null || expectedRunId === responseRunId);
}

export function canPresentCurrentInvestigation(
  status: InvestigationPresentationStatus,
  investigation: LegacyInvestigationResponse | null,
  currentRunId: string | null,
): investigation is LegacyInvestigationResponse {
  return status === "live"
    && investigation !== null
    && currentRunId === investigation.runId
    && investigation.runStatus !== "PENDING"
    && investigation.runStatus !== "RUNNING"
    && investigation.runStatus !== "FAILED";
}

export function resolveInvestigationConfidence(
  status: InvestigationPresentationStatus,
  investigation: LegacyInvestigationResponse | null,
  currentRunId: string | null = investigation?.runId ?? null,
): { confidence: Confidence | null; label: string } {
  if (status === "running" || investigation?.runStatus === "PENDING"
    || investigation?.runStatus === "RUNNING") return { confidence: null, label: "调查中" };
  if (status === "error" || investigation?.runStatus === "FAILED") {
    return { confidence: null, label: "不可用" };
  }
  if (!canPresentCurrentInvestigation(status, investigation, currentRunId)) {
    return { confidence: null, label: "待调查" };
  }
  const diagnosis = investigation.investigation.diagnosis;
  const selected = diagnosis?.selectedHypothesisId
    ? investigation.investigation.hypotheses.find((item) =>
        item.id === diagnosis.selectedHypothesisId && item.status !== "REJECTED")
    : null;
  if (!diagnosis || diagnosis.supersededAt !== null || !selected) {
    return { confidence: null, label: "暂无结论" };
  }
  return { confidence: selected.confidence, label: selected.confidence };
}

const formatTokens = (value: number | null) => value === null
  ? "不可用"
  : new Intl.NumberFormat("en-US").format(value);

export function resolvePlannerUsagePresentation(
  usage: LegacyInvestigationResponse["usage"] | null | undefined,
) {
  const completeness = usage?.completeness ?? "UNAVAILABLE";
  return {
    input: formatTokens(usage?.input_tokens ?? null),
    output: formatTokens(usage?.output_tokens ?? null),
    total: formatTokens(usage?.total_tokens ?? null),
    completeness,
    completenessLabel: completeness === "COMPLETE"
      ? "完整"
      : completeness === "PARTIAL"
        ? "部分"
        : "不可用",
  };
}

export type ActionPresentationState =
  | "WAITING_APPROVAL"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "REJECTED"
  | "CANCELLED"
  | "RECONCILIATION_REQUIRED"
  | "UNAVAILABLE";

export type SuccessfulGithubIssue = ValidatedGithubIssue;

export function resolveSuccessfulGithubIssue(
  aggregate: InvestigationAggregate | null,
): SuccessfulGithubIssue | null {
  const action = aggregate?.proposedAction ?? null;
  if (!action || action.status !== "SUCCEEDED") return null;
  const call = aggregate?.toolCalls.find((item) => item.proposedActionId === action.id
    && item.name === "create_github_issue") ?? null;
  const approval = aggregate?.approval;
  if (!approval?.targetOwner || !approval.targetRepo) return null;
  return resolveValidatedGithubIssue(call, {
    owner: approval.targetOwner,
    repo: approval.targetRepo,
  });
};

export function resolveActionPresentation(
  aggregate: InvestigationAggregate | null,
): { state: ActionPresentationState; title: string; detail: string } {
  const action = aggregate?.proposedAction ?? null;
  const approval = aggregate?.approval ?? null;
  const call = action
    ? aggregate?.toolCalls.find((item) => item.proposedActionId === action.id
      && item.name === "create_github_issue") ?? null
    : null;

  if (approval?.status === "REJECTED" || action?.status === "REJECTED" || call?.status === "DENIED") {
    return { state: "REJECTED", title: "方案已驳回，工作项未创建", detail: "审批拒绝已持久化，外部 Action 未执行。" };
  }
  if (approval?.status === "WITHDRAWN" || action?.status === "CANCELLED"
    || action?.status === "SUPERSEDED" || call?.status === "CANCELLED") {
    return { state: "CANCELLED", title: "Action 已取消，工作项未创建", detail: "当前审批快照或 Action 已撤回。" };
  }
  if (action?.status === "FAILED" || call?.status === "ERROR" || call?.result?.status === "ERROR") {
    return { state: "FAILED", title: "工作项创建失败", detail: call?.result?.errorMessage ?? "外部 Action 未成功完成。" };
  }
  if (action?.status === "RECONCILIATION_REQUIRED"
    || call?.status === "RECONCILIATION_REQUIRED") {
    return {
      state: "RECONCILIATION_REQUIRED",
      title: "工作项结果待核对",
      detail: "外部写入结果尚不确定；系统只会通过稳定 marker 核对，不会盲目重复创建。",
    };
  }
  if (action?.status === "EXECUTING" || call?.status === "RUNNING") {
    return { state: "RUNNING", title: "正在创建工作项", detail: "已批准 Action 正在执行，尚无成功结果。" };
  }
  if (resolveSuccessfulGithubIssue(aggregate)) {
    return { state: "SUCCEEDED", title: "工作项已创建，尚未确认修复上线", detail: "GitHub Issue 已成功返回；完成上线确认后才能进入 Verification。" };
  }
  if (action?.status === "SUCCEEDED" || call?.status === "COMPLETED") {
    return { state: "FAILED", title: "工作项结果不可用", detail: "持久化 Action 状态与有效 GitHub Issue 结果不一致。" };
  }
  if (action || approval || call) {
    return { state: "WAITING_APPROVAL", title: "等待审批，工作项尚未创建", detail: "只有批准并成功执行 GitHub Action 后才会创建工作项。" };
  }
  return { state: "UNAVAILABLE", title: "工作项尚未创建", detail: "当前 Run 没有可执行的外部 Action。" };
}
