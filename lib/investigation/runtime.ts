import { canonicalize, createToolSignature } from "./state";
import type { AnalyticsStore } from "../analytics/store";
import type { DiagnosisDraft } from "./model";
import type { InvestigationStore } from "./store";
import { isPhase3Store } from "./phase3-store";
import { executeNamedTool, extractToolEvidence, type ToolArgs } from "./tools";
import type {
  Approval,
  AuditEvent,
  Diagnosis,
  Evidence,
  InvestigationAggregate,
  InvestigationRun,
  LegacyInvestigationResponse,
  ProposedAction,
  ToolCall,
  ToolResult,
} from "./types";
import type { FeedbackRetriever, IncidentRetriever } from "../retrieval/types";

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const sha256 = async (value: unknown) => {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
};

export async function startInvestigation(
  store: InvestigationStore,
  input: {
    question: string;
    provider: string;
    model: string;
    incidentId?: string;
    riskEventId?: string | null;
    releaseId?: string | null;
  },
) {
  const now = new Date().toISOString();
  const run: InvestigationRun = {
    id: createId("RUN"),
    incidentId: input.incidentId ?? "RG-2026-0726-01",
    riskEventId: input.riskEventId ?? null,
    releaseId: input.releaseId ?? null,
    question: input.question,
    provider: input.provider,
    model: input.model,
    plannerType: input.model === "android-7.3.0-fixture" ? "DETERMINISTIC" : "LLM",
    status: "PENDING",
    currentIteration: 0,
    activeIterationId: null,
    lockVersion: 0,
    stopReason: null,
    currentDiagnosisRevision: 0,
    totalTokens: 0,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.createRun(run);
  const startedAt = new Date().toISOString();
  await store.transitionRun(run.id, "RUNNING", { startedAt });
  return run.id;
}

export async function executeAndRecordTool(
  store: InvestigationStore,
  input: {
    runId: string;
    name: string;
    args: ToolArgs;
    iteration: number;
    order: number;
    analytics?: AnalyticsStore;
    agentIterationId?: string | null;
    triggerMessageId?: string | null;
    feedbackRetriever?: FeedbackRetriever;
    incidentRetriever?: IncidentRetriever;
  },
) {
  const requestedAt = new Date().toISOString();
  const call: ToolCall = {
    id: createId("TC"),
    runId: input.runId,
    name: input.name,
    arguments: input.args,
    canonicalSignature: createToolSignature(input.name, input.args),
    status: "REQUESTED",
    proposedActionId: null,
    approvalId: null,
    agentIterationId: input.agentIterationId ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    cacheSourceToolCallId: null,
    iteration: input.iteration,
    order: input.order,
    resultId: null,
    requestedAt,
    startedAt: null,
    completedAt: null,
  };
  await store.createToolCall(call);
  const startedAt = new Date().toISOString();
  await store.markToolCallRunning(call.id, startedAt);
  const aggregate = await store.getAggregate(input.runId);
  const [riskEvent, release] = await Promise.all([
    aggregate?.riskEvent
      ?? (input.analytics && aggregate?.run.riskEventId
        ? input.analytics.getRiskEvent(aggregate.run.riskEventId)
        : null),
    aggregate?.release
      ?? (input.analytics && aggregate?.run.releaseId
        ? input.analytics.getRelease(aggregate.run.releaseId)
        : null),
  ]);
  const execution = await executeNamedTool(input.name, input.args, {
    analytics: input.analytics,
    riskEvent,
    release,
    feedbackRetriever: input.feedbackRetriever,
    incidentRetriever: input.incidentRetriever,
  });
  const completedAt = new Date().toISOString();
  const result: ToolResult = {
    id: createId("TR"),
    runId: input.runId,
    toolCallId: call.id,
    status: execution.status,
    output: execution.output,
    errorMessage: execution.errorMessage,
    retryable: execution.retryable,
    createdAt: completedAt,
  };
  await store.completeToolCall(call.id, result, completedAt);

  const evidence: Evidence[] = execution.status === "SUCCESS"
    ? extractToolEvidence(input.name, execution.output).map((draft) => ({
        id: createId("EV"),
        runId: input.runId,
        toolResultId: result.id,
        ...draft,
        collectedAt: completedAt,
      }))
    : [];
  await store.saveEvidence(evidence);
  return { call, result, evidence };
}

export async function finalizeInvestigation(
  store: InvestigationStore,
  input: {
    runId: string;
    diagnosis: DiagnosisDraft;
    totalTokens: number;
    evidenceCount: number;
  },
) {
  const now = new Date().toISOString();
  const beforeFinal = await store.getAggregate(input.runId);
  const revision = (beforeFinal?.run.currentDiagnosisRevision ?? beforeFinal?.diagnoses.length ?? 0) + 1;
  const previousDiagnosis = beforeFinal?.diagnoses.at(-1) ?? null;
  const previousAction = beforeFinal?.proposedActions.at(-1) ?? null;
  const previousApproval = beforeFinal?.approvals.at(-1) ?? null;
  const diagnosis: Diagnosis = {
    id: createId("DX"),
    runId: input.runId,
    rootCause: input.diagnosis.rootCause,
    summary: input.diagnosis.summary,
    causalChain: input.diagnosis.causalChain,
    affectedMetrics: input.diagnosis.affectedMetrics,
    affectedSegments: input.diagnosis.affectedSegments,
    validatedClaims: input.diagnosis.validatedClaims,
    unvalidatedClaims: input.diagnosis.unvalidatedClaims,
    confidence: input.diagnosis.confidence,
    severity: input.diagnosis.severity,
    recommendedAction: input.diagnosis.recommendedAction,
    revision,
    status: "FINAL",
    supersedesDiagnosisId: previousDiagnosis?.id ?? null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveDiagnosis(diagnosis);
  if (isPhase3Store(store)) {
    await store.saveDiagnosisEvidenceLinks((beforeFinal?.evidence ?? []).map((item) => ({
      id: createId("DEL"),
      runId: input.runId,
      diagnosisId: diagnosis.id,
      evidenceId: item.id,
      relationship: "VALIDATES" as const,
      createdAt: now,
    })));
  }

  if (!input.diagnosis.requiresHumanApproval) {
    await store.transitionRun(input.runId, "INCONCLUSIVE", {
      totalTokens: input.totalTokens,
      completedAt: now,
    });
    return;
  }

  const runContext = await store.getAggregate(input.runId);
  const action: ProposedAction = {
    id: createId("PA"),
    runId: input.runId,
    diagnosisId: diagnosis.id,
    type: "CREATE_GITHUB_ISSUE",
    status: "PENDING_APPROVAL",
    title: `修复 ${runContext?.release?.platform ?? "Android"} ${runContext?.release?.version ?? "7.3.0"} 优惠券领取成功率异常`,
    arguments: {
      incidentId: runContext?.run.incidentId ?? "RG-2026-0726-01",
      riskEventId: runContext?.run.riskEventId ?? null,
      releaseId: runContext?.run.releaseId ?? null,
      rootCause: diagnosis.rootCause,
      recommendation: diagnosis.recommendedAction,
      confidence: diagnosis.confidence,
      evidenceCount: input.evidenceCount,
    },
    rationale: diagnosis.summary,
    revision,
    supersedesProposedActionId: previousAction?.id ?? null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveProposedAction(action);

  const approval: Approval = {
    id: createId("APR"),
    runId: input.runId,
    proposedActionId: action.id,
    status: "PENDING",
    decision: null,
    reason: null,
    requestedBy: "ReleaseGuard Agent",
    decidedBy: null,
    targetOwner: null,
    targetRepo: null,
    revision,
    supersedesApprovalId: previousApproval?.id ?? null,
    withdrawnAt: null,
    createdAt: now,
    decidedAt: null,
  };
  await store.saveApproval(approval);
  if (isPhase3Store(store)) {
    const frozenPayload = {
      runId: input.runId,
      diagnosis,
      proposedAction: action,
      revision,
    };
    await store.saveApprovalSnapshot({
      id: createId("APS"),
      approvalId: approval.id,
      runId: input.runId,
      diagnosisId: diagnosis.id,
      proposedActionId: action.id,
      revision,
      frozenPayload,
      checksum: await sha256(frozenPayload),
      lifecycleStatus: "ACTIVE",
      createdAt: now,
      withdrawnAt: null,
    });
  }

  const actionArguments = { title: action.title, ...action.arguments };
  const actionCall: ToolCall = {
    id: createId("TC"),
    runId: input.runId,
    name: "create_github_issue",
    arguments: actionArguments,
    canonicalSignature: createToolSignature("create_github_issue", actionArguments),
    status: "WAITING_APPROVAL",
    proposedActionId: action.id,
    approvalId: approval.id,
    agentIterationId: null,
    triggerMessageId: null,
    cacheSourceToolCallId: null,
    iteration: 0,
    order: 1_000,
    resultId: null,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
  };
  await store.createToolCall(actionCall);

  const events: AuditEvent[] = [
    {
      id: createId("AE"),
      runId: input.runId,
      proposedActionId: action.id,
      approvalId: null,
      toolCallId: actionCall.id,
      type: "PROPOSED_ACTION_CREATED",
      actor: "ReleaseGuard Agent",
      details: { actionType: action.type, actionStatus: action.status },
      createdAt: now,
    },
    {
      id: createId("AE"),
      runId: input.runId,
      proposedActionId: action.id,
      approvalId: approval.id,
      toolCallId: actionCall.id,
      type: "APPROVAL_REQUESTED",
      actor: "ReleaseGuard Agent",
      details: { approvalStatus: approval.status },
      createdAt: now,
    },
  ];
  await store.saveAuditEvents(events);
  await store.transitionRun(input.runId, "WAITING_APPROVAL", {
    totalTokens: input.totalTokens,
    completedAt: null,
    currentDiagnosisRevision: revision,
  });
}

export async function markInvestigationInconclusive(
  store: InvestigationStore,
  runId: string,
  totalTokens: number,
) {
  await store.transitionRun(runId, "INCONCLUSIVE", {
    totalTokens,
    completedAt: new Date().toISOString(),
  });
}

export async function markInvestigationFailed(
  store: InvestigationStore,
  runId: string,
  errorMessage: string,
) {
  const aggregate = await store.getAggregate(runId);
  if (!aggregate || aggregate.run.status === "FAILED") return;
  if (aggregate.run.status !== "PENDING" && aggregate.run.status !== "RUNNING") return;
  await store.transitionRun(runId, "FAILED", {
    errorMessage,
    completedAt: new Date().toISOString(),
  });
}

export function fixtureDiagnosis(): DiagnosisDraft {
  return {
    rootCause: "Android 7.3.0 的服务端立即重试策略与幂等锁生命周期冲突",
    summary: "指标异常时间、版本改动和用户反馈形成交叉证据；历史事故仅用于支持假设。",
    causalChain: [
      "Android 7.3.0 发布",
      "优惠券请求改为服务端立即重试",
      "重试请求与幂等锁生命周期冲突",
      "领取请求超时或失败",
      "coupon_claim_success_rate 从 96% 降至 78%",
    ],
    affectedMetrics: ["coupon_claim_success_rate"],
    affectedSegments: ["platform=Android", "app_version=7.3.0"],
    validatedClaims: [
      "异常始于 Android 7.3.0 发布后 6 分钟",
      "CouponClaimService 与 IdempotencyGuard 在该版本发生高风险改动",
      "异常窗口内出现优惠券超时和重复加载反馈",
    ],
    unvalidatedClaims: ["尚未验证其他 Android 版本是否完全不受影响"],
    confidence: "HIGH",
    severity: "HIGH",
    recommendedAction: "回滚重试策略，并补充幂等锁超时保护",
    requiresHumanApproval: true,
  };
}

export function toLegacyResponse(
  aggregate: InvestigationAggregate,
  options: {
    mode: "live" | "fixture";
    parseStatus: "direct" | "repaired" | "raw" | "fixture";
    rawConclusion?: string | null;
  },
): LegacyInvestigationResponse {
  return {
    mode: options.mode,
    provider: aggregate.run.provider,
    model: aggregate.run.model,
    runId: aggregate.run.id,
    runStatus: aggregate.run.status,
    trace: aggregate.toolCalls.filter((call) => call.proposedActionId === null).map((call) => ({
      tool: call.name,
      arguments: call.arguments,
      output: call.result?.output ?? { error: call.result?.errorMessage ?? "暂无结果" },
      status: call.result?.status ?? "ERROR",
      toolCallId: call.id,
      toolResultId: call.result?.id ?? null,
    })),
    conclusion: {
      root_cause: aggregate.diagnosis?.rootCause ?? "证据不足，需人工复核",
      confidence: aggregate.diagnosis?.confidence ?? null,
      recommendation: aggregate.diagnosis?.recommendedAction ?? "补充调查后再执行变更",
      requires_human_approval: aggregate.run.status === "WAITING_APPROVAL",
      evidence_summary: aggregate.evidence.map((item) => item.statement),
      parse_status: options.parseStatus,
      raw_conclusion: options.rawConclusion ?? null,
    },
    usage: { total_tokens: aggregate.run.totalTokens },
    investigation: aggregate,
  };
}
