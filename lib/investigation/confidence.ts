import type {
  Confidence,
  Evidence,
  HypothesisEvidenceLink,
  HypothesisStatus,
} from "./types";

const impactCategories = new Set([
  "METRIC_ANOMALY",
  "PRODUCT_METRIC",
  "SEGMENT_METRIC",
]);

const mechanismCategories = new Set([
  "ERROR_TRACE",
  "SYSTEM_EVENT",
  "CODE_CHANGE_MECHANISM",
  "RELEASE_CHANGE_MECHANISM",
]);

const reliability = (item: Evidence) => {
  if (impactCategories.has(item.category) || mechanismCategories.has(item.category)) return 4;
  if (item.category === "RELEASE_CHANGE" || item.source.includes("Registry")) return 3;
  if (item.category === "USER_FEEDBACK") return 2;
  if (item.category === "SIMILAR_INCIDENT") return 1;
  return item.strength === "HIGH" ? 3 : item.strength === "MEDIUM" ? 2 : 1;
};

const family = (item: Evidence) => {
  if (impactCategories.has(item.category)) return "ANALYTICS";
  if (item.category === "RELEASE_CHANGE" || item.category.includes("CHANGE_MECHANISM")) return "RELEASE";
  if (item.category === "ERROR_TRACE" || item.category === "SYSTEM_EVENT") return "SYSTEM";
  if (item.category === "USER_FEEDBACK") return "FEEDBACK";
  if (item.category === "SIMILAR_INCIDENT") return "RAG";
  return item.source;
};

export function calculateHypothesisConfidence(
  evidence: Evidence[],
  links: HypothesisEvidenceLink[],
) {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  let supportScore = 0;
  let contradictionScore = 0;
  const currentSupportingFamilies = new Set<string>();
  let hasCurrentSupport = false;
  let hasImpactSupport = false;
  let hasMechanismSupport = false;
  let hasCoreContradiction = false;

  for (const link of links) {
    const item = evidenceById.get(link.evidenceId);
    if (!item || link.relation === "NEUTRAL") continue;
    const weight = reliability(item);
    if (link.relation === "SUPPORTS") {
      supportScore += weight;
      const isCurrentEvent = item.category !== "SIMILAR_INCIDENT"
        && item.provenance !== "public_reference";
      if (isCurrentEvent) {
        hasCurrentSupport = true;
        currentSupportingFamilies.add(family(item));
        if (impactCategories.has(item.category)) hasImpactSupport = true;
        if (mechanismCategories.has(item.category)) hasMechanismSupport = true;
      }
    } else {
      contradictionScore += weight;
      if (weight === 4 && item.category !== "SIMILAR_INCIDENT") {
        hasCoreContradiction = true;
      }
    }
  }

  const netScore = supportScore - contradictionScore;
  let confidence: Confidence = "LOW";
  if (
    netScore >= 5
    && currentSupportingFamilies.size >= 2
    && hasImpactSupport
    && !hasCoreContradiction
  ) confidence = "HIGH";
  else if (
    hasCurrentSupport
    && !hasCoreContradiction
    && (netScore >= 2 || hasImpactSupport)
  ) confidence = "MEDIUM";

  let status: HypothesisStatus = "ACTIVE";
  if (contradictionScore >= supportScore + 3 || hasCoreContradiction) status = "REJECTED";
  else if (
    confidence === "HIGH"
    && currentSupportingFamilies.size >= 2
    && hasImpactSupport
    && hasMechanismSupport
  ) status = "CONFIRMED";
  else if (supportScore > contradictionScore) status = "SUPPORTED";
  else if (contradictionScore > 0) status = "WEAKENED";

  return {
    supportScore,
    contradictionScore,
    confidence,
    status,
    confidenceReason:
      `${currentSupportingFamilies.size} 个当前事件独立来源；支持分 ${supportScore}，反证分 ${contradictionScore}` +
      `；影响证据 ${hasImpactSupport ? "有" : "无"}；机制证据 ${hasMechanismSupport ? "有" : "无"}` +
      (hasCoreContradiction ? "；存在未解决的核心反证" : ""),
  };
}
