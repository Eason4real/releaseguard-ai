import { createHash } from "node:crypto";
import { canonicalJson } from "../../../lib/retrieval/public-incidents/normalize";
import type { InvestigationAggregate } from "../../../lib/investigation/types";
import type { LiveEvalObservability } from "../../support/live-eval-store";
import type {
  HarnessAgentRequest,
  HarnessExecutionTelemetry,
  HarnessTelemetryValue,
} from "./types";

export const HARNESS_TELEMETRY_SCHEMA_VERSION = "benchmark-observability-v1" as const;

const EVALUATION_ONLY_KEYS = new Set([
  "groundtruth", "canonicalrootcause", "canonicalrootcauseid", "acceptablealiases",
  "requiredevidenceids", "supportingevidenceids", "distractorevidenceids",
  "rootcauseevaluation", "requiredconceptgroups", "optionalconcepts", "forbiddenconcepts",
  "uncertaintypolicy", "specificitypolicy", "semanticrubric", "evaluationcontract",
]);
const SENSITIVE_KEY = /(?:api.?key|authorization|bearer|credential|password|secret|token|cookie)/i;
const normalizedKey = (key: string) => key.replace(/[_-]/g, "").toLowerCase();
const allowedMetadataKey = (key: string) =>
  !SENSITIVE_KEY.test(key) && !EVALUATION_ONLY_KEYS.has(normalizedKey(key));

const sanitizeText = (value: string, sensitiveValues: readonly string[]) => {
  let sanitized = value;
  for (const sensitive of sensitiveValues.filter(Boolean)) {
    sanitized = sanitized.split(sensitive).join("[REDACTED]");
  }
  return sanitized;
};

export const sanitizeTelemetryValue = (
  value: unknown,
  sensitiveValues: readonly string[] = [],
): HarnessTelemetryValue => {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => sanitizeTelemetryValue(item, sensitiveValues));
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => allowedMetadataKey(key))
    .map(([key, item]) => [key, sanitizeTelemetryValue(item, sensitiveValues)]));
};

const observationMetadata = (output: unknown) => {
  if (output === null) return { valueType: "null" as const, topLevelKeys: [], itemCount: null };
  if (Array.isArray(output)) {
    return { valueType: "array" as const, topLevelKeys: [], itemCount: output.length };
  }
  if (typeof output === "object") {
    return {
      valueType: "object" as const,
      topLevelKeys: Object.keys(output as Record<string, unknown>).filter(allowedMetadataKey).sort(),
      itemCount: null,
    };
  }
  return { valueType: typeof output, topLevelKeys: [], itemCount: null };
};

const ordinal = (prefix: string, index: number) => `${prefix}-${String(index + 1).padStart(3, "0")}`;

