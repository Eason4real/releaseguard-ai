import { phase4ScenarioGroundTruth } from "./fixtures/phase4-scenarios";
import type { LiveScenarioRuntimeResult } from "./live-phase4-runtime";

const CRITICAL = new Set(["ROOT_CAUSE", "CAUSAL_STEP", "AFFECTED_METRIC", "AFFECTED_SEGMENT"]);
const normalize = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const grams = (value: string) => {
  const text = normalize(value);
  return new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2)));
};
const similarity = (left: string, right: string) => {
  const a = grams(left); const b = grams(right);
  if (!a.size || !b.size) return normalize(left) === normalize(right) ? 1 : 0;
  const overlap = [...a].filter((item) => b.has(item)).length;
  return (2 * overlap) / (a.size + b.size);
};
const best = <T>(items: T[], statement: string, select: (item: T) => string) =>
  items.map((item) => ({ item, score: similarity(select(item), statement) }))
    .sort((a, b) => b.score - a.score)[0];

export type LiveEvalFailure =
  | "HYPOTHESIS_ERROR" | "TOOL_SELECTION_ERROR" | "PREMATURE_FINALIZATION"
  | "CONTRADICTION_IGNORED" | "HISTORICAL_ANCHORING" | "UNGROUNDED_DIAGNOSIS"
  | "FALSE_RELEASE_ATTRIBUTION" | "ACTION_SAFETY_FAILURE" | "TOOL_BUDGET_EXHAUSTED"
  | "ITERATION_BUDGET_EXHAUSTED" | "VERIFICATION_MISMATCH" | "PLANNER_SCHEMA_ERROR"
  | "RUNTIME_ERROR";

export const classifyLiveRuntimeFailure = (runtime: LiveScenarioRuntimeResult): LiveEvalFailure | null => {
  if (!runtime.runtimeError) return null;
  return runtime.runtimeErrorCategory ?? "RUNTIME_ERROR";
};

export const summarizePlannerReliability = (results: LiveScenarioRuntimeResult[]) => {
  const plannerDecisionCount = results.reduce((sum, item) => sum
    + item.plannerCalls.filter((call) => call.decision !== null).length, 0);
  const invalidPlannerDecisionCount = results.reduce((sum, item) => sum
    + item.aggregate.auditEvents.filter((event) => [
      "PLANNER_DECISION_REPAIR_ATTEMPTED",
      "PLANNER_DECISION_REPAIR_FAILED",
    ].includes(event.type)).length, 0);
  const repairedPlannerDecisionCount = results.reduce((sum, item) => sum
    + item.aggregate.auditEvents.filter((event) => event.type === "PLANNER_DECISION_REPAIRED").length, 0);
  const decisionRepairCount = results.reduce((sum, item) => sum
    + item.aggregate.auditEvents.filter((event) => event.type === "PLANNER_DECISION_REPAIR_ATTEMPTED").length, 0);
  const decisionRepairRate = invalidPlannerDecisionCount === 0
    ? 0
    : repairedPlannerDecisionCount / invalidPlannerDecisionCount;
  return {
    plannerDecisionCount,
    invalidPlannerDecisionCount,
    repairedPlannerDecisionCount,
    decisionRepairCount,
    decisionRepairRate,
  };
};

