import type {
  Confidence,
  InvestigationAggregate,
  LegacyInvestigationResponse,
} from "./types";

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
  | "UNAVAILABLE";

export type SuccessfulGithubIssue = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  deduplicated: boolean;
};

const parseGithubIssueResult = (output: unknown): SuccessfulGithubIssue | null => {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const issue = output as Record<string, unknown>;
  if (!(Number.isInteger(issue.number)
    && Number(issue.number) > 0
    && typeof issue.title === "string"
    && issue.title.trim().length > 0
    && typeof issue.url === "string"
    && /^https:\/\//.test(issue.url)
    && typeof issue.createdAt === "string"
    && issue.createdAt.length > 0)) return null;
  return {
    number: Number(issue.number),
    title: issue.title,
    url: issue.url,
    createdAt: issue.createdAt,
    deduplicated: issue.deduplicated === true,
  };
};

export function resolveSuccessfulGithubIssue(
  aggregate: InvestigationAggregate | null,
): SuccessfulGithubIssue | null {
  const action = aggregate?.proposedAction ?? null;
  if (!action || action.status !== "SUCCEEDED") return null;
  const call = aggregate?.toolCalls.find((item) => item.proposedActionId === action.id
    && item.name === "create_github_issue") ?? null;
  if (call?.status !== "COMPLETED" || call.result?.status !== "SUCCESS") return null;
  return parseGithubIssueResult(call.result.output);
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
