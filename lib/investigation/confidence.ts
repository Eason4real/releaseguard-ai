import type {
  Confidence,
  Evidence,
  HypothesisEvidenceLink,
  HypothesisStatus,
} from "./types";

const reliability = (item: Evidence) => {
  if (item.category === "METRIC_ANOMALY" || item.category === "SEGMENT_METRIC") return 4;
  if (item.category === "RELEASE_CHANGE" || item.source.includes("Registry")) return 3;
  if (item.category === "USER_FEEDBACK") return 2;
  if (item.category === "SIMILAR_INCIDENT") return 1;
  return item.strength === "HIGH" ? 3 : item.strength === "MEDIUM" ? 2 : 1;
};

const family = (item: Evidence) => {
  if (item.category === "METRIC_ANOMALY" || item.category === "SEGMENT_METRIC") return "ANALYTICS";
  if (item.category === "RELEASE_CHANGE") return "RELEASE";
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
  const supportingFamilies = new Set<string>();
  let hasTierA = false;
  let tierAContradiction = false;

  for (const link of links) {
    const item = evidenceById.get(link.evidenceId);
    if (!item || link.relation === "NEUTRAL") continue;
    const weight = reliability(item);
    if (link.relation === "SUPPORTS") {
      supportScore += weight;
      supportingFamilies.add(family(item));
      if (weight === 4) hasTierA = true;
    } else {
      contradictionScore += weight;
      if (weight === 4) tierAContradiction = true;
    }
  }

  const netScore = supportScore - contradictionScore;
  let confidence: Confidence = "LOW";
  if (
    netScore >= 5
    && supportingFamilies.size >= 2
    && hasTierA
    && !tierAContradiction
  ) confidence = "HIGH";
  else if (netScore >= 2 || (hasTierA && !tierAContradiction)) confidence = "MEDIUM";

  let status: HypothesisStatus = "ACTIVE";
  if (contradictionScore >= supportScore + 3 || tierAContradiction) status = "REJECTED";
  else if (supportScore > contradictionScore) status = "SUPPORTED";
  else if (contradictionScore > 0) status = "WEAKENED";

  return {
    supportScore,
    contradictionScore,
    confidence,
    status,
    confidenceReason:
      `${supportingFamilies.size} 个独立来源；支持分 ${supportScore}，反证分 ${contradictionScore}` +
      (tierAContradiction ? "；存在未解决的核心指标反证" : ""),
  };
}
