import { RuntimeRequestError } from "./action-runtime";
import type { Phase4InvestigationStore } from "./phase4-store";
import type { MetricFilters } from "../analytics/types";
import type {
  ActionCompletion,
  AuditEvent,
  Diagnosis,
  InvestigationAggregate,
  InvestigationTraceEvent,
  VerificationPolicySnapshot,
  VerificationRun,
  VerificationEvaluation,
} from "./types";
import { evaluateVerification } from "./verification-evaluator";

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const CONFIRMED_BY = "Product Manager · Workspace Owner";
const ACTIVE_VERIFICATION_STATUSES = new Set(["PENDING", "WAITING_WINDOW", "RUNNING"]);
const MAX_VERIFICATION_ATTEMPTS = 3;
const MAX_VERIFICATION_WINDOW_MINUTES = 480;

const requiredText = (value: string, label: string, maxLength: number) => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new RuntimeRequestError("INVALID_COMMAND_INPUT", `${label}不能为空且不能超过 ${maxLength} 字。`, 400);
  }
  return normalized;
};

const normalizedInstant = (value: string) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RuntimeRequestError("INVALID_EFFECTIVE_AT", "effectiveAt 必须是合法时间。", 400);
  }
  return new Date(timestamp).toISOString();
};

const currentDiagnosis = (aggregate: InvestigationAggregate): Diagnosis => {
  const diagnosis = aggregate.diagnosis;
  if (
    !diagnosis
    || diagnosis.status !== "FINAL"
    || diagnosis.groundingStatus !== "GROUNDED"
    || diagnosis.revision !== aggregate.run.currentDiagnosisRevision
  ) {
    throw new RuntimeRequestError(
      "CURRENT_GROUNDED_DIAGNOSIS_REQUIRED",
      "当前 Run 没有可用于 Verification 的 Grounded Diagnosis。",
      409,
    );
  }
  return diagnosis;
};

const traceSequence = (aggregate: InvestigationAggregate) =>
  (aggregate.traceEvents.at(-1)?.sequence ?? 0) + 1;

type VerificationSourceContext = {
  sourceType: "OBSERVE" | "ACTION";
  diagnosis: Diagnosis;
  proposedActionId: string | null;
  approvalId: string | null;
  actionCompletion: ActionCompletion | null;
  anchorAt: string;
};

type CanonicalVerificationTarget = {
  metricKey: string;
  affectedFilters: MetricFilters;
  controlFilters: MetricFilters | null;
  baselineValue: number;
  incidentObservedValue: number;
  direction: "DOWN" | "UP";
  granularityMinutes: number;
};

const canonicalMetricFilters = (value: unknown): MetricFilters | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const orderedKeys = ["platform", "appVersion", "region", "userType"] as const;
  const allowed = new Set<string>(orderedKeys);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, item]) =>
    !allowed.has(key) || typeof item !== "string" || !item.trim())) return null;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(orderedKeys.flatMap((key) => {
    const item = record[key];
    return typeof item === "string" ? [[key, item.trim()]] : [];
  })) as MetricFilters;
};

const segmentDimensionFilterKey: Record<string, keyof MetricFilters> = {
  platform: "platform",
  app_version: "appVersion",
  region: "region",
  user_type: "userType",
};

const claimToolCalls = (
  aggregate: InvestigationAggregate,
  diagnosis: Diagnosis,
  claimType: "AFFECTED_METRIC" | "AFFECTED_SEGMENT",
) => {
  const claimIds = new Set(aggregate.diagnosisClaims
    .filter((claim) =>
      claim.diagnosisId === diagnosis.id
      && claim.type === claimType
      && claim.groundingStatus === "GROUNDED")
    .map((claim) => claim.id));
  const evidenceIds = new Set(aggregate.diagnosisClaimEvidenceLinks
    .filter((link) => link.diagnosisId === diagnosis.id && claimIds.has(link.claimId))
    .map((link) => link.evidenceId));
  const resultIds = new Set(aggregate.evidence
    .filter((item) => item.runId === aggregate.run.id && evidenceIds.has(item.id))
    .map((item) => item.toolResultId));
  return aggregate.toolCalls.filter((call) =>
    call.runId === aggregate.run.id
    && call.resultId !== null
    && resultIds.has(call.resultId)
    && (call.name === "query_metric" || call.name === "segment_metric"));
};

