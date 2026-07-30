import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateInvestigationBenchmarkDatasetHash,
} from "../eval/investigation-benchmark/dataset/hash";
import {
  INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH,
  loadInvestigationBenchmarkDevDataset,
} from "../eval/investigation-benchmark/dataset/dev";
import {
  validateInvestigationBenchmarkDataset,
} from "../eval/investigation-benchmark/dataset/validator";
import { modelToolDefinitions } from "../lib/investigation/tools";

const expectedCategories = {
  release_regression: 5,
  configuration: 4,
  upstream_dependency: 3,
  user_feedback: 3,
  unknown: 3,
  insufficient_evidence: 4,
};

const expectedDifficulties = { EASY: 6, MEDIUM: 11, HARD: 5 };

test("formal Dev dataset loads exactly 22 DEV cases with frozen distributions", () => {
  const dataset = loadInvestigationBenchmarkDevDataset();
  assert.equal(dataset.manifest.purpose, "GOVERNED_DEV");
  assert.equal(dataset.manifest.caseEntries.length, 22);
  assert.equal(dataset.fixtures.length, 22);
  assert.ok(dataset.manifest.caseEntries.every((entry) => entry.split === "DEV"));
  assert.equal(dataset.manifest.caseEntries.some((entry) => entry.split === "HOLDOUT"), false);
  assert.deepEqual(Object.fromEntries(Object.keys(expectedCategories).map((category) => [
    category,
    dataset.manifest.caseEntries.filter((entry) => entry.category === category).length,
  ])), expectedCategories);
  assert.deepEqual(Object.fromEntries(Object.keys(expectedDifficulties).map((difficulty) => [
    difficulty,
    dataset.manifest.caseEntries.filter((entry) => entry.difficulty === difficulty).length,
  ])), expectedDifficulties);
});

test("formal Dev cases resolve unique fixtures and current registered tools", () => {
  const dataset = loadInvestigationBenchmarkDevDataset();
  const allowedTools = new Set(modelToolDefinitions.map((item) => item.function.name));
  assert.equal(new Set(dataset.manifest.caseEntries.map((entry) => entry.caseId)).size, 22);
  assert.equal(new Set(dataset.manifest.caseEntries.map((entry) => entry.fixtureRef)).size, 22);
  assert.ok(dataset.manifest.caseEntries.every((entry) =>
    entry.requiredTools.every((toolName) => allowedTools.has(toolName))));
  assert.ok(dataset.manifest.caseEntries.every((entry) => /^TPL-\d{3}$/.test(entry.templateFamily)));
  assert.ok(dataset.manifest.caseEntries.every((entry) =>
    entry.fixtureRef.startsWith("benchmark-fixture://")));
});

test("formal Dev Ground Truth references resolve without alias or label conflicts", () => {
  const dataset = loadInvestigationBenchmarkDevDataset();
  for (const fixture of dataset.fixtures) {
    const groundTruth = fixture.benchmarkCase.groundTruth;
    const evidenceIds = new Set(fixture.evidence.map((item) => item.evidenceId));
    const supporting = new Set(groundTruth.supportingEvidenceIds);
    const distractors = new Set(groundTruth.distractorEvidenceIds);
    assert.ok(groundTruth.requiredEvidenceIds.every((id) => supporting.has(id)));
    assert.ok([...supporting, ...distractors].every((id) => evidenceIds.has(id)));
    assert.equal([...supporting].some((id) => distractors.has(id)), false);
    assert.equal(new Set(groundTruth.acceptableAliases.map((alias) =>
      alias.toLocaleLowerCase("en-US"))).size, groundTruth.acceptableAliases.length);
    assert.ok(groundTruth.acceptableAliases.every((alias) =>
      alias.toLocaleLowerCase("en-US") !== groundTruth.canonicalRootCause.toLocaleLowerCase("en-US")));
  }
});

test("formal Dev loader excludes TEST ONLY fixtures and metadata", () => {
  const serialized = JSON.stringify(loadInvestigationBenchmarkDevDataset());
  assert.doesNotMatch(serialized, /TEST_ONLY|test-only-fixture:\/\//);
  assert.equal(serialized.includes("DATASET-TEST-ONLY-001"), false);
});

test("formal Dev dataset passes every governance gate and its locked hash is stable", async () => {
  const dataset = loadInvestigationBenchmarkDevDataset();
  const report = await validateInvestigationBenchmarkDataset(dataset);
  const secondHash = await calculateInvestigationBenchmarkDatasetHash(
    loadInvestigationBenchmarkDevDataset(),
  );
  assert.equal(report.calculatedDatasetHash, INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH);
  assert.equal(secondHash, INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH);
  const nonPassingGates = Object.entries(report.gates)
    .filter(([, gate]) => gate.status !== "PASS")
    .map(([gate, value]) => ({ gate, status: value.status, issues: value.issues }));
  assert.deepEqual(nonPassingGates, []);
  assert.equal(report.status, "PASS");
  assert.equal(report.valid, true);
  assert.ok(Object.values(report.gates).every((gate) => gate.status === "PASS"));
});
