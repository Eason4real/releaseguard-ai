import type { InvestigationStore } from "./store";
import type {
  Approval,
  AuditEvent,
  InvestigationAggregate,
  ProposedAction,
  ToolCallWithResult,
  ToolResult,
} from "./types";

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export class RuntimeRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const assertIdentifier = (value: string, label: string) => {
  if (!value || value.length > 200) {
    throw new RuntimeRequestError("INVALID_IDENTIFIER", `${label}不正确。`, 400);
  }
};

const findActionCall = (
  aggregate: InvestigationAggregate,
  actionId: string,
): ToolCallWithResult => {
  const call = aggregate.toolCalls.find((item) =>
    item.proposedActionId === actionId && item.name === "create_github_issue");
  if (!call) {
    throw new RuntimeRequestError("ACTION_CALL_NOT_FOUND", "没有找到该建议对应的 Action ToolCall。", 409);
  }
  return call;
};

const validateActionContext = (
  aggregate: InvestigationAggregate | null,
  runId: string,
  proposedActionId: string,
) => {
  if (!aggregate) {
    throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);
  }
  const action = aggregate.proposedAction;
  if (!action || action.id !== proposedActionId || action.runId !== runId) {
    throw new RuntimeRequestError(
      "ACTION_RUN_MISMATCH",
      "ProposedAction 不属于指定的 InvestigationRun。",
      409,
    );
  }
  const approval = aggregate.approval;
  if (!approval || approval.proposedActionId !== action.id || approval.runId !== runId) {
    throw new RuntimeRequestError(
      "APPROVAL_ACTION_MISMATCH",
      "Approval 不属于指定的 ProposedAction。",
      409,
    );
  }
  return { aggregate, action, approval, call: findActionCall(aggregate, action.id) };
};

const audit = (
  input: Omit<AuditEvent, "id" | "createdAt"> & { createdAt?: string },
): AuditEvent => ({
  id: createId("AE"),
  createdAt: input.createdAt ?? new Date().toISOString(),
  ...input,
});

export async function decideProposedAction(
  store: InvestigationStore,
  input: {
    runId: string;
    proposedActionId: string;
    decision: "APPROVE" | "REJECT";
    reason?: string | null;
    targetOwner?: string | null;
    targetRepo?: string | null;
  },
) {
  assertIdentifier(input.runId, "runId");
  assertIdentifier(input.proposedActionId, "proposedActionId");
  const reason = input.reason?.trim().slice(0, 2_000) || null;
  const targetOwner = input.targetOwner?.trim() || null;
  const targetRepo = input.targetRepo?.trim() || null;
  if (
    input.decision === "APPROVE"
    && (
      !targetOwner
      || !targetRepo
      || !/^[A-Za-z0-9_.-]+$/.test(targetOwner)
      || !/^[A-Za-z0-9_.-]+$/.test(targetRepo)
    )
  ) {
    throw new RuntimeRequestError(
      "ACTION_TARGET_REQUIRED",
      "批准前需要选择有效的 GitHub 用户或组织及仓库。",
      400,
    );
  }

  const context = validateActionContext(
    await store.getAggregate(input.runId),
    input.runId,
    input.proposedActionId,
  );
  if (context.aggregate.run.status !== "WAITING_APPROVAL") {
    throw new RuntimeRequestError(
      "RUN_NOT_WAITING_APPROVAL",
      `Run 当前为 ${context.aggregate.run.status}，不能审批。`,
      409,
    );
  }
  if (context.action.status !== "PENDING_APPROVAL") {
    throw new RuntimeRequestError("ACTION_NOT_APPROVABLE", "ProposedAction 已经处理过。", 409);
  }
  if (context.approval.status !== "PENDING") {
    throw new RuntimeRequestError("APPROVAL_ALREADY_DECIDED", "Approval 已经做出决定。", 409);
  }
  if (context.call.status !== "WAITING_APPROVAL") {
    throw new RuntimeRequestError("ACTION_CALL_NOT_WAITING", "Action ToolCall 不在待审批状态。", 409);
  }

  const now = new Date().toISOString();
  const actor = "Product Manager · Workspace Owner";
  const decided = await store.decideApproval(context.approval.id, input.decision, {
    reason,
    decidedBy: actor,
    targetOwner: input.decision === "APPROVE" ? targetOwner : null,
    targetRepo: input.decision === "APPROVE" ? targetRepo : null,
    decidedAt: now,
  });
  if (!decided) {
    throw new RuntimeRequestError("APPROVAL_ALREADY_DECIDED", "Approval 已经做出决定。", 409);
  }

  if (input.decision === "APPROVE") {
    const updated = await store.updateProposedActionStatus(
      context.action.id,
      "PENDING_APPROVAL",
      "APPROVED",
    );
    if (!updated) {
      throw new RuntimeRequestError("ACTION_DECISION_RACE", "ProposedAction 状态已经变化。", 409);
    }
    await store.saveAuditEvents([audit({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      type: "APPROVAL_APPROVED",
      actor,
      details: { reason, targetOwner, targetRepo },
      createdAt: now,
    })]);
  } else {
    const actionUpdated = await store.updateProposedActionStatus(
      context.action.id,
      "PENDING_APPROVAL",
      "REJECTED",
    );
    const callUpdated = await store.updateActionToolCall(
      context.call.id,
      "WAITING_APPROVAL",
      "DENIED",
      { completedAt: now },
    );
    if (!actionUpdated || !callUpdated) {
      throw new RuntimeRequestError("ACTION_DECISION_RACE", "ProposedAction 状态已经变化。", 409);
    }
    await store.saveAuditEvents([audit({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      type: "APPROVAL_REJECTED",
      actor,
      details: { reason },
      createdAt: now,
    })]);
    await store.transitionRun(input.runId, "CLOSED_NO_ACTION", { completedAt: now });
  }

  const aggregate = await store.getAggregate(input.runId);
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "审批后无法读取 Run。", 500);
  return aggregate;
}