const resolveCanonicalTarget = (
  aggregate: InvestigationAggregate,
  diagnosis: Diagnosis,
): CanonicalVerificationTarget => {
  const metricCalls = claimToolCalls(aggregate, diagnosis, "AFFECTED_METRIC");
  const structuredMetricKeys = new Set(metricCalls.flatMap((call) => {
    const value = call.arguments.metric_key;
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  }));
  const riskMetricKey = aggregate.riskEvent?.metricKey.trim() || null;
  if (
    riskMetricKey
    && structuredMetricKeys.size > 0
    && (structuredMetricKeys.size !== 1 || !structuredMetricKeys.has(riskMetricKey))
  ) {
    throw new RuntimeRequestError(
      "VERIFICATION_TARGET_UNRESOLVED",
      "RiskEvent metricKey 与 Grounded AFFECTED_METRIC Evidence 不一致。",
      409,
    );
  }
  const metricKey = riskMetricKey
    ?? (structuredMetricKeys.size === 1 ? [...structuredMetricKeys][0] : null);
  if (!metricKey) {
    throw new RuntimeRequestError(
      "VERIFICATION_TARGET_UNRESOLVED",
      "无法从 RiskEvent 或 Grounded AFFECTED_METRIC Evidence 解析 canonical metricKey。",
      409,
    );
  }

  const segmentCalls = claimToolCalls(aggregate, diagnosis, "AFFECTED_SEGMENT");
  const hasSegmentClaim = aggregate.diagnosisClaims.some((claim) =>
    claim.diagnosisId === diagnosis.id
    && claim.type === "AFFECTED_SEGMENT"
    && claim.groundingStatus === "GROUNDED");
  const segmentMetricKeys = new Set(segmentCalls.flatMap((call) => {
    const value = call.arguments.metric_key;
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  }));
  if (segmentMetricKeys.size > 0
    && (segmentMetricKeys.size !== 1 || !segmentMetricKeys.has(metricKey))) {
    throw new RuntimeRequestError(
      "VERIFICATION_TARGET_UNRESOLVED",
      "Grounded AFFECTED_SEGMENT Evidence 与 canonical metricKey 不一致。",
      409,
    );
  }
  let affectedFilters: MetricFilters;
  if (aggregate.riskEvent) {
    const filters = canonicalMetricFilters(aggregate.riskEvent.filters);
    if (!filters || (hasSegmentClaim && Object.keys(filters).length === 0)) {
      throw new RuntimeRequestError(
        "VERIFICATION_TARGET_UNRESOLVED",
        "当前 Grounded segment 没有对应的 canonical RiskEvent filters。",
        409,
      );
    }
    const unresolvedDimensions = new Set(segmentCalls.flatMap((call) => {
      const dimension = call.arguments.dimension;
      const filterKey = typeof dimension === "string"
        ? segmentDimensionFilterKey[dimension]
        : undefined;
      return !filterKey || !filters[filterKey] ? [String(dimension)] : [];
    }));
    if (unresolvedDimensions.size > 0) {
      throw new RuntimeRequestError(
        "VERIFICATION_TARGET_UNRESOLVED",
        `Grounded AFFECTED_SEGMENT Evidence 缺少对应的 canonical RiskEvent filters：${[
          ...unresolvedDimensions,
        ].join(", ")}。`,
        409,
      );
    }
    affectedFilters = filters;
  } else if (hasSegmentClaim) {
    // Current SEGMENT_METRIC evidence does not persist the selected breakdown value as metadata.
    // Its free-text statement must not be reverse-parsed into an executable filter.
    throw new RuntimeRequestError(
      "VERIFICATION_TARGET_UNRESOLVED",
      "缺少 RiskEvent structured filters，不能从自然语言 segment claim 推断查询条件。",
      409,
    );
  } else {
    const callFilters = metricCalls
      .map((call) => canonicalMetricFilters(call.arguments.filters ?? {}));
    if (callFilters.some((filters) => filters === null)) {
      throw new RuntimeRequestError(
        "VERIFICATION_TARGET_UNRESOLVED",
        "Grounded metric Evidence 包含非 canonical filters。",
        409,
      );
    }
    const canonicalCallFilters = callFilters as MetricFilters[];
    const uniqueFilters = new Map(canonicalCallFilters.map((filters) =>
      [JSON.stringify(filters), filters]));
    if (uniqueFilters.size > 1) {
      throw new RuntimeRequestError(
        "VERIFICATION_TARGET_UNRESOLVED",
        "Grounded metric Evidence 指向多个不同 filters，无法确定唯一验证目标。",
        409,
      );
    }
    affectedFilters = uniqueFilters.values().next().value ?? {};
  }

  const reference = aggregate.riskEvent;
  if (!reference || reference.metricKey !== metricKey) {
    throw new RuntimeRequestError(
      "VERIFICATION_REFERENCE_UNRESOLVED",
      "当前 snapshot 缺少由 RiskEvent 冻结的 baseline/reference，不能创建可执行 Verification attempt。",
      409,
    );
  }
  const granularities = new Set(metricCalls.flatMap((call) => {
    const value = call.arguments.granularity_minutes;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? [value] : [];
  }));
  const granularityMinutes = granularities.size === 1 ? [...granularities][0] : 5;
  return {
    metricKey,
    affectedFilters,
    controlFilters: null,
    baselineValue: reference.baselineValue,
    incidentObservedValue: reference.observedValue,
    direction: reference.direction,
    granularityMinutes,
  };
};

