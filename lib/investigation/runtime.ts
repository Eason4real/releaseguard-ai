import { canonicalize, createToolSignature } from "./state";
import { summarizePlannerUsage } from "./planner-usage";
import type { AnalyticsStore } from "../analytics/store";
import type { InvestigationStore } from "./store";
import type { Phase3InvestigationStore } from "./phase3-store";
import {
  diagnosisSeverity,
  dispositionRecommendation,
  validateGroundedDiagnosis,
  type GroundedDiagnosisProposal,
} from "./grounded-diagnosis";
import { executeNamedTool, extractToolEvidence, type ToolArgs } from "./tools";
import type {
  Approval,
  ApprovalSnapshot,
  AuditEvent,
  Diagnosis,
  DiagnosisClaim,
  DiagnosisClaimEvidenceLink,
  Evidence,
  InvestigationAggregate,
  InvestigationRun,
  InvestigationTraceEvent,
  LegacyInvestigationResponse,
  ProposedAction,
  ToolCall,
  ToolResult,
} from "./types";
import type { FeedbackRetriever, IncidentRetriever } from "../retrieval/types";
import { resolveMaxModelCalls } from "./model-call-budget";

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
    maxModelCalls?: number;
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
    modelCallCount: 0,
    maxModelCalls: resolveMaxModelCalls(input.maxModelCalls),
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
  store: Phase3InvestigationStore,
  input: {
    runId: string;
    iterationId: string;
    proposal: GroundedDiagnosisProposal;
    totalTokens: number;
    publicRationale: string;
    traceEvent: InvestigationTraceEvent;
    acceptedAuditEvent: AuditEvent;
  },
) {
  const now = new Date().toISOString();
  const beforeFinal = await store.getAggregate(input.runId);
  if (!beforeFinal) throw new Error("InvestigationRun 不存在。");
  const validated = validateGroundedDiagnosis(beforeFinal, input.proposal);
  const revision = (beforeFinal?.run.currentDiagnosisRevision ?? beforeFinal?.diagnoses.length ?? 0) + 1;
  const previousDiagnosis = beforeFinal?.diagnoses.at(-1) ?? null;
  const previousAction = beforeFinal?.proposedActions.at(-1) ?? null;
  const previousApproval = beforeFinal?.approvals.at(-1) ?? null;
  const rootCause = validated.diagnosis.claims.find((claim) =>
    claim.type === "ROOT_CAUSE")!;
  const causalSteps = validated.diagnosis.claims
    .filter((claim) => claim.type === "CAUSAL_STEP")
    .map((claim) => claim.statement);
  const affectedMetrics = validated.diagnosis.claims
    .filter((claim) => claim.type === "AFFECTED_METRIC")
    .map((claim) => claim.statement);
  const affectedSegments = validated.diagnosis.claims
    .filter((claim) => claim.type === "AFFECTED_SEGMENT")
    .map((claim) => claim.statement);
  const limitations = validated.diagnosis.claims
    .filter((claim) => claim.type === "LIMITATION")
    .map((claim) => claim.statement);
  const diagnosis: Diagnosis = {
    id: createId("DX"),
    runId: input.runId,
    selectedHypothesisId: validated.selectedHypothesis.id,
    groundingStatus: "GROUNDED",
    disposition: validated.disposition,
    rootCause: rootCause.statement,
    summary: validated.diagnosis.summary,
    causalChain: [rootCause.statement, ...causalSteps],
    affectedMetrics,
    affectedSegments,
    validatedClaims: validated.diagnosis.claims
      .filter((claim) => claim.type !== "LIMITATION")
      .map((claim) => claim.statement),
    unvalidatedClaims: limitations,
    confidence: validated.selectedHypothesis.confidence,
    severity: diagnosisSeverity(validated.selectedHypothesis),
    recommendedAction: dispositionRecommendation(validated.disposition),
    revision,
    status: "FINAL",
    supersedesDiagnosisId: previousDiagnosis?.id ?? null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const claims: DiagnosisClaim[] = validated.diagnosis.claims.map((claim) => ({
    id: createId("DCL"),
    runId: input.runId,
    diagnosisId: diagnosis.id,
    type: claim.type,
    limitationType: claim.type === "LIMITATION" ? claim.limitationType : null,
    statement: claim.statement,
    groundingStatus: "GROUNDED",
    createdAt: now,
  }));
  const claimEvidenceLinks: DiagnosisClaimEvidenceLink[] = claims.flatMap((claim, index) =>
    (validated.evidenceByClaim.get(index) ?? []).map((item) => ({
      id: createId("DCEL"),
      runId: input.runId,
      diagnosisId: diagnosis.id,
      claimId: claim.id,
      evidenceId: item.id,
      createdAt: now,
    })));
  const needsAction = validated.disposition !== "OBSERVE";
  const criticalClaimIds = new Set(claims
    .filter((claim) => claim.type !== "LIMITATION")
    .map((claim) => claim.id));
  const groundedCriticalEvidenceCount = new Set(claimEvidenceLinks
    .filter((link) => criticalClaimIds.has(link.claimId))
    .map((link) => link.evidenceId)).size;
  const actionJustification =
    `Grounded ROOT_CAUSE: ${rootCause.statement} ${dispositionRecommendation(validated.disposition)}`;
  const action: ProposedAction | null = needsAction ? {
    id: createId("PA"),
    runId: input.runId,
    diagnosisId: diagnosis.id,
    type: "CREATE_GITHUB_ISSUE",
    status: "PENDING_APPROVAL",
    title: `处理 ${beforeFinal.release?.platform ?? "Android"} ${beforeFinal.release?.version ?? "7.3.0"} 发布风险`,
    arguments: {
      incidentId: beforeFinal.run.incidentId,
      riskEventId: beforeFinal.run.riskEventId,
      releaseId: beforeFinal.run.releaseId,
      rootCause: diagnosis.rootCause,
      recommendation: diagnosis.recommendedAction,
      disposition: diagnosis.disposition,
      confidence: diagnosis.confidence,
      evidenceCount: groundedCriticalEvidenceCount,
    },
    rationale: actionJustification,
    revision,
    supersedesProposedActionId: previousAction?.id ?? null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  } : null;

  const approval: Approval | null = action ? {
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
  } : null;
  const frozenPayload = action && approval ? {
    runId: input.runId,
    diagnosis,
    diagnosisClaims: claims,
    diagnosisClaimEvidenceLinks: claimEvidenceLinks,
    proposedAction: action,
    revision,
  } : null;
  const approvalSnapshot: ApprovalSnapshot | null = action && approval && frozenPayload ? {
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
  } : null;

  const actionArguments = action ? { title: action.title, ...action.arguments } : null;
  const actionCall: ToolCall | null = action && approval && actionArguments ? {
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
  } : null;

  const targetRunStatus = needsAction ? "WAITING_APPROVAL" : "WAITING_VERIFICATION";
  const finalizationTrace: InvestigationTraceEvent = {
    ...input.traceEvent,
    publicSummary: needsAction
      ? input.traceEvent.publicSummary
      : "Grounded Diagnosis 已形成，进入 WAITING_VERIFICATION 继续观察。",
    details: {
      ...input.traceEvent.details,
      disposition: validated.disposition,
      targetRunStatus,
    },
  };

  const events: AuditEvent[] = [
    input.acceptedAuditEvent,
    {
      id: createId("AE"),
      runId: input.runId,
      proposedActionId: action?.id ?? null,
      approvalId: approval?.id ?? null,
      toolCallId: actionCall?.id ?? null,
      type: "DIAGNOSIS_FINALIZED",
      actor: "ReleaseGuard Runtime",
      details: {
        diagnosisId: diagnosis.id,
        revision,
        disposition: diagnosis.disposition,
        groundingStatus: diagnosis.groundingStatus,
      },
      createdAt: now,
    },
    ...(action && approval && actionCall ? [{
      id: createId("AE"),
      runId: input.runId,
      proposedActionId: action.id,
      approvalId: null,
      toolCallId: actionCall.id,
      type: "PROPOSED_ACTION_CREATED" as const,
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
      type: "APPROVAL_REQUESTED" as const,
      actor: "ReleaseGuard Agent",
      details: { approvalStatus: approval.status },
      createdAt: now,
    }] : []),
    {
      id: createId("AE"),
      runId: input.runId,
      proposedActionId: action?.id ?? null,
      approvalId: approval?.id ?? null,
      toolCallId: actionCall?.id ?? null,
      type: "RUN_STATE_CHANGED",
      actor: "ReleaseGuard Runtime",
      details: {
        from: "RUNNING",
        to: targetRunStatus,
        disposition: validated.disposition,
      },
      createdAt: now,
    },
  ];
  await store.finalizeGroundedInvestigation({
    runId: input.runId,
    iterationId: input.iterationId,
    expectedLockVersion: beforeFinal.run.lockVersion,
    expectedDiagnosisRevision: beforeFinal.run.currentDiagnosisRevision,
    selectedHypothesis: {
      id: validated.selectedHypothesis.id,
      status: validated.selectedHypothesis.status,
      confidence: validated.selectedHypothesis.confidence,
      updatedAt: validated.selectedHypothesis.updatedAt,
    },
    diagnosis,
    claims,
    claimEvidenceLinks,
    proposedAction: action,
    approval,
    approvalSnapshot,
    actionToolCall: actionCall,
    auditEvents: events,
    traceEvent: finalizationTrace,
    targetRunStatus,
    totalTokens: input.totalTokens,
    publicRationale: input.publicRationale,
    completedAt: now,
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

export function toLegacyResponse(
  aggregate: InvestigationAggregate,
  options: {
    mode: "live" | "fixture";
    parseStatus: "direct" | "repaired" | "raw" | "fixture";
    rawConclusion?: string | null;
  },
): LegacyInvestigationResponse {
  const usage = summarizePlannerUsage(aggregate.auditEvents);
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
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      completeness: usage.completeness,
      model_call_count: usage.modelCallCount,
      usage_observed_call_count: usage.usageObservedCallCount,
    },
    investigation: aggregate,
  };
}
