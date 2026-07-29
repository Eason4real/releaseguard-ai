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
  ACTION_EXECUTION_STARTED: "Action execution 已 claim",
  ACTION_EXECUTION_RECLAIMED: "Action execution lease 已恢复",
  ACTION_EXTERNAL_DISPATCH_STARTED: "GitHub create dispatch 已记录",
  ACTION_RECONCILIATION_REQUIRED: "GitHub 写入结果待核对",
  ACTION_RECONCILIATION_CHECKED: "GitHub marker 已核对",
};

export function resolveAuditEventLabel(event: AuditEvent) {
  return plannerAuditLabels[event.type] ?? event.type;
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