const resolveVerificationSource = (
  aggregate: InvestigationAggregate,
): VerificationSourceContext => {
  const diagnosis = currentDiagnosis(aggregate);
  if (diagnosis.disposition === "OBSERVE") {
    return {
      sourceType: "OBSERVE",
      diagnosis,
      proposedActionId: null,
      approvalId: null,
      actionCompletion: null,
      anchorAt: diagnosis.createdAt,
    };
  }

  const actions = aggregate.proposedActions.filter((item) =>
    item.diagnosisId === diagnosis.id
    && item.revision === diagnosis.revision
    && item.status === "SUCCEEDED");
  const action = actions.length === 1 ? actions[0] : null;
  const approvals = action ? aggregate.approvals.filter((item) =>
    item.proposedActionId === action.id
    && item.revision === diagnosis.revision
    && item.status === "APPROVED"
    && item.decision === "APPROVE") : [];
  const approval = approvals.length === 1 ? approvals[0] : null;
  const completions = action && approval ? aggregate.actionCompletions.filter((item) =>
    item.diagnosisId === diagnosis.id
    && item.proposedActionId === action.id
    && item.approvalId === approval.id
    && item.revision === diagnosis.revision) : [];
  const completion = completions.length === 1 ? completions[0] : null;
  if (!action || !approval || !completion) {
    throw new RuntimeRequestError(
      "LEGACY_ACTION_AWAITING_EFFECTIVE_TIME",
      "该 Action Run 缺少当前 revision 的明确生效时间，不能创建 VerificationRun。",
      409,
    );
  }
  return {
    sourceType: "ACTION",
    diagnosis,
    proposedActionId: action.id,
    approvalId: approval.id,
    actionCompletion: completion,
    anchorAt: completion.effectiveAt,
  };
};

export async function confirmActionCompletion(
  store: Phase4InvestigationStore,
  input: {
    runId: string;
    clientRequestId: string;
    effectiveAt: string;
    changeReference: string;
    note?: string | null;
  },
) {
  const runId = requiredText(input.runId, "runId", 200);
  const clientRequestId = requiredText(input.clientRequestId, "clientRequestId", 200);
  const changeReference = requiredText(input.changeReference, "changeReference", 500);
  const note = input.note?.trim().slice(0, 2_000) || null;
  const effectiveAt = normalizedInstant(input.effectiveAt);
  let aggregate = await store.getAggregate(runId);
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);

  const replay = aggregate.actionCompletions.find((item) =>
    item.clientRequestId === clientRequestId);
  if (replay) return replay;
  if (aggregate.run.status !== "WAITING_ACTION_COMPLETION") {
    throw new RuntimeRequestError(
      "RUN_NOT_WAITING_ACTION_COMPLETION",
      `Run 当前为 ${aggregate.run.status}，不能确认 Action 已生效。`,
      409,
    );
  }

  const diagnosis = currentDiagnosis(aggregate);
  const action = aggregate.proposedAction;
  const approval = aggregate.approval;
  if (
    !action
    || !approval
    || action.status !== "SUCCEEDED"
    || approval.status !== "APPROVED"
    || approval.decision !== "APPROVE"
    || action.diagnosisId !== diagnosis.id
    || approval.proposedActionId !== action.id
    || action.revision !== diagnosis.revision
    || approval.revision !== diagnosis.revision
  ) {
    throw new RuntimeRequestError(
      "ACTION_COMPLETION_CONTEXT_INVALID",
      "当前 Diagnosis、Action 或 Approval 不是可确认生效的 active revision。",
      409,
    );
  }
  const call = aggregate.toolCalls.find((item) =>
    item.proposedActionId === action.id && item.approvalId === approval.id);
  if (!call || call.status !== "SUCCESS" || call.result?.status !== "SUCCESS" || !call.completedAt) {
    throw new RuntimeRequestError(
      "SUCCESSFUL_ACTION_REQUIRED",
      "只有成功完成的 Action ToolCall 才能确认变更生效。",
      409,
    );
  }
  if (Date.parse(effectiveAt) < Date.parse(call.completedAt)) {
    throw new RuntimeRequestError(
      "EFFECTIVE_AT_BEFORE_ACTION",
      "effectiveAt 不能早于 Action 执行完成时间。",
      400,
    );
  }

  const now = new Date().toISOString();
  const completion: ActionCompletion = {
    id: createId("AC"),
    runId,
    proposedActionId: action.id,
    approvalId: approval.id,
    diagnosisId: diagnosis.id,
    revision: diagnosis.revision,
    clientRequestId,
    effectiveAt,
    changeReference,
    note,
    confirmedBy: CONFIRMED_BY,
    createdAt: now,
  };
  const auditEvents: AuditEvent[] = [{
    id: createId("AE"),
    runId,
    proposedActionId: action.id,
    approvalId: approval.id,
    toolCallId: call.id,
    type: "ACTION_COMPLETION_CONFIRMED",
    actor: CONFIRMED_BY,
    details: { actionCompletionId: completion.id, effectiveAt, changeReference },
    createdAt: now,
  }, {
    id: createId("AE"),
    runId,
    proposedActionId: action.id,
    approvalId: approval.id,
    toolCallId: call.id,
    type: "RUN_STATE_CHANGED",
    actor: "ReleaseGuard Action Completion Runtime",
    details: {
      from: "WAITING_ACTION_COMPLETION",
      to: "WAITING_VERIFICATION",
      actionCompletionId: completion.id,
    },
    createdAt: now,
  }];
  const traceEvent: InvestigationTraceEvent = {
    id: createId("ITE"),
    runId,
    iterationId: null,
    sequence: traceSequence(aggregate),
    type: "ACTION_COMPLETION_CONFIRMED",
    actor: "HUMAN",
    publicSummary: `外部变更已确认生效，进入 WAITING_VERIFICATION：${changeReference}`,
    details: { actionCompletionId: completion.id, effectiveAt, changeReference },
    createdAt: now,
  };
  const committed = await store.commitActionCompletion({
    completion,
    expectedLockVersion: aggregate.run.lockVersion,
    expectedActionCompletedAt: call.completedAt,
    auditEvents,
    traceEvent,
  });
  if (committed) return completion;

  aggregate = await store.getAggregate(runId);
  const concurrentReplay = aggregate?.actionCompletions.find((item) =>
    item.clientRequestId === clientRequestId);
  if (concurrentReplay) return concurrentReplay;
  throw new RuntimeRequestError(
    "ACTION_COMPLETION_RACE",
    "Action 已被其他请求确认生效。",
    409,
  );
}

