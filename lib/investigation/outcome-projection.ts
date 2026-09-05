import {
  buildEvidencePacketV2,
  evaluateEvidenceReadinessV2,
  type EvidencePacketV2,
  type EvidenceReadinessV2Decision,
} from "./evidence-packet-v2";
import type { InvestigationAggregate } from "./types";

export type InvestigationOutcomeProjection =
  | {
      kind: "CAUSAL_DIAGNOSIS";
      conclusion: string;
      confidence: string;
      affectedMetrics: string[];
      affectedSegments: string[];
      supportingEvidenceIds: string[];
      contradictingEvidenceIds: string[];
      limitations: string[];
      recommendedAction: string;
    }
  | {
      kind: "BOUNDED_HYPOTHESIS";
      leadingHypothesis: string;
      alternativeHypotheses: string[];
      confirmedFacts: string[];
      supportingEvidenceIds: string[];
      contradictingEvidenceIds: string[];
      missingInformation: string[];
      nextBestEvidence: string;
      recommendation: "OBSERVE" | "ESCALATE" | "PAUSE_DECISION";
    }
  | {
      kind: "ACTIONABLE_ABSTENTION";
      confirmedFacts: string[];
      excludedHypotheses: string[];
      missingInformation: string[];
      nextStep: string;
      recommendedOwner: string;
      prohibitedActions: string[];
    };

const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort();

const linkedEvidenceIds = (
  packet: EvidencePacketV2,
  hypothesisId: string | null,
  relation: "SUPPORTS" | "CONTRADICTS",
) => hypothesisId ? packet.evidence.filter((evidence) => evidence.relations.some((item) =>
  item.hypothesisId === hypothesisId && item.relation === relation)).map((item) => item.id).sort() : [];

const nextEvidence = (readiness: EvidenceReadinessV2Decision) => {
  if (readiness.missingCategories.includes("RELEASE_CONTEXT")) {
    return "Query the governed release record for version, rollout, changed modules, and release time.";
  }
  if (readiness.missingCategories.includes("CURRENT_IMPACT")) {
    return "Query the affected metric with its baseline and a discriminating segment breakdown.";
  }
  if (readiness.unresolvedCompetingHypothesisIds.length > 0) {
    return "Collect one current-incident observation that supports one leading hypothesis while refuting the competing hypothesis.";
  }
  return "Add a current-incident observation that tests the leading mechanism and its falsifying signal.";
};

export function projectInvestigationOutcomeV2(
  aggregate: InvestigationAggregate,
): InvestigationOutcomeProjection {
  const readiness = evaluateEvidenceReadinessV2(aggregate, 0);
  const packet = buildEvidencePacketV2(aggregate, readiness);
  const confirmedFacts = packet.evidence
    .filter((item) => item.category !== "SIMILAR_INCIDENT")
    .map((item) => item.factSummary);

  if (aggregate.diagnosis) {
    const selectedId = aggregate.diagnosis.selectedHypothesisId;
    return {
      kind: "CAUSAL_DIAGNOSIS",
      conclusion: aggregate.diagnosis.summary,
      confidence: aggregate.diagnosis.confidence,
      affectedMetrics: unique(aggregate.diagnosis.affectedMetrics),
      affectedSegments: unique(aggregate.diagnosis.affectedSegments),
      supportingEvidenceIds: linkedEvidenceIds(packet, selectedId, "SUPPORTS"),
      contradictingEvidenceIds: linkedEvidenceIds(packet, selectedId, "CONTRADICTS"),
      limitations: unique(packet.evidence.flatMap((item) => item.limitations)),
      recommendedAction: aggregate.diagnosis.recommendedAction,
    };
  }

  const leading = packet.hypotheses.find((item) => item.id === readiness.leadingHypothesisId);
  if (readiness.status === "READY_FOR_BOUNDED_HYPOTHESIS" && leading) {
    return {
      kind: "BOUNDED_HYPOTHESIS",
      leadingHypothesis: leading.statement,
      alternativeHypotheses: packet.hypotheses
        .filter((item) => item.id !== leading.id && item.status !== "REJECTED")
        .map((item) => item.statement).slice(0, 3),
      confirmedFacts,
      supportingEvidenceIds: linkedEvidenceIds(packet, leading.id, "SUPPORTS"),
      contradictingEvidenceIds: linkedEvidenceIds(packet, leading.id, "CONTRADICTS"),
      missingInformation: unique([...readiness.missingCategories, ...readiness.reasons]),
      nextBestEvidence: nextEvidence(readiness),
      recommendation: readiness.unresolvedCompetingHypothesisIds.length > 0
        ? "PAUSE_DECISION"
        : "OBSERVE",
    };
  }

  return {
    kind: "ACTIONABLE_ABSTENTION",
    confirmedFacts,
    excludedHypotheses: packet.hypotheses.filter((item) => item.status === "REJECTED")
      .map((item) => item.statement),
    missingInformation: unique([...readiness.missingCategories, ...readiness.reasons]),
    nextStep: nextEvidence(readiness),
    recommendedOwner: readiness.missingCategories.includes("RELEASE_CONTEXT")
      ? "Release owner"
      : "Product analytics owner",
    prohibitedActions: [
      "Do not describe an unverified hypothesis as the root cause.",
      "Do not execute rollback or external write actions without reviewed evidence and approval.",
    ],
  };
}
