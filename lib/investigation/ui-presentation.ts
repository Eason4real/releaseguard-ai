import type { Confidence, LegacyInvestigationResponse } from "./types";

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