function buildVerificationPolicy(
  aggregate: InvestigationAggregate,
  source: VerificationSourceContext,
  target: CanonicalVerificationTarget,
  verificationRunId: string,
  createdAt: string,
): VerificationPolicySnapshot {
  const riskEvent = aggregate.riskEvent;
  return {
    id: createId("VPS"),
    verificationRunId,
    runId: aggregate.run.id,
    policyVersion: "P4.3B_V1",
    anchorAt: source.anchorAt,
    settlingPeriodMinutes: 30,
    verificationWindowMinutes: 120,
    metricKey: target.metricKey,
    baselineValue: target.baselineValue,
    incidentObservedValue: target.incidentObservedValue,
    direction: target.direction,
    granularityMinutes: target.granularityMinutes,
    affectedFilters: structuredClone(target.affectedFilters),
    controlFilters: target.controlFilters === null
      ? null
      : structuredClone(target.controlFilters),
    controlBaselineValue: null,
    minimumSampleSize: riskEvent?.minSampleSize ?? 100,
    requiredConsecutiveBuckets: riskEvent?.requiredConsecutiveBuckets ?? 3,
    metricRecoveryThreshold: 0.9,
    minimumImprovementThreshold: 0.05,
    feedbackTrendThreshold: 0,
    feedbackRequired: false,
    feedbackMinimumSampleSize: 5,
    createdAt,
  };
}

