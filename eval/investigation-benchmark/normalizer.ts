import type {
  BenchmarkRawDiagnosisClaim,
  BenchmarkRawInvestigationResult,
  NormalizedDiagnosisClaim,
  NormalizedInvestigationResult,
} from "./types";

const FACTUAL_CLAIM_TYPES = new Set([
  "ROOT_CAUSE",
  "CAUSAL_STEP",
  "AFFECTED_METRIC",
  "AFFECTED_SEGMENT",
]);

const requiredCount = (value: number | undefined, label: string) => {
  if (value === undefined) {
    throw new Error(`MISSING_REQUIRED_TELEMETRY: ${label} is required and cannot default to 0.`);
  }
  return value;
};

const linkedEvidenceByClaim = (raw: BenchmarkRawInvestigationResult) => {
  const links = new Map<string, string[]>();
  for (const link of raw.diagnosisClaimEvidenceLinks ?? []) {
    const evidenceIds = links.get(link.claimId) ?? [];
    evidenceIds.push(link.evidenceId);
    links.set(link.claimId, evidenceIds);
  }
  return links;
};

const claimEvidenceIds = (
  claim: BenchmarkRawDiagnosisClaim,
  links: Map<string, string[]>,
) => claim.citedEvidenceIds ?? links.get(claim.claimId) ?? [];

const normalizeClaim = (
  claim: BenchmarkRawDiagnosisClaim,
  links: Map<string, string[]>,
): NormalizedDiagnosisClaim => {
  const citedEvidenceIds = claimEvidenceIds(claim, links);
  const hasStructuredLinkage = claim.citedEvidenceIds !== undefined
    || links.has(claim.claimId);
  const groundingStatus = claim.groundingStatus
    ?? "LEGACY_UNVERIFIED";

  // A server-marked GROUNDED factual claim without a linkage cannot be evaluated.
  // Preserve explicit UNGROUNDED and LIMITATION states instead of inferring support.
  const normalizedGroundingStatus = FACTUAL_CLAIM_TYPES.has(claim.type)
    && groundingStatus === "GROUNDED"
    && !hasStructuredLinkage
    ? "LEGACY_UNVERIFIED"
    : groundingStatus;

  return {
    claimId: claim.claimId,
    type: claim.type,
    statement: claim.statement,
    citedEvidenceIds: [...citedEvidenceIds],
    groundingStatus: normalizedGroundingStatus,
  };
};

export function normalizeInvestigationResult(
  raw: BenchmarkRawInvestigationResult,
): NormalizedInvestigationResult {
  const links = linkedEvidenceByClaim(raw);
  const diagnosisClaims = (raw.diagnosisClaims ?? [])
    .map((claim) => normalizeClaim(claim, links));
  const citedEvidenceIds = [
    ...(raw.citedEvidenceIds ?? []),
    ...diagnosisClaims.flatMap((claim) => claim.citedEvidenceIds),
  ];

  return {
    caseId: raw.caseId,
    predictedRootCause: raw.predictedRootCause ?? "",
    predictedRootCauseId: raw.predictedRootCauseId ?? null,
    citedEvidenceIds,
    diagnosisClaims,
    modelCallCount: requiredCount(raw.modelCallCount, "modelCallCount"),
    toolCallCount: requiredCount(raw.toolCallCount, "toolCallCount"),
    ...(raw.tokenUsage ? { tokenUsage: raw.tokenUsage } : {}),
    ...(raw.durationMs !== undefined ? { durationMs: raw.durationMs } : {}),
  };
}