type GithubIssueOutput = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  deduplicated: boolean;
};

const githubHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "ReleaseGuard-AI",
  "X-GitHub-Api-Version": "2022-11-28",
});

async function callGithub(
  fetcher: typeof fetch,
  input: {
    owner: string;
    repo: string;
    token: string;
    runId: string;
    action: ProposedAction;
    approval: Approval;
  },
): Promise<GithubIssueOutput> {
  const marker = `<!-- releaseguard-action:${input.runId}:${input.action.id} -->`;
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`;
  const headers = githubHeaders(input.token);
  const existingResponse = await fetcher(`${apiUrl}?state=all&per_page=100`, { headers });
  if (!existingResponse.ok) {
    const detail = await existingResponse.json().catch(() => null) as { message?: string } | null;
    throw new RuntimeRequestError(
      "GITHUB_READ_FAILED",
      `GitHub 连接失败：${detail?.message || existingResponse.statusText}`,
      existingResponse.status,
    );
  }
  const existing = await existingResponse.json() as Array<{
    number: number;
    title: string;
    html_url: string;
    body?: string | null;
  }>;
  const duplicate = existing.find((item) => item.body?.includes(marker));
  if (duplicate) {
    return {
      number: duplicate.number,
      title: duplicate.title,
      url: duplicate.html_url,
      createdAt: new Date().toISOString(),
      deduplicated: true,
    };
  }

  const args = input.action.arguments;
  const confidence = typeof args.confidence === "string" ? args.confidence : "待人工复核";
  const body = [
    marker,
    "## ReleaseGuard AI 修复任务",
    "",
    `- Run：${input.runId}`,
    `- ProposedAction：${input.action.id}`,
    `- Approval：${input.approval.id}`,
    `- 事件：${String(args.incidentId ?? "—")}`,
    `- 根因置信度：${confidence}`,
    `- 调查证据：${String(args.evidenceCount ?? "—")} 条`,
    "",
    "### 根因判断",
    String(args.rootCause ?? "未提供"),
    "",
    "### 建议方案",
    String(args.recommendation ?? "未提供"),
    "",
    "> 此任务由服务端根据已批准的 ProposedAction 创建。请在合并与发布前继续执行代码评审和测试流程。",
  ].join("\n");
  const createResponse = await fetcher(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: `[P1][${String(args.incidentId ?? input.runId)}] ${input.action.title}`, body }),
  });
  const created = await createResponse.json() as {
    number?: number;
    title?: string;
    html_url?: string;
    created_at?: string;
    message?: string;
  };
  if (!createResponse.ok || !created.number || !created.html_url) {
    throw new RuntimeRequestError(
      "GITHUB_CREATE_FAILED",
      `GitHub Issue 创建失败：${created.message || createResponse.statusText}`,
      createResponse.status,
    );
  }
  return {
    number: created.number,
    title: created.title || input.action.title,
    url: created.html_url,
    createdAt: created.created_at || new Date().toISOString(),
    deduplicated: false,
  };
}

export async function executeApprovedGithubAction(
  store: InvestigationStore,
  input: {
    runId: string;
    proposedActionId: string;
    token: string;
  },
  fetcher: typeof fetch = fetch,
) {
  assertIdentifier(input.runId, "runId");
  assertIdentifier(input.proposedActionId, "proposedActionId");
  if (!input.token.trim() || input.token.length > 2_000) {
    throw new RuntimeRequestError("GITHUB_TOKEN_REQUIRED", "GitHub 访问令牌不能为空。", 400);
  }

  const context = validateActionContext(
    await store.getAggregate(input.runId),
    input.runId,
    input.proposedActionId,
  );
  if (
    (context.aggregate.run.status === "WAITING_ACTION_COMPLETION"
      || context.aggregate.run.status === "WAITING_VERIFICATION")
    && context.action.status === "SUCCEEDED"
    && context.call.status === "SUCCESS"
    && context.call.result?.status === "SUCCESS"
  ) {
    throw new RuntimeRequestError(
      "ACTION_ALREADY_EXECUTED",
      "该 ProposedAction 已成功执行，禁止重复创建 GitHub Issue。",
      409,
    );
  }
  if (context.approval.status !== "APPROVED" || context.approval.decision !== "APPROVE") {
    throw new RuntimeRequestError("APPROVAL_REQUIRED", "该 ProposedAction 尚未获得有效批准。", 403);
  }
  if (!context.approval.targetOwner || !context.approval.targetRepo) {
    throw new RuntimeRequestError("ACTION_TARGET_MISSING", "已批准动作缺少冻结的 GitHub 目标。", 409);
  }
  if (context.aggregate.run.status !== "WAITING_APPROVAL") {
    throw new RuntimeRequestError(
      "RUN_NOT_READY_FOR_ACTION",
      `Run 当前为 ${context.aggregate.run.status}，不能执行 Action。`,
      409,
    );
  }
  if (context.action.status !== "APPROVED" || context.call.status !== "WAITING_APPROVAL") {
    throw new RuntimeRequestError("ACTION_NOT_EXECUTABLE", "ProposedAction 已执行或状态不正确。", 409);
  }

  const startedAt = new Date().toISOString();
  const actionStarted = await store.updateProposedActionStatus(
    context.action.id,
    "APPROVED",
    "EXECUTING",
  );
  const callStarted = await store.updateActionToolCall(
    context.call.id,
    "WAITING_APPROVAL",
    "RUNNING",
    { approvalId: context.approval.id, startedAt },
  );
  if (!actionStarted || !callStarted) {
    throw new RuntimeRequestError("ACTION_REPLAY_BLOCKED", "Action 已被其他请求执行。", 409);
  }
  await store.transitionRun(input.runId, "ACTION_EXECUTING");
  await store.saveAuditEvents([audit({
    runId: input.runId,
    proposedActionId: context.action.id,
    approvalId: context.approval.id,
    toolCallId: context.call.id,
    type: "ACTION_EXECUTION_STARTED",
    actor: "ReleaseGuard Action Runtime",
    details: {
      tool: context.call.name,
      targetOwner: context.approval.targetOwner,
      targetRepo: context.approval.targetRepo,
    },
    createdAt: startedAt,
  })]);

  try {
    const output = await callGithub(fetcher, {
      owner: context.approval.targetOwner,
      repo: context.approval.targetRepo,
      token: input.token.trim(),
      runId: input.runId,
      action: context.action,
      approval: context.approval,
    });
    const completedAt = new Date().toISOString();
    const result: ToolResult = {
      id: createId("TR"),
      runId: input.runId,
      toolCallId: context.call.id,
      status: "SUCCESS",
      output,
      errorMessage: null,
      retryable: false,
      createdAt: completedAt,
    };
    const callCompleted = await store.completeActionToolCall(
      context.call.id,
      "RUNNING",
      result,
      completedAt,
    );
    const actionCompleted = await store.updateProposedActionStatus(
      context.action.id,
      "EXECUTING",
      "SUCCEEDED",
    );
    if (!callCompleted || !actionCompleted) {
      throw new RuntimeRequestError("ACTION_COMPLETION_RACE", "Action 执行结果无法安全写入。", 409);
    }
    await store.saveAuditEvents([audit({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      type: "ACTION_SUCCEEDED",
      actor: "ReleaseGuard Action Runtime",
      details: { ...output },
      createdAt: completedAt,
    })]);
    await store.transitionRun(input.runId, "WAITING_ACTION_COMPLETION");
    return output;
  } catch (error) {
    const runtimeError = error instanceof RuntimeRequestError
      ? error
      : new RuntimeRequestError(
          "GITHUB_REQUEST_FAILED",
          error instanceof Error ? error.message : "GitHub 请求失败。",
          502,
        );
    const failedAt = new Date().toISOString();
    const result: ToolResult = {
      id: createId("TR"),
      runId: input.runId,
      toolCallId: context.call.id,
      status: "ERROR",
      output: null,
      errorMessage: runtimeError.message,
      retryable: runtimeError.status >= 500,
      createdAt: failedAt,
    };
    await store.completeActionToolCall(context.call.id, "RUNNING", result, failedAt);
    await store.updateProposedActionStatus(context.action.id, "EXECUTING", "FAILED");
    await store.saveAuditEvents([audit({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      type: "ACTION_FAILED",
      actor: "ReleaseGuard Action Runtime",
      details: { code: runtimeError.code, message: runtimeError.message },
      createdAt: failedAt,
    })]);
    await store.transitionRun(input.runId, "FAILED", {
      errorMessage: runtimeError.message,
      completedAt: failedAt,
    });
    throw runtimeError;
  }
}