export async function createVerificationAttempt(
  store: Phase4InvestigationStore,
  input: { runId: string; clientRequestId: string },
  clock: () => Date = () => new Date(),
) {
  const runId = requiredText(input.runId, "runId", 200);
  const clientRequestId = requiredText(input.clientRequestId, "clientRequestId", 200);
  let aggregate = await store.getAggregate(runId);
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);

  const replay = aggregate.verificationRuns.find((item) =>
    item.clientRequestId === clientRequestId);
  if (replay) {
    const policy = aggregate.verificationPolicySnapshots.find((item) =>
      item.verificationRunId === replay.id);
    if (!policy) throw new RuntimeRequestError("VERIFICATION_POLICY_MISSING", "Verification Policy 缺失。", 500);
    return { verificationRun: replay, policySnapshot: policy };
  }
  if (aggregate.run.status !== "WAITING_VERIFICATION") {
    throw new RuntimeRequestError(
      "RUN_NOT_WAITING_VERIFICATION",
      `Run 当前为 ${aggregate.run.status}，不能创建 VerificationRun。`,
      409,
    );
  }
  if (aggregate.verificationRuns.some((item) => ACTIVE_VERIFICATION_STATUSES.has(item.status))) {
    throw new RuntimeRequestError(
      "ACTIVE_VERIFICATION_EXISTS",
      "当前 Run 已存在 active Verification attempt。",
      409,
    );
  }

  if (
    aggregate.diagnosis?.disposition !== "OBSERVE"
    && aggregate.proposedAction
    && aggregate.actionCompletions.length === 0
  ) {
    throw new RuntimeRequestError(
      "LEGACY_ACTION_AWAITING_EFFECTIVE_TIME",
      "该 Action Run 缺少明确的生效时间，不能创建 VerificationRun。",
      409,
    );
  }

  const source = resolveVerificationSource(aggregate);
  const target = resolveCanonicalTarget(aggregate, source.diagnosis);

  const now = clock();
  const createdAt = now.toISOString();
  const attempt = (aggregate.verificationRuns.at(-1)?.attempt ?? 0) + 1;
  const verificationRun: VerificationRun = {
    id: createId("VR"),
    runId,
    diagnosisId: source.diagnosis.id,
    actionCompletionId: source.actionCompletion?.id ?? null,
    attempt,
    clientRequestId,
    status: now.getTime() < Date.parse(source.anchorAt) + 30 * 60_000
      ? "WAITING_WINDOW"
      : "PENDING",
    anchorType: source.sourceType === "ACTION" ? "ACTION_COMPLETION" : "OBSERVE_DIAGNOSIS",
    anchorAt: source.anchorAt,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  const policySnapshot = buildVerificationPolicy(
    aggregate,
    source,
    target,
    verificationRun.id,
    createdAt,
  );
  const auditEvent: AuditEvent = {
    id: createId("AE"),
    runId,
    proposedActionId: source.proposedActionId,
    approvalId: source.approvalId,
    toolCallId: null,
    type: "VERIFICATION_ATTEMPT_CREATED",
    actor: "ReleaseGuard Verification Runtime",
    details: {
      verificationRunId: verificationRun.id,
      attempt,
      sourceType: source.sourceType,
      diagnosisId: source.diagnosis.id,
      diagnosisRevision: source.diagnosis.revision,
      actionCompletionId: source.actionCompletion?.id ?? null,
      anchorType: verificationRun.anchorType,
      anchorAt: source.anchorAt,
      status: verificationRun.status,
      policyVersion: policySnapshot.policyVersion,
    },
    createdAt,
  };
  const traceEvent: InvestigationTraceEvent = {
    id: createId("ITE"),
    runId,
    iterationId: null,
    sequence: traceSequence(aggregate),
    type: "VERIFICATION_ATTEMPT_CREATED",
    actor: "RUNTIME",
    publicSummary: source.sourceType === "ACTION"
      ? "已基于当前 ActionCompletion 创建 Verification attempt。"
      : "已基于当前 OBSERVE Diagnosis 创建 Verification attempt。",
    details: {
      verificationRunId: verificationRun.id,
      sourceType: source.sourceType,
      diagnosisId: source.diagnosis.id,
      diagnosisRevision: source.diagnosis.revision,
      proposedActionId: source.proposedActionId,
      approvalId: source.approvalId,
      actionCompletionId: source.actionCompletion?.id ?? null,
      anchorAt: source.anchorAt,
      metricKey: target.metricKey,
      affectedFilters: target.affectedFilters,
    },
    createdAt,
  };
  const committed = await store.commitVerificationAttempt({
    verificationRun,
    policySnapshot,
    expectedLockVersion: aggregate.run.lockVersion,
    expectedDiagnosisRevision: aggregate.run.currentDiagnosisRevision,
    auditEvent,
    traceEvent,
  });
  if (committed) return { verificationRun, policySnapshot };

  aggregate = await store.getAggregate(runId);
  const concurrentReplay = aggregate?.verificationRuns.find((item) =>
    item.clientRequestId === clientRequestId);
  const concurrentPolicy = concurrentReplay && aggregate?.verificationPolicySnapshots.find((item) =>
    item.verificationRunId === concurrentReplay.id);
  if (concurrentReplay && concurrentPolicy) {
    return { verificationRun: concurrentReplay, policySnapshot: concurrentPolicy };
  }
  throw new RuntimeRequestError(
    "VERIFICATION_ATTEMPT_RACE",
    "另一个 Verification attempt 已经创建。",
    409,
  );
}

export async function listVerificationHistory(
  store: Phase4InvestigationStore,
  runId: string,
) {
  const aggregate = await store.getAggregate(requiredText(runId, "runId", 200));
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);
  return aggregate.verificationRuns.map((verificationRun) => ({
    verificationRun,
    policySnapshot: aggregate.verificationPolicySnapshots.find((item) =>
      item.verificationRunId === verificationRun.id) ?? null,
    evidence: aggregate.verificationEvidence.filter((item) =>
      item.verificationRunId === verificationRun.id),
    evaluation: aggregate.verificationEvaluations.find((item) =>
      item.verificationRunId === verificationRun.id) ?? null,
  }));
}