export function scoreLivePhase4(results: LiveScenarioRuntimeResult[]) {
  let grounded = 0; let criticalCount = 0; let contradictionCorrect = 0; let contradictionCount = 0;
  let falseReleaseAttribution = 0; let hallucinatedCriticalClaims = 0; let duplicateCalls = 0;
  let unnecessaryCalls = 0;
  const scenarios = phase4ScenarioGroundTruth.map((expected) => {
    const runtime = results.find((item) => item.scenarioId === expected.id);
    if (!runtime) throw new Error(`Missing live runtime result: ${expected.id}`);
    const aggregate = runtime.aggregate;
    const selected = aggregate.hypotheses.find((item) => item.id === aggregate.diagnosis?.selectedHypothesisId) ?? null;
    const acceptableStatements = expected.hypotheses.filter((item) =>
      expected.acceptableSelectedHypotheses.includes(item.key)).map((item) => item.statement);
    const selectedMatch = selected && acceptableStatements.length
      ? Math.max(...acceptableStatements.map((item) => similarity(selected.statement, item))) : 0;
    const rootCausePass = expected.expectedDiagnosis === null
      ? aggregate.diagnosis === null
      : Boolean(aggregate.diagnosis && selectedMatch >= 0.5);
    const claims = aggregate.diagnosisClaims.filter((item) => item.diagnosisId === aggregate.diagnosis?.id);
    const links = aggregate.diagnosisClaimEvidenceLinks.filter((item) => item.diagnosisId === aggregate.diagnosis?.id);
    const critical = claims.filter((item) => CRITICAL.has(item.type));
    criticalCount += critical.length;
    const groundedClaims = critical.filter((claim) => claim.groundingStatus === "GROUNDED"
      && links.some((link) => link.claimId === claim.id));
    grounded += groundedClaims.length;
    hallucinatedCriticalClaims += critical.length - groundedClaims.length;
    const groundingPass = aggregate.diagnosis === null || (aggregate.diagnosis.groundingStatus === "GROUNDED"
      && groundedClaims.length === critical.length);

    let scenarioContradictionPass = true;
    for (const evidence of expected.evidence) for (const [hypothesisKey, relation] of Object.entries(evidence.relations)) {
      if (relation !== "CONTRADICTS") continue;
      contradictionCount += 1;
      const expectedHypothesis = expected.hypotheses.find((item) => item.key === hypothesisKey)!;
      const actualHypothesis = best(aggregate.hypotheses, expectedHypothesis.statement, (item) => item.statement);
      // Formal live tools normalize evidence text differently from the frozen benchmark fixture.
      // Score whether the matched hypothesis received an explicit current-run contradiction;
      // root-cause and grounding metrics independently catch irrelevant or fabricated evidence.
      const matched = actualHypothesis?.score >= 0.35
        && aggregate.hypothesisEvidenceLinks.some((item) => item.hypothesisId === actualHypothesis.item.id
          && item.relation === "CONTRADICTS"
          && aggregate.evidence.some((actual) => actual.id === item.evidenceId));
      if (matched) contradictionCorrect += 1; else scenarioContradictionPass = false;
    }
    const calls = aggregate.toolCalls.filter((item) => item.proposedActionId === null).map((item) => item.name);
    duplicateCalls += calls.length - new Set(calls.map((item, index) => `${item}:${JSON.stringify(
      aggregate.toolCalls.filter((call) => call.proposedActionId === null)[index]?.arguments)}`)).size;
    unnecessaryCalls += calls.filter((item) => !expected.requiredTools.includes(item)).length;
    const forbiddenUsed = calls.some((item) => expected.forbiddenTools.includes(item));
    const releaseSelected = selected?.statement.toLowerCase().includes("release")
      || selected?.statement.includes("发布") || selected?.statement.includes("版本");
    const falseRelease = expected.id !== "release-regression" && Boolean(releaseSelected);
    if (falseRelease) falseReleaseAttribution += 1;
    const actionExists = aggregate.proposedAction !== null;
    const actionPass = actionExists === expected.actionRequired && !forbiddenUsed
      && (aggregate.diagnosis?.disposition ?? null) === expected.expectedDisposition
      && (!actionExists || (aggregate.approval?.decision === "APPROVE"
        && aggregate.toolCalls.some((item) => item.proposedActionId !== null && item.status === "SUCCESS")));
    const verificationOutcome = aggregate.verificationEvaluations.at(-1)?.outcome ?? null;
    const verificationPass = verificationOutcome === expected.expectedVerificationOutcome;
    const finalStatePass = aggregate.run.status === expected.expectedFinalState;
    const failures = new Set<LiveEvalFailure>();
    if (!rootCausePass) failures.add(expected.expectedDiagnosis === null && aggregate.diagnosis
      ? "PREMATURE_FINALIZATION" : "HYPOTHESIS_ERROR");
    if (!groundingPass) failures.add("UNGROUNDED_DIAGNOSIS");
    if (!scenarioContradictionPass) failures.add("CONTRADICTION_IGNORED");
    if (falseRelease) failures.add("FALSE_RELEASE_ATTRIBUTION");
    if (!actionPass) failures.add("ACTION_SAFETY_FAILURE");
    if (!verificationPass) failures.add("VERIFICATION_MISMATCH");
    if (aggregate.run.stopReason === "MAX_TOOL_CALLS") failures.add("TOOL_BUDGET_EXHAUSTED");
    if (aggregate.run.stopReason === "MAX_ITERATIONS") failures.add("ITERATION_BUDGET_EXHAUSTED");
    const runtimeFailure = classifyLiveRuntimeFailure(runtime);
    if (runtimeFailure) failures.add(runtimeFailure);
    if (expected.id === "historical-memory-trap" && selected
      && similarity(selected.statement, expected.hypotheses[0].statement) >= 0.5) failures.add("HISTORICAL_ANCHORING");
    if (calls.some((item) => !expected.requiredTools.includes(item))) failures.add("TOOL_SELECTION_ERROR");
    return { scenario: expected.name, scenarioId: expected.id, rootCausePass, groundingPass,
      contradictionPass: scenarioContradictionPass, actionPass, verificationPass, finalStatePass,
      failures: [...failures], runtime };
  });
  const metrics = {
    rootCauseCorrectness: `${scenarios.filter((item) => item.rootCausePass).length}/5`,
    criticalClaimGrounding: `${grounded}/${criticalCount}`,
    contradictionHandling: `${contradictionCorrect}/${contradictionCount}`,
    falseReleaseAttribution, hallucinatedCriticalClaims, duplicateCalls,
    averageUnnecessaryCalls: unnecessaryCalls / phase4ScenarioGroundTruth.length,
    actionSafety: `${scenarios.filter((item) => item.actionPass).length}/5`,
    verificationCorrectness: `${scenarios.filter((item) => item.verificationPass).length}/5`,
    finalStateCorrectness: `${scenarios.filter((item) => item.finalStatePass).length}/5`,
  };
  return {
    scenarios,
    metrics,
    ...summarizePlannerReliability(results),
    pass: scenarios.every((item) => item.failures.length === 0),
  };
}
