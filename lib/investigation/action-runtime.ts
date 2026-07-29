import type { InvestigationStore } from "./store";
import type {
  Approval,
  AuditEvent,
  InvestigationAggregate,
  ProposedAction,
  ToolCallWithResult,
  ToolResult,
} from "./types";
import {
  GITHUB_ACTION_LEASE_MS,
  GithubIssueResponseValidationError,
  isCanonicalCompletedToolCall,
  normalizeGithubTarget,
  resolveValidatedGithubIssue,
  validateGithubIssueResponse,
  type FrozenGithubTarget,
  type ValidatedGithubIssue,
} from "./github-action-state";

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

const githubHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "ReleaseGuard-AI",
  "X-GitHub-Api-Version": "2022-11-28",
});

class GithubExternalRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly outcomeUncertain: boolean,
    message: string,
  ) {
    super(message);
  }
}

const githubRequestContext = (input: {
  target: FrozenGithubTarget;
  token: string;
  runId: string;
  action: ProposedAction;
  approval: Approval;
}) => ({
  marker: `<!-- releaseguard-action:${input.runId}:${input.action.id} -->`,
  apiUrl: `https://api.github.com/repos/${encodeURIComponent(input.target.owner)}/${encodeURIComponent(input.target.repo)}/issues`,
  headers: githubHeaders(input.token),
});

async function findExistingGithubIssue(
  fetcher: typeof fetch,
  input: {
    target: FrozenGithubTarget;
    token: string;
    runId: string;
    action: ProposedAction;
    approval: Approval;
  },
): Promise<ValidatedGithubIssue | null> {
  const { marker, apiUrl, headers } = githubRequestContext(input);
  let existingResponse: Response;
  try {
    existingResponse = await fetcher(`${apiUrl}?state=all&per_page=100`, { headers });
  } catch {
    throw new GithubExternalRequestError(
      "GITHUB_RECONCILIATION_READ_FAILED", 502, false,
      "GitHub marker 核对请求未完成；尚未发出创建请求。",
    );
  }
  if (!existingResponse.ok) {
    throw new GithubExternalRequestError(
      "GITHUB_RECONCILIATION_READ_FAILED", existingResponse.status, false,
      "GitHub marker 核对失败；尚未发出创建请求。",
    );
  }
  const existing = await existingResponse.json().catch(() => null);
  if (!Array.isArray(existing)) {
    throw new GithubExternalRequestError(
      "INVALID_GITHUB_LIST_RESPONSE", 502, false,
      "GitHub marker 核对响应格式不正确；尚未发出创建请求。",
    );
  }
  const duplicate = existing.find((item) => item && typeof item === "object"
    && typeof (item as { body?: unknown }).body === "string"
    && (item as { body: string }).body.includes(marker));
  if (!duplicate) return null;
  try {
    return validateGithubIssueResponse(duplicate, input.target, {
      deduplicated: true,
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof GithubIssueResponseValidationError) {
      throw new GithubExternalRequestError(
        error.code, 502, true,
        "Marker 命中的 GitHub Issue 响应未通过目标校验，需要人工核对。",
      );
    }
    throw error;
  }
}

async function createGithubIssue(
  fetcher: typeof fetch,
  input: {
    target: FrozenGithubTarget;
    token: string;
    runId: string;
    action: ProposedAction;
    approval: Approval;
  },
): Promise<ValidatedGithubIssue> {
  const { marker, apiUrl, headers } = githubRequestContext(input);
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
  let createResponse: Response;
  try {
    createResponse = await fetcher(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `[P1][${String(args.incidentId ?? input.runId)}] ${input.action.title}`,
        body,
      }),
    });
  } catch {
    throw new GithubExternalRequestError(
      "GITHUB_CREATE_OUTCOME_UNKNOWN", 502, true,
      "GitHub 创建请求连接中断，外部结果未知，需要 marker reconciliation。",
    );
  }
  const created = await createResponse.json().catch(() => null);
  if (!createResponse.ok) {
    const uncertain = createResponse.status >= 500 || createResponse.status === 408;
    throw new GithubExternalRequestError(
      uncertain ? "GITHUB_CREATE_OUTCOME_UNKNOWN" : "GITHUB_CREATE_REJECTED",
      createResponse.status,
      uncertain,
      uncertain
        ? "GitHub 创建结果未知，需要 marker reconciliation。"
        : "GitHub 明确拒绝了 Issue 创建请求。",
    );
  }
  try {
    return validateGithubIssueResponse(created, input.target, {
      deduplicated: false,
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof GithubIssueResponseValidationError) {
      throw new GithubExternalRequestError(
        error.code, 502, true,
        "GitHub 返回成功但 Issue 响应未通过目标校验，需要 marker reconciliation。",
      );
    }
    throw error;
  }
}