export async function evaluateVerificationAttempt(
  store: Phase4InvestigationStore,
  input: { runId: string; verificationRunId: string; clientRequestId: string },
  clock: () => Date = () => new Date(),
) {
  const runId = requiredText(input.runId, "runId", 200);
  const verificationRunId = requiredText(input.verificationRunId, "verificationRunId", 200);
  const clientRequestId = requiredText(input.clientRequestId, "clientRequestId", 200);
  let aggregate = await store.getAggregate(runId);
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);
  let verification = aggregate.verificationRuns.find((item) => item.id === verificationRunId);
  if (!verification) throw new RuntimeRequestError("VERIFICATION_NOT_FOUND", "VerificationRun 不存在。", 404);
  const existing = aggregate.verificationEvaluations.find((item) => item.verificationRunId === verificationRunId);
  if (existing) return {
    verificationRun: verification,
    evaluation: existing,
    evidence: aggregate.verificationEvidence.filter((item) => item.verificationRunId === verificationRunId),
  };
  const policy = aggregate.verificationPolicySnapshots.find((item) => item.verificationRunId === verificationRunId);
  if (!policy) throw new RuntimeRequestError("VERIFICATION_POLICY_MISSING", "Verification Policy 缺失。", 500);
  const now = clock();
  const verificationStart = new Date(Date.parse(policy.anchorAt) + policy.settlingPeriodMinutes * 60_000);
  const verificationEnd = new Date(verificationStart.getTime() + policy.verificationWindowMinutes * 60_000);
  if (now.getTime() < verificationEnd.getTime()) {
    await store.markVerificationWaitingWindow({
      runId, verificationRunId, expectedLockVersion: aggregate.run.lockVersion, updatedAt: now.toISOString(),
    });
    aggregate = await store.getAggregate(runId);
    return {
      verificationRun: aggregate!.verificationRuns.find((item) => item.id === verificationRunId)!,
      evaluation: null,
      evidence: [],
    };
  }
  if (verification.status !== "RUNNING") {
    const begun = await store.beginVerificationEvaluation({
      runId, verificationRunId, clientRequestId,
      expectedLockVersion: aggregate.run.lockVersion, startedAt: now.toISOString(),
    });
    if (!begun) {
      aggregate = await store.getAggregate(runId);
      const replay = aggregate?.verificationEvaluations.find((item) => item.verificationRunId === verificationRunId);
      if (replay) return {
        verificationRun: aggregate!.verificationRuns.find((item) => item.id === verificationRunId)!,
        evaluation: replay,
        evidence: aggregate!.verificationEvidence.filter((item) => item.verificationRunId === verificationRunId),
      };
      throw new RuntimeRequestError("VERIFICATION_EVALUATION_RACE", "Verification evaluation 已由其他请求启动。", 409);
    }
    aggregate = (await store.getAggregate(runId))!;
    verification = aggregate.verificationRuns.find((item) => item.id === verificationRunId)!;
  } else if (aggregate.run.activeIterationId
    !== `VERIFICATION_EVALUATION:${verificationRunId}:${clientRequestId}`) {
    throw new RuntimeRequestError("VERIFICATION_EVALUATION_IN_PROGRESS", "其他 evaluation 请求正在执行。", 409);
  }

  const queryMetric = (filters: MetricFilters) => store.queryVerificationMetricBuckets({
    metricKey: policy.metricKey, filters,
    startTime: verificationStart.toISOString(), endTime: verificationEnd.toISOString(),
  });
  type SignalQuery = {
    kind: "AFFECTED_METRIC" | "CONTROL_METRIC" | "FEEDBACK_REFERENCE" | "FEEDBACK_VERIFICATION";
    promise: Promise<unknown[]>;
  };
  const signalQueries: SignalQuery[] = [{
    kind: "AFFECTED_METRIC", promise: queryMetric(policy.affectedFilters),
  }];
  if (policy.controlFilters) {
    signalQueries.push({ kind: "CONTROL_METRIC", promise: queryMetric(policy.controlFilters) });
  }
  if (policy.feedbackRequired) {
    signalQueries.push({
      kind: "FEEDBACK_REFERENCE",
      promise: store.queryVerificationFeedback({
        filters: policy.affectedFilters,
        startTime: new Date(Date.parse(policy.anchorAt)
          - policy.verificationWindowMinutes * 60_000).toISOString(),
        endTime: policy.anchorAt,
      }),
    }, {
      kind: "FEEDBACK_VERIFICATION",
      promise: store.queryVerificationFeedback({
        filters: policy.affectedFilters,
        startTime: verificationStart.toISOString(), endTime: verificationEnd.toISOString(),
      }),
    });
  }
  const signalResults = await Promise.all(signalQueries.map(async (signal) => {
    try {
      return { kind: signal.kind, ok: true as const, value: await signal.promise };
    } catch (error) {
      return { kind: signal.kind, ok: false as const,
        error: error instanceof Error ? error.message : "DATA_READ_FAILED" };
    }
  }));
  const successful = new Map(signalResults.flatMap((item) => item.ok
    ? [[item.kind, item.value] as const] : []));
  const signalErrors = Object.fromEntries(signalResults.flatMap((item) => item.ok
    ? [] : [[item.kind, item.error]]));
  const computed = evaluateVerification({
    runId, verificationRunId, policy,
    affectedBuckets: (successful.get("AFFECTED_METRIC") ?? []) as import("../analytics/types").MetricBucket[],
    controlBuckets: (successful.get("CONTROL_METRIC") ?? []) as import("../analytics/types").MetricBucket[],
    feedbackReference: (successful.get("FEEDBACK_REFERENCE") ?? []) as import("./verification-evaluator").VerificationFeedbackRecord[],
    feedbackObserved: (successful.get("FEEDBACK_VERIFICATION") ?? []) as import("./verification-evaluator").VerificationFeedbackRecord[],
    signalErrors, createdAt: now.toISOString(),
  });
  const evaluation: VerificationEvaluation = {
    id: createId("VEV"), runId, verificationRunId, clientRequestId,
    outcome: computed.outcome, reasonCode: computed.reasonCode, result: computed.result,
    createdAt: now.toISOString(),
  };
  const auditEvents: AuditEvent[] = [{
    id: createId("AE"), runId, proposedActionId: null, approvalId: null, toolCallId: null,
    type: "VERIFICATION_EVALUATED", actor: "ReleaseGuard Verification Runtime",
    details: { verificationRunId, outcome: evaluation.outcome, reasonCode: evaluation.reasonCode },
    createdAt: evaluation.createdAt,
  }, {
    id: createId("AE"), runId, proposedActionId: null, approvalId: null, toolCallId: null,
    type: "RUN_STATE_CHANGED", actor: "ReleaseGuard Verification Runtime",
    details: { from: "VERIFYING", to: evaluation.outcome === "INCONCLUSIVE"
      ? "VERIFICATION_INCONCLUSIVE" : evaluation.outcome }, createdAt: evaluation.createdAt,
  }];
  const traceEvent: InvestigationTraceEvent = {
    id: createId("ITE"), runId, iterationId: null, sequence: traceSequence(aggregate),
    type: "VERIFICATION_EVALUATED", actor: "RUNTIME",
    publicSummary: `Deterministic verification 完成：${evaluation.outcome}。`,
    details: { verificationRunId, outcome: evaluation.outcome, reasonCode: evaluation.reasonCode },
    createdAt: evaluation.createdAt,
  };
  const committed = await store.commitVerificationEvaluation({
    evaluation, evidence: computed.evidence, auditEvents, traceEvent,
    expectedLockVersion: aggregate.run.lockVersion,
    expectedVerificationAttempt: verification.attempt,
  });
  if (!committed) throw new RuntimeRequestError("VERIFICATION_EVALUATION_COMMIT_RACE", "Evaluation 提交冲突。", 409);
  aggregate = (await store.getAggregate(runId))!;
  return {
    verificationRun: aggregate.verificationRuns.find((item) => item.id === verificationRunId)!,
    evaluation: aggregate.verificationEvaluations.find((item) => item.verificationRunId === verificationRunId)!,
    evidence: aggregate.verificationEvidence.filter((item) => item.verificationRunId === verificationRunId),
  };
}

