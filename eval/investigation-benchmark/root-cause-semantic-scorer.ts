import type {
  InvestigationGroundTruth,
  NormalizedInvestigationResult,
  RootCauseAnswerMode,
  RootCauseScore,
  RootCauseSemanticConcept,
} from "./types";

const normalizedText = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u2013\u2014]/g, "-");

const conceptPatterns: Record<RootCauseSemanticConcept, RegExp[]> = {
  RECOMMENDATION_SYSTEM: [/\brecommend(?:ation|ations|er)\b/],
  FEATURE_FLAG_ROLLOUT: [/\bfeature[- ]?flag\b/, /\bflag rollout\b/],
  EXPERIMENT_ASSIGNMENT: [
    /\bexperimentbinding\b/,
    /\bexperiment (?:assignment|binding|variant|cohort)\b/,
    /\b(?:assign|assigned|assigns|assignment)\b[^.]{0,80}\b(?:experiment|variant|cohort)\b/,
  ],
  NEW_USERS: [/\bnew[- ]users?\b/, /\bnew user cohort\b/],
  INCORRECT_ASSIGNMENT: [
    /\b(?:incorrect|incorrectly|wrong|wrongly|off-target)\b[^.]{0,80}\b(?:assign|assigned|assigns|assignment|behavior|variant)\b/,
    /\b(?:assign|assigned|assigns|assignment)\b[^.]{0,80}\b(?:incorrect|wrong|off-target|control)\b/,
  ],
  EVIDENCE_INSUFFICIENT: [
    /\binsufficient evidence\b/,
    /\b(?:not|isn't|is not) enough evidence\b/,
    /\black(?:s|ed|ing)? enough evidence\b/,
    /\b(?:cannot|can't|unable to) (?:determine|identify|establish|confirm)\b/,
    /\binconclusive\b/,
  ],
  ALTERNATIVES_UNRESOLVED: [
    /\b(?:cannot|can't|unable to) (?:distinguish|differentiate|resolve)\b/,
    /\b(?:both|multiple) [^.]{0,80}\b(?:remain|are) (?:possible|plausible|viable)\b/,
    /\bversus\b[^.]{0,80}\b(?:unresolved|unclear|uncertain)\b/,
  ],
  CHECKOUT_RELEASE: [/\bcheckout (?:release|client)\b/, /\brelease\b[^.]{0,40}\bcheckout\b/],
  PAYMENT_PROVIDER_INSTABILITY: [
    /\bpayment[- ]provider (?:instability|outage|failure|failures|timeout|timeouts)\b/,
    /\b(?:external )?payment provider\b/,
  ],
  DEFINITE_CAUSAL_ATTRIBUTION: [
    /\b(?:is|was|were) caused by\b/,
    /\broot cause (?:is|was)\b/,
    /\b(?:results?|resulted|stems?|stemmed) from\b/,
    /\bdue to\b/,
    /\bcausing\b/,
  ],
  RELEASE_EXCLUDED: [
    /\bunrelated to (?:the )?release\b/,
    /\bnot caused by (?:the )?release\b/,
    /\b(?:release|deployment) (?:is|was) not (?:the )?(?:cause|driver)\b/,
  ],
  IMMEDIATE_RETRY: [/\bimmediate retr(?:y|ies)\b/, /\bretr(?:y|ies) immediately\b/],
  IDEMPOTENCY_LOCK: [/\bidempotenc(?:y|e) lock\b/, /\bidempotent lock\b/],
  DATABASE_LOCK: [/\bdatabase lock\b/, /\bdb lock\b/],
};

export const detectRootCauseConcepts = (value: string) => {
  const text = normalizedText(value);
  return (Object.entries(conceptPatterns) as Array<[
    RootCauseSemanticConcept,
    RegExp[],
  ]>).filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([concept]) => concept);
};

export const detectPredictedAnswerMode = (value: string): RootCauseAnswerMode => {
  const concepts = new Set(detectRootCauseConcepts(value));
  if (concepts.has("DEFINITE_CAUSAL_ATTRIBUTION")) return "CAUSAL";
  if (concepts.has("EVIDENCE_INSUFFICIENT") || concepts.has("ALTERNATIVES_UNRESOLVED")) {
    return "ABSTAIN";
  }
  return "CAUSAL";
};

const exactText = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replace(/[\p{P}\p{S}\s]+/gu, "");

export function scoreRootCauseSemantics(
  groundTruth: InvestigationGroundTruth,
  result: NormalizedInvestigationResult,
  options: { runtimeFailed?: boolean } = {},
): RootCauseScore {
  const rubric = groundTruth.rootCauseEvaluation;
  const matchedConcepts = detectRootCauseConcepts(result.predictedRootCause);
  const matched = new Set(matchedConcepts);
  const predictedAnswerMode = detectPredictedAnswerMode(result.predictedRootCause);
  const missingRequiredConcepts = rubric.requiredConceptGroups
    .filter((group) => !group.anyOf.some((concept) => matched.has(concept)))
    .map((group) => group.id);
  const forbiddenAssertions = rubric.forbiddenConcepts.filter((concept) => matched.has(concept));
  if (rubric.expectedAnswerMode === "ABSTAIN" && predictedAnswerMode === "CAUSAL"
    && !forbiddenAssertions.includes("DEFINITE_CAUSAL_ATTRIBUTION")) {
    forbiddenAssertions.push("DEFINITE_CAUSAL_ATTRIBUTION");
  }
  const uncertaintyPolicyResult = rubric.uncertaintyPolicy === "NOT_APPLICABLE"
    ? "NOT_APPLICABLE" as const
    : predictedAnswerMode !== "ABSTAIN"
      ? "FAIL" as const
      : rubric.uncertaintyPolicy === "REQUIRE_UNRESOLVED_ALTERNATIVES"
        && !matched.has("ALTERNATIVES_UNRESOLVED")
        ? "FAIL" as const
        : "PASS" as const;
  const specificityPolicyResult = forbiddenAssertions.length > 0
    ? "FAIL" as const
    : missingRequiredConcepts.length > 0
      ? "REVIEW_REQUIRED" as const
      : "PASS" as const;
  const base = {
    expected: { id: groundTruth.canonicalRootCauseId, rootCause: groundTruth.canonicalRootCause },
    predicted: { id: result.predictedRootCauseId, rootCause: result.predictedRootCause },
  };
  const auditBase = {
    predictedAnswerMode,
    expectedAnswerMode: rubric.expectedAnswerMode,
    matchedConcepts,
    missingRequiredConcepts,
    forbiddenAssertions,
    uncertaintyPolicyResult,
    specificityPolicyResult,
  };
  const decision = (
    correct: boolean | null,
    matchedBy: RootCauseScore["matchedBy"],
    evaluationStatus: RootCauseScore["evaluationStatus"],
    finalDecision: RootCauseScore["audit"]["finalDecision"],
    decisionReason: string,
  ): RootCauseScore => ({
    correct,
    ...base,
    matchedBy,
    evaluationStatus,
    audit: { ...auditBase, finalDecision, decisionReason },
  });

  if (options.runtimeFailed) {
    return decision(null, "NONE", "RUNTIME_FAILED", "RUNTIME_FAILED",
      "Runtime failure is excluded from automatic root-cause correctness.");
  }
  if (predictedAnswerMode !== rubric.expectedAnswerMode) {
    return decision(false, "NONE", "AUTOMATICALLY_EVALUATED", "INCORRECT",
      `Answer mode ${predictedAnswerMode} conflicts with expected ${rubric.expectedAnswerMode}.`);
  }
  if (forbiddenAssertions.length > 0 || uncertaintyPolicyResult === "FAIL") {
    return decision(false, "NONE", "AUTOMATICALLY_EVALUATED", "INCORRECT",
      "Prediction violates the frozen uncertainty or forbidden-assertion policy.");
  }
  if (result.predictedRootCauseId !== null) {
    return result.predictedRootCauseId === groundTruth.canonicalRootCauseId
      ? decision(true, "ID", "AUTOMATICALLY_EVALUATED", "CORRECT",
        "Stable root-cause ID matches and semantic policies pass.")
      : decision(false, "NONE", "AUTOMATICALLY_EVALUATED", "INCORRECT",
        "Stable root-cause ID does not match the canonical ID.");
  }
  const predicted = exactText(result.predictedRootCause);
  const acceptable = [groundTruth.canonicalRootCause, ...groundTruth.acceptableAliases]
    .map(exactText);
  if (predicted.length > 0 && acceptable.includes(predicted)) {
    return decision(true, "ALIAS", "AUTOMATICALLY_EVALUATED", "CORRECT",
      "Normalized prediction exactly matches the canonical answer or an approved alias.");
  }
  if (rubric.requiredConceptGroups.length > 0 && missingRequiredConcepts.length === 0) {
    const matchedBy = rubric.expectedAnswerMode === "ABSTAIN"
      ? "ABSTENTION" as const
      : "SEMANTIC_RUBRIC" as const;
    return decision(true, matchedBy, "AUTOMATICALLY_EVALUATED", "CORRECT",
      "All required semantic concept groups and policies pass.");
  }
  return decision(null, "NONE", "REVIEW_REQUIRED", "REVIEW_REQUIRED",
    rubric.requiredConceptGroups.length === 0
      ? "No reviewed semantic rubric is available for automatic equivalence scoring."
      : "No contradiction was proven, but required semantic concepts were not all detected.");
}
