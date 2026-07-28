import assert from "node:assert/strict";
import test from "node:test";
import { phase4ScenarioGroundTruth } from "../eval/fixtures/phase4-scenarios";

test("Phase 4 ground truth defines five isolated adversarial scenarios", () => {
  assert.deepEqual(
    phase4ScenarioGroundTruth.map((scenario) => scenario.id),
    [
      "release-regression",
      "third-party-outage",
      "natural-fluctuation",
      "missing-insufficient-data",
      "historical-memory-trap",
    ],
  );

  for (const scenario of phase4ScenarioGroundTruth) {
    const hypothesisKeys = scenario.hypotheses.map((hypothesis) => hypothesis.key);
    assert.ok(hypothesisKeys.length >= 1 && hypothesisKeys.length <= 3);
    assert.equal(new Set(hypothesisKeys).size, hypothesisKeys.length);
    assert.ok(scenario.evidence.length > 0);
    for (const evidence of scenario.evidence) {
      assert.deepEqual(Object.keys(evidence.relations).sort(), [...hypothesisKeys].sort());
    }
    assert.equal(
      scenario.requiredTools.some((tool) => scenario.forbiddenTools.includes(tool)),
      false,
    );
    assert.ok(scenario.failureConditions.length > 0);
    assert.equal(scenario.expectedDiagnosis === null, scenario.acceptableSelectedHypotheses.length === 0);
  }
});

test("Phase 4 ground truth includes contradiction, neutral, RAG trap and insufficient-data outcomes", () => {
  const relations = phase4ScenarioGroundTruth.flatMap((scenario) =>
    scenario.evidence.flatMap((evidence) => Object.values(evidence.relations))
  );
  assert.ok(relations.includes("SUPPORTS"));
  assert.ok(relations.includes("CONTRADICTS"));
  assert.ok(relations.includes("NEUTRAL"));
  assert.ok(phase4ScenarioGroundTruth.some((scenario) =>
    scenario.evidence.some((evidence) => evidence.family === "RAG")));
  assert.ok(phase4ScenarioGroundTruth.some((scenario) =>
    scenario.hypotheses.every((hypothesis) => hypothesis.expectedOutcome === "ACTIVE")));
});