export async function reopenAfterVerification(
  store: Phase4InvestigationStore,
  input: { runId: string; verificationRunId: string; clientRequestId: string; reason?: string | null },
) {
  const aggregate = await store.getAggregate(requiredText(input.runId, "runId", 200));
  const clientRequestId = requiredText(input.clientRequestId, "clientRequestId", 200);
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);
  const verification = aggregate.verificationRuns.find((item) => item.id === input.verificationRunId);
  const replay = aggregate.traceEvents.find((item) => item.type === "VERIFICATION_REOPENED"
    && item.details.clientRequestId === clientRequestId);
  if (replay) {
    if (replay.details.verificationRunId === input.verificationRunId) return aggregate;
    throw new RuntimeRequestError(
      "VERIFICATION_REOPEN_IDEMPOTENCY_CONFLICT",
      "clientRequestId is already bound to another verification attempt.",
      409,
    );
  }
  if (!verification) throw new RuntimeRequestError("VERIFICATION_NOT_FOUND", "VerificationRun 不存在。", 404);
  if (verification.status === "RESOLVED") {
    throw new RuntimeRequestError("RESOLVED_VERIFICATION_CANNOT_REOPEN", "RESOLVED verification 不允许 reopen。", 409);
  }
  if (!["PARTIALLY_RESOLVED", "NOT_RECOVERED", "INCONCLUSIVE"].includes(verification.status)) {
    throw new RuntimeRequestError("VERIFICATION_NOT_REOPENABLE", "当前 VerificationRun 不允许 reopen。", 409);
  }
  const expectedRunStatus = verification.status === "INCONCLUSIVE"
    ? "VERIFICATION_INCONCLUSIVE" : verification.status;
  const latestAttempt = Math.max(...aggregate.verificationRuns.map((item) => item.attempt));
  if (verification.attempt !== latestAttempt || aggregate.run.status !== expectedRunStatus) {
    throw new RuntimeRequestError(
      "VERIFICATION_REOPEN_CONTEXT_STALE",
      "Only the latest completed verification attempt matching the current Run outcome can reopen investigation.",
      409,
    );
  }
  const now = new Date().toISOString();
  const reason = input.reason?.trim().slice(0, 2_000) || "Verification 结果需要继续调查";
  const auditEvent: AuditEvent = {
    id: createId("AE"), runId: input.runId, proposedActionId: null, approvalId: null, toolCallId: null,
    type: "VERIFICATION_REOPENED", actor: CONFIRMED_BY,
    details: { verificationRunId: verification.id, outcome: verification.status, reason }, createdAt: now,
  };
  const traceEvent: InvestigationTraceEvent = {
    id: createId("ITE"), runId: input.runId, iterationId: null,
    sequence: traceSequence(aggregate), type: "VERIFICATION_REOPENED", actor: "HUMAN",
    publicSummary: reason, details: {
      verificationRunId: verification.id, outcome: verification.status, clientRequestId,
    }, createdAt: now,
  };
  const committed = await store.commitVerificationReopen({
    runId: input.runId, verificationRunId: verification.id,
    clientRequestId,
    auditEvent, traceEvent, expectedLockVersion: aggregate.run.lockVersion, createdAt: now,
  });
  if (!committed) throw new RuntimeRequestError("VERIFICATION_REOPEN_RACE", "Reopen 请求发生并发冲突。", 409);
  return store.getAggregate(input.runId);
}