const activeSnapshotFor = (
  aggregate: InvestigationAggregate,
  action: ProposedAction,
  approval: Approval,
) => aggregate.approvalSnapshots.find((item) =>
  item.runId === aggregate.run.id
  && item.proposedActionId === action.id
  && item.approvalId === approval.id
  && item.revision === action.revision
  && item.lifecycleStatus === "ACTIVE") ?? null;

const executionError = (code: string, message: string, status = 409) =>
  new RuntimeRequestError(code, message, status);

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

  let context = validateActionContext(
    await store.getAggregate(input.runId),
    input.runId,
    input.proposedActionId,
  );
  if (
    (context.aggregate.run.status === "WAITING_ACTION_COMPLETION"
      || context.aggregate.run.status === "WAITING_VERIFICATION")
    && context.action.status === "SUCCEEDED"
    && context.approval.targetOwner
    && context.approval.targetRepo
    && isCanonicalCompletedToolCall(context.call)
    && resolveValidatedGithubIssue(context.call, {
      owner: context.approval.targetOwner ?? "",
      repo: context.approval.targetRepo ?? "",
    })
  ) {
    throw new RuntimeRequestError(
      "ALREADY_COMPLETED",
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
  const target = normalizeGithubTarget({
    owner: context.approval.targetOwner,
    repo: context.approval.targetRepo,
  });
  const snapshot = activeSnapshotFor(context.aggregate, context.action, context.approval);
  if (!snapshot) {
    throw executionError("APPROVAL_SNAPSHOT_INVALID", "没有找到当前批准动作的 active frozen snapshot。");
  }

  const persistSuccess = async (output: ValidatedGithubIssue, attemptId: string) => {
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
    const committed = await store.commitGithubActionSuccess({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      attemptId,
      result,
      settledAt: completedAt,
      auditEvent: audit({
        runId: input.runId,
        proposedActionId: context.action.id,
        approvalId: context.approval.id,
        toolCallId: context.call.id,
        type: "ACTION_SUCCEEDED",
        actor: "ReleaseGuard Action Runtime",
        details: {
          issueNumber: output.number,
          issueUrl: output.url,
          repository: output.repository,
          deduplicated: output.deduplicated,
          attemptId,
        },
        createdAt: completedAt,
      }),
    });
    if (!committed) throw executionError("ACTION_COMPLETION_RACE", "Action 执行结果无法原子写入。");
    return output;
  };

  const persistFailure = async (externalError: GithubExternalRequestError, attemptId: string) => {
    const failedAt = new Date().toISOString();
    const result: ToolResult = {
      id: createId("TR"),
      runId: input.runId,
      toolCallId: context.call.id,
      status: "ERROR",
      output: null,
      errorMessage: externalError.message,
      retryable: false,
      createdAt: failedAt,
    };
    const committed = await store.commitGithubActionFailure({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      attemptId,
      result,
      settledAt: failedAt,
      auditEvent: audit({
        runId: input.runId,
        proposedActionId: context.action.id,
        approvalId: context.approval.id,
        toolCallId: context.call.id,
        type: "ACTION_FAILED",
        actor: "ReleaseGuard Action Runtime",
        details: { code: externalError.code, attemptId },
        createdAt: failedAt,
      }),
    });
    if (!committed) throw executionError("ACTION_FAILURE_COMMIT_RACE", "Action 失败结果无法原子写入。");
    throw new RuntimeRequestError(externalError.code, externalError.message, externalError.status);
  };

  const requireReconciliation = async (
    externalError: GithubExternalRequestError,
    attemptId: string,
    eventType: "ACTION_RECONCILIATION_REQUIRED" | "ACTION_RECONCILIATION_CHECKED",
  ): Promise<never> => {
    const observedAt = new Date().toISOString();
    await store.markGithubActionReconciliationRequired({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      attemptId,
      observedAt,
      reasonCode: externalError.code,
      auditEvent: audit({
        runId: input.runId,
        proposedActionId: context.action.id,
        approvalId: context.approval.id,
        toolCallId: context.call.id,
        type: eventType,
        actor: "ReleaseGuard Action Runtime",
        details: { reasonCode: externalError.code, attemptId },
        createdAt: observedAt,
      }),
    });
    throw executionError(
      "RECONCILIATION_REQUIRED",
      "GitHub 写入结果需要通过唯一 marker 核对；在确认前不会再次创建 Issue。",
      409,
    );
  };

  const reconcileOnly = context.action.status === "RECONCILIATION_REQUIRED"
    || context.call.status === "RECONCILIATION_REQUIRED"
    || (context.call.status === "RUNNING" && Boolean(context.call.externalDispatchStartedAt));
  if (reconcileOnly) {
    const attemptId = context.call.executionAttemptId;
    if (!attemptId) throw executionError("INVALID_STATE", "Action recovery 缺少 execution attempt。");
    try {
      const existing = await findExistingGithubIssue(fetcher, {
        target, token: input.token.trim(), runId: input.runId,
        action: context.action, approval: context.approval,
      });
      if (existing) return await persistSuccess(existing, attemptId);
      return await requireReconciliation(new GithubExternalRequestError(
        "GITHUB_MARKER_NOT_FOUND", 409, true,
        "尚未找到稳定 marker 对应的 Issue。",
      ), attemptId, "ACTION_RECONCILIATION_CHECKED");
    } catch (error) {
      if (error instanceof RuntimeRequestError) throw error;
      if (error instanceof GithubExternalRequestError) {
        return requireReconciliation(error, attemptId, "ACTION_RECONCILIATION_CHECKED");
      }
      throw executionError("RECONCILIATION_CHECK_FAILED", "GitHub marker 核对未完成。", 502);
    }
  }

  const now = new Date();
  const reclaim = context.aggregate.run.status === "ACTION_EXECUTING"
    && context.action.status === "EXECUTING"
    && context.call.status === "RUNNING"
    && !context.call.externalDispatchStartedAt;
  if (reclaim && (!context.call.executionLeaseExpiresAt
    || context.call.executionLeaseExpiresAt >= now.toISOString())) {
    throw executionError("EXECUTION_IN_PROGRESS", "Action 已由另一个请求持有执行 lease。");
  }
  if (!reclaim && (context.aggregate.run.status !== "WAITING_APPROVAL"
    || context.action.status !== "APPROVED" || context.call.status !== "WAITING_APPROVAL")) {
    throw executionError("INVALID_STATE", "Run、Action 或 ToolCall 当前状态不可执行。");
  }

  const attemptId = createId("GHA");
  const claimedAt = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + GITHUB_ACTION_LEASE_MS).toISOString();
  const claimed = await store.claimGithubAction({
    mode: reclaim ? "RECLAIM" : "INITIAL",
    runId: input.runId,
    proposedActionId: context.action.id,
    approvalId: context.approval.id,
    approvalSnapshotId: snapshot.id,
    toolCallId: context.call.id,
    expectedLockVersion: context.aggregate.run.lockVersion,
    previousAttemptId: context.call.executionAttemptId ?? null,
    previousLeaseExpiresAt: context.call.executionLeaseExpiresAt ?? null,
    frozenTarget: target,
    attemptId,
    claimedAt,
    leaseExpiresAt,
    auditEvent: audit({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      type: reclaim ? "ACTION_EXECUTION_RECLAIMED" : "ACTION_EXECUTION_STARTED",
      actor: "ReleaseGuard Action Runtime",
      details: { tool: context.call.name, repository: target, attemptId, leaseExpiresAt },
      createdAt: claimedAt,
    }),
  });
  if (!claimed) {
    context = validateActionContext(
      await store.getAggregate(input.runId), input.runId, input.proposedActionId,
    );
    if (context.action.status === "SUCCEEDED" && isCanonicalCompletedToolCall(context.call)) {
      throw executionError("ALREADY_COMPLETED", "Action 已成功完成。");
    }
    if (context.action.status === "RECONCILIATION_REQUIRED"
      || context.call.status === "RECONCILIATION_REQUIRED") {
      throw executionError("RECONCILIATION_REQUIRED", "Action 正在等待 marker reconciliation。");
    }
    if (context.action.status === "EXECUTING" || context.call.status === "RUNNING") {
      throw executionError("EXECUTION_IN_PROGRESS", "Action 已由另一个请求 claim。");
    }
    throw executionError("INVALID_STATE", "Action claim 条件已变化。");
  }

  try {
    const existing = await findExistingGithubIssue(fetcher, {
      target, token: input.token.trim(), runId: input.runId,
      action: context.action, approval: context.approval,
    });
    if (existing) return await persistSuccess(existing, attemptId);
  } catch (error) {
    if (error instanceof GithubExternalRequestError) {
      if (error.outcomeUncertain) return requireReconciliation(error, attemptId,
        "ACTION_RECONCILIATION_REQUIRED");
      return persistFailure(error, attemptId);
    }
    throw error;
  }

  const dispatchedAt = new Date().toISOString();
  const dispatchMarked = await store.markGithubActionDispatchStarted({
    runId: input.runId,
    proposedActionId: context.action.id,
    approvalId: context.approval.id,
    toolCallId: context.call.id,
    attemptId,
    dispatchedAt,
    auditEvent: audit({
      runId: input.runId,
      proposedActionId: context.action.id,
      approvalId: context.approval.id,
      toolCallId: context.call.id,
      type: "ACTION_EXTERNAL_DISPATCH_STARTED",
      actor: "ReleaseGuard Action Runtime",
      details: { attemptId, repository: target },
      createdAt: dispatchedAt,
    }),
  });
  if (!dispatchMarked) throw executionError("EXECUTION_IN_PROGRESS", "Action dispatch ownership 已变化。");

  try {
    const output = await createGithubIssue(fetcher, {
      target, token: input.token.trim(), runId: input.runId,
      action: context.action, approval: context.approval,
    });
    try {
      return await persistSuccess(output, attemptId);
    } catch {
      return requireReconciliation(new GithubExternalRequestError(
        "LOCAL_COMPLETION_FAILED", 500, true,
        "GitHub 已返回成功，但本地 completion transaction 未完成。",
      ), attemptId, "ACTION_RECONCILIATION_REQUIRED");
    }
  } catch (error) {
    if (error instanceof RuntimeRequestError) throw error;
    if (error instanceof GithubExternalRequestError) {
      if (error.outcomeUncertain) return requireReconciliation(error, attemptId,
        "ACTION_RECONCILIATION_REQUIRED");
      return persistFailure(error, attemptId);
    }
    return requireReconciliation(new GithubExternalRequestError(
      "GITHUB_CREATE_OUTCOME_UNKNOWN", 502, true,
      "GitHub 创建结果未知，需要 marker reconciliation。",
    ), attemptId, "ACTION_RECONCILIATION_REQUIRED");
  }
}
