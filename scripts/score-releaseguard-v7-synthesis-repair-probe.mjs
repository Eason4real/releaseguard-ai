import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadInvestigationBenchmarkDevDataset } from
  "../eval/investigation-benchmark/dataset/dev/index.ts";
import { scoreInvestigationCase } from "../eval/investigation-benchmark/scorer.ts";

const root = resolve(new URL("../", import.meta.url).pathname);
const inputPath = resolve(root, "evaluation/results/v7/ablation/synthesis-repair-probe.jsonl");
const outputPath = resolve(root, "evaluation/results/v7/ablation/synthesis-repair-probe.scored.json");
const attempts = (await readFile(inputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effectiveByCase = new Map();
for (const item of attempts) {
  if (!effectiveByCase.has(item.caseId) || !item.error) effectiveByCase.set(item.caseId, item);
}
const records = [...effectiveByCase.values()];
const dataset = loadInvestigationBenchmarkDevDataset();
const fixtures = new Map(dataset.fixtures.map((item) => [item.benchmarkCase.caseId, item.benchmarkCase]));

const cases = records.map((record) => {
  const fixture = fixtures.get(record.caseId);
  if (!fixture) throw new Error(`PROBE_SCORE_CASE_UNKNOWN:${record.caseId}`);
  const claims = record.decision?.type === "FINALIZE" ? record.decision.diagnosis.claims : [];
  const citedEvidenceIds = [...new Set(claims.flatMap((claim) => claim.evidenceIds ?? []))];
  const predictedRootCause = record.decision?.type === "FINALIZE"
    ? claims.find((claim) => claim.type === "ROOT_CAUSE")?.statement
      ?? record.decision.diagnosis.summary
    : record.decision?.type === "STOP_INCONCLUSIVE"
      ? `Insufficient evidence: ${record.decision.reason}`
      : "";
  const normalized = {
    caseId: record.caseId,
    predictedRootCause,
    predictedRootCauseId: null,
    citedEvidenceIds,
    diagnosisClaims: claims,
    modelCallCount: record.modelCalls.length,
    toolCallCount: 0,
  };
  return {
    runIndex: record.runIndex,
    caseId: record.caseId,
    decisionType: record.decision?.type ?? null,
    error: record.error,
    normalizedPrediction: normalized,
    scoring: scoreInvestigationCase(fixture, normalized, { runtimeFailed: Boolean(record.error) }),
  };
});
const rootResults = cases.map((item) => item.scoring.rootCause);
const aggregate = {
  cases: cases.length,
  finalized: cases.filter((item) => item.decisionType === "FINALIZE").length,
  inconclusive: cases.filter((item) => item.decisionType === "STOP_INCONCLUSIVE").length,
  errors: cases.filter((item) => item.error).length,
  automaticallyCorrect: rootResults.filter((item) => item.correct === true).length,
  automaticallyIncorrect: rootResults.filter((item) => item.correct === false).length,
  reviewRequired: rootResults.filter((item) => item.correct === null).length,
  citationCount: cases.reduce((total, item) =>
    total + item.normalizedPrediction.citedEvidenceIds.length, 0),
};
const output = {
  schemaVersion: "releaseguard-v7-synthesis-repair-probe-score-v1",
  boundary: "SCORING_RUN_AFTER_MODEL_OUTPUTS; GOLD_WAS_NOT_MODEL_VISIBLE",
  aggregate,
  retainedAttempts: { total: attempts.length, failed: attempts.filter((item) => item.error).length },
  cases,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, aggregate }, null, 2));