export async function retryVerificationAttempt(
  store: Phase4InvestigationStore,
  input: { runId: string; verificationRunId: string; clientRequestId: string },
  clock: () => Date = () => new Date(),
) {
  let aggregate = await store.getAggregate(requiredText(input.runId, "runId", 200));
  if (!aggregate) throw new RuntimeRequestError("RUN_NOT_FOUND", "InvestigationRun 不存在。", 404);
  const clientRequestId = requiredText(input.clientRequestId, "clientRequestId", 200);
  const replay = aggregate.verificationRuns.find((item) => item.clientRequestId === clientRequestId);
  if (replay) return {
    verificationRun: replay,
    policySnapshot: aggregate.verificationPolicySnapshots.find((item) => item.verificationRunId === replay.id)!,
  };
  const previous = aggregate.verificationRuns.find((item) => item.id === input.verificationRunId);
  if (!previous || !["PARTIALLY_RESOLVED", "NOT_RECOVERED", "INCONCLUSIVE"].includes(previous.status)) {
    throw new RuntimeRequestError("VERIFICATION_NOT_RETRYABLE", "当前 VerificationRun 不允许 retry。", 409);
  }
  const latestAttempt = Math.max(...aggregate.verificationRuns.map((item) => item.attempt));
  if (previous.attempt !== latestAttempt) {
    throw new RuntimeRequestError(
      "VERIFICATION_RETRY_CONTEXT_STALE",
      "Only the latest verification attempt can be retried.",
      409,
    );
  }
  const expectedRunStatus = previous.status === "INCONCLUSIVE"
    ? "VERIFICATION_INCONCLUSIVE" : previous.status;
  if (aggregate.run.status !== expectedRunStatus) {
    throw new RuntimeRequestError(
      "VERIFICATION_RETRY_CONTEXT_STALE",
      "Verification outcome no longer matches the current InvestigationRun state.",
      409,
    );
  }
  if (latestAttempt >= MAX_VERIFICATION_ATTEMPTS) {
    throw new RuntimeRequestError(
      "VERIFICATION_ATTEMPT_LIMIT_REACHED",
      "Verification retry attempt limit reached.",
      409,
    );
  }
  const previousPolicy = aggregate.verificationPolicySnapshots.find((item) => item.verificationRunId === previous.id);
  if (!previousPolicy) throw new RuntimeRequestError("VERIFICATION_POLICY_MISSING", "Verification Policy 缺失。", 500);
  const now = clock();
  const createdAt = now.toISOString();
  const nextWindow = previousPolicy.verificationWindowMinutes * 2;
  if (nextWindow > MAX_VERIFICATION_WINDOW_MINUTES) {
    throw new RuntimeRequestError(
      "VERIFICATION_WINDOW_LIMIT_REACHED",
      "Verification retry window limit reached.",
      409,
    );
  }
  const verificationRun: VerificationRun = {
    ...previous,
    id: createId("VR"), attempt: Math.max(...aggregate.verificationRuns.map((item) => item.attempt)) + 1,
    clientRequestId, status: "WAITING_WINDOW", createdAt, updatedAt: createdAt, completedAt: null,
  };
  const policySnapshot: VerificationPolicySnapshot = {
    ...structuredClone(previousPolicy), id: createId("VPS"), verificationRunId: verificationRun.id,
    verificationWindowMinutes: nextWindow,
    policyVersion: "P4.3B_RETRY_V1", createdAt,
  };
  const end = Date.parse(policySnapshot.anchorAt)
    + (policySnapshot.settlingPeriodMinutes + policySnapshot.verificationWindowMinutes) * 60_000;
  verificationRun.status = now.getTime() < end ? "WAITING_WINDOW" : "PENDING";
  const auditEvent: AuditEvent = {
    id: createId("AE"), runId: input.runId, proposedActionId: null, approvalId: null, toolCallId: null,
    type: "VERIFICATION_RETRY_CREATED", actor: CONFIRMED_BY,
    details: { previousVerificationRunId: previous.id, verificationRunId: verificationRun.id,
      attempt: verificationRun.attempt, verificationWindowMinutes: policySnapshot.verificationWindowMinutes },
    createdAt,
  };
  const traceEvent: InvestigationTraceEvent = {
    id: createId("ITE"), runId: input.runId, iterationId: null, sequence: traceSequence(aggregate),
    type: "VERIFICATION_RETRY_CREATED", actor: "HUMAN",
    publicSummary: "已显式创建新的 Verification retry attempt。",
    details: auditEvent.details, createdAt,
  };
  const committed = await store.commitVerificationRetry({
    verificationRun, policySnapshot, previousVerificationRunId: previous.id, clientRequestId,
    expectedLockVersion: aggregate.run.lockVersion,
    expectedDiagnosisRevision: aggregate.run.currentDiagnosisRevision, auditEvent, traceEvent,
  });
  if (!committed) {
    aggregate = await store.getAggregate(input.runId);
    const concurrent = aggregate?.verificationRuns.find((item) => item.clientRequestId === clientRequestId);
    if (concurrent) return { verificationRun: concurrent, policySnapshot: aggregate!.verificationPolicySnapshots.find((item) => item.verificationRunId === concurrent.id)! };
    throw new RuntimeRequestError("VERIFICATION_RETRY_RACE", "Verification retry 发生并发冲突。", 409);
  }
  return { verificationRun, policySnapshot };
}
