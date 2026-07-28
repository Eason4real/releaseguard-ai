import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertPhase4HardGates,
  runPhase4Benchmark,
  scorePhase4Benchmark,
} from "../eval/phase4-agent-benchmark";
import { phase4ScenarioGroundTruth } from "../eval/fixtures/phase4-scenarios";

test("Phase 4 benchmark runs all five end-to-end scenario artifact pipelines", () => {
  const report = runPhase4Benchmark();
  assert.deepEqual(report.scenarios.map((item) => item.id),
    phase4ScenarioGroundTruth.map((item) => item.id));
  assert.doesNotThrow(() => assertPhase4HardGates(report));
  assert.equal(report.metrics.rootCauseCorrectness, "5/5");
  assert.equal(report.metrics.criticalClaimGrounding, "12/12");
  assert.equal(report.metrics.contradictionHandling, "11/11");
  assert.equal(report.metrics.falseReleaseAttribution, 0);
  assert.equal(report.metrics.hallucinatedCriticalClaims, 0);
  assert.equal(report.metrics.duplicateCalls, 0);
  assert.equal(report.metrics.averageUnnecessaryCalls, 0);
  assert.equal(report.metrics.actionSafety, "5/5");
  assert.equal(report.metrics.verificationCorrectness, "5/5");
  assert.equal(report.metrics.finalStateCorrectness, "5/5");
});

test("Phase 4 scenarios prove contradiction, action and verification behavior", () => {
  const report = runPhase4Benchmark();
  const release = report.scenarios.find((item) => item.id === "release-regression")!;
  assert.equal(release.hypotheses.find((item) => item.id.includes("release-retry"))?.status,
    "CONFIRMED");
  const outage = report.scenarios.find((item) => item.id === "third-party-outage")!;
  assert.equal(outage.hypotheses.find((item) => item.id.endsWith("release-regression"))?.status,
    "REJECTED");
  assert.equal(outage.diagnosis?.disposition, "ESCALATE");
  assert.equal(outage.automaticRollback, false);
  const natural = report.scenarios.find((item) => item.id === "natural-fluctuation")!;
  assert.equal(natural.actionCreated, false);
  assert.equal(natural.diagnosis?.disposition, "OBSERVE");
  const missing = report.scenarios.find((item) => item.id === "missing-insufficient-data")!;
  assert.equal(missing.diagnosis, null);
  assert.equal(missing.verificationOutcome, null);
  const trap = report.scenarios.find((item) => item.id === "historical-memory-trap")!;
  assert.equal(trap.hypotheses.find((item) => item.id.endsWith("historical-idempotency"))?.status,
    "REJECTED");
  assert.equal(trap.verificationOutcome, "PARTIALLY_RESOLVED");
});

test("Phase 4 hard-gate failures fail the benchmark", () => {
  const passing = runPhase4Benchmark();
  const broken = passing.scenarios.map((item) => ({ ...item }));
  broken[0].selectedHypothesisKey = "wrong-root-cause";
  broken[1].toolCalls = [...broken[1].toolCalls, broken[1].toolCalls[0]];
  const report = scorePhase4Benchmark(broken);
  assert.ok(report.hardGateFailures.some((item) => item.includes("root-cause")));
  assert.ok(report.hardGateFailures.some((item) => item.includes("duplicate")));
  assert.throws(() => assertPhase4HardGates(report), /hard gates failed/);
});

test("Phase 4 expected answers are isolated from production Planner and Runtime modules", async () => {
  const roots = ["lib", "app", "worker"];
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(target);
    }
  };
  for (const root of roots) await walk(root);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /phase4ScenarioGroundTruth|acceptableSelectedHypotheses|expectedVerificationOutcome/,
      `${file} must not import or embed Phase 4 expected answers`);
  }
});