export function telemetryFromAggregate(
  request: HarnessAgentRequest,
  aggregate: InvestigationAggregate,
  sensitiveValues: readonly string[] = [],
  observability?: LiveEvalObservability,
): HarnessExecutionTelemetry {
  const iterations = [...aggregate.iterations].sort((a, b) => a.sequence - b.sequence);
  const calls = aggregate.toolCalls.filter((item) => item.proposedActionId === null)
    .sort((a, b) => a.order - b.order);
  const hypotheses = [...aggregate.hypotheses];
  const iterationIds = new Map(iterations.map((item) => [item.id, ordinal("ITERATION", item.sequence - 1)]));
  const hypothesisIds = new Map(hypotheses.map((item, index) => [item.id, ordinal("HYPOTHESIS", index)]));
  const callIds = new Map(calls.map((item, index) => [item.id, ordinal("TOOL_CALL", index)]));

  const remainingObservations = [...request.observations];
  const evidenceIds = new Map<string, string>();
  for (const call of calls) {
    const observationIndex = remainingObservations.findIndex((item) => item.toolName === call.name);
    const observation = observationIndex < 0 ? null : remainingObservations.splice(observationIndex, 1)[0];
    const callEvidence = aggregate.evidence.filter((item) => item.toolResultId === call.resultId);
    callEvidence.forEach((item) => evidenceIds.set(
      item.id,
      observation?.evidenceId ?? ordinal("EVIDENCE", aggregate.evidence.indexOf(item)),
    ));
  }
  aggregate.evidence.forEach((item, index) => {
    if (!evidenceIds.has(item.id)) evidenceIds.set(item.id, ordinal("EVIDENCE", index));
  });

  const assessmentIteration = new Map<string, number>();
  for (const event of aggregate.traceEvents.filter((item) => item.type === "PLANNER_DECISION")) {
    const ids = Array.isArray(event.details.assessedEvidenceIds)
      ? event.details.assessedEvidenceIds.filter((item): item is string => typeof item === "string")
      : [];
    const sequence = iterations.find((item) => item.id === event.iterationId)?.sequence;
    if (sequence !== undefined) ids.forEach((id) => assessmentIteration.set(id, sequence));
  }

  const rejectedFinalizeAttempts = aggregate.auditEvents.filter((item) =>
    item.type === "PLANNER_DECISION_REJECTED" && item.details.decisionType === "FINALIZE")
    .map((item) => ({
      iteration: typeof item.details.iterationSequence === "number"
        ? item.details.iterationSequence
        : 0,
      validationResult: "REJECTED" as const,
      rejectionReason: typeof item.details.validationCode === "string"
        ? sanitizeText(item.details.validationCode, sensitiveValues)
        : null,
    }));
  const telemetry: Omit<HarnessExecutionTelemetry, "telemetryIdentity"> = {
    schemaVersion: HARNESS_TELEMETRY_SCHEMA_VERSION,
    availability: "PARTIAL",
    plannerActions: iterations.flatMap((item) => item.decisionType ? [item.decisionType] : []),
    schemaRepairCount: aggregate.auditEvents.filter((item) =>
      item.type === "PLANNER_DECISION_REPAIR_ATTEMPTED").length,
    iterations: iterations.map((item) => ({
      sequence: item.sequence,
      iterationId: iterationIds.get(item.id)!,
      status: item.status,
      decisionType: item.decisionType,
      publicRationale: item.publicRationale
        ? sanitizeText(item.publicRationale, sensitiveValues)
        : null,
    })),
    toolTrajectory: calls.map((item) => ({
      order: item.order,
      iteration: item.iteration,
      toolCallId: callIds.get(item.id)!,
      toolName: item.name,
      arguments: sanitizeTelemetryValue(item.arguments, sensitiveValues) as Record<string, HarnessTelemetryValue>,
      status: item.status,
      resultStatus: item.result?.status ?? null,
      observationMetadata: observationMetadata(item.result?.output),
      evidenceIds: aggregate.evidence.filter((evidence) => evidence.toolResultId === item.resultId)
        .map((evidence) => evidenceIds.get(evidence.id)!),
      error: item.result?.status === "ERROR" ? "TOOL_ERROR_REPORTED" : null,
    })),
    evidencePersistenceEvents: aggregate.evidence.map((item) => ({
      evidenceId: evidenceIds.get(item.id)!,
      toolCallId: callIds.get(calls.find((call) => call.resultId === item.toolResultId)?.id ?? "") ?? null,
      category: item.category,
      source: item.source,
      strength: item.strength,
      provenance: item.provenance,
      statement: sanitizeText(item.statement, sensitiveValues),
    })),
    evidenceAssessments: aggregate.hypothesisEvidenceLinks.map((item) => ({
      iteration: assessmentIteration.get(item.evidenceId) ?? null,
      evidenceId: evidenceIds.get(item.evidenceId) ?? "EVIDENCE-UNAVAILABLE",
      hypothesisId: hypothesisIds.get(item.hypothesisId) ?? "HYPOTHESIS-UNAVAILABLE",
      relation: item.relation,
      explanation: sanitizeText(item.explanation, sensitiveValues),
    })),
    hypothesisTransitions: observability ? observability.hypothesisTransitions.map((item) => ({
      iteration: item.iterationId
        ? iterations.find((iteration) => iteration.id === item.iterationId)?.sequence ?? null
        : null,
      hypothesisId: hypothesisIds.get(item.hypothesisId) ?? "HYPOTHESIS-UNAVAILABLE",
      before: item.before,
      after: item.after,
    })) : null,
    competingHypothesisState: hypotheses.map((item) => ({
      hypothesisId: hypothesisIds.get(item.id)!,
      revision: item.revision,
      statement: sanitizeText(item.statement, sensitiveValues),
      status: item.status,
      confidence: item.confidence,
      supportScore: item.supportScore,
      contradictionScore: item.contradictionScore,
    })),
    diagnosisAttempts: observability ? observability.finalizeAttempts.map((item, index) => ({
      attempt: index + 1,
      diagnosisId: item.validationResult === "ACCEPTED" ? ordinal("DIAGNOSIS", index) : null,
      selectedHypothesisId: item.validationResult === "ACCEPTED" && aggregate.diagnosis?.selectedHypothesisId
        ? hypothesisIds.get(aggregate.diagnosis.selectedHypothesisId) ?? null
        : null,
      validationResult: item.validationResult,
      rejectionReason: item.rejectionReason
        ? sanitizeText(item.rejectionReason, sensitiveValues)
        : null,
    })) : aggregate.diagnoses.map((item, index) => ({
      attempt: index + 1,
      diagnosisId: ordinal("DIAGNOSIS", index),
      selectedHypothesisId: item.selectedHypothesisId
        ? hypothesisIds.get(item.selectedHypothesisId) ?? null
        : null,
      validationResult: "ACCEPTED" as const,
      rejectionReason: null,
    })),
    finalizeAttempts: [
      ...rejectedFinalizeAttempts,
      ...(observability?.finalizeAttempts.map((item) => ({
        iteration: iterations.find((iteration) => iteration.id === item.iterationId)?.sequence ?? 0,
        validationResult: item.validationResult,
        rejectionReason: item.rejectionReason
          ? sanitizeText(item.rejectionReason, sensitiveValues)
          : null,
      })) ?? []),
      ...(!observability ? iterations.filter((item) => item.decisionType === "FINALIZE").map((item) => ({
        iteration: item.sequence,
        validationResult: aggregate.diagnosis ? "ACCEPTED" as const : "UNAVAILABLE" as const,
        rejectionReason: null,
      })) : []),
    ].sort((a, b) => a.iteration - b.iteration),
    stopReason: aggregate.run.stopReason,
    budgetTerminationReason: ["MAX_ITERATIONS", "MAX_TOOL_CALLS", "MODEL_CALL_BUDGET_EXHAUSTED"]
      .includes(aggregate.run.stopReason ?? "") ? aggregate.run.stopReason : null,
    terminalState: aggregate.run.status,
    modelCallCount: aggregate.run.modelCallCount,
    toolCallCount: calls.length,
    unavailableFields: [
      ...(!observability ? [
        "hypothesisTransitions.history",
        "hypothesisTransitions.confidenceBeforeAfter",
      ] : []),
      "diagnosisAttempts.rejectedAttempts",
      "validationRejectionReason.whenNotPersistedByRuntime",
    ],
  };
  return {
    ...telemetry,
    telemetryIdentity: createHash("sha256").update(canonicalJson(telemetry)).digest("hex"),
  };
}
