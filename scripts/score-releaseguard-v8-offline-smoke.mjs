import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInvestigationBenchmarkDevDataset } from
  "../eval/investigation-benchmark/dataset/dev/index.ts";
import { scoreInvestigationCase } from "../eval/investigation-benchmark/scorer.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = resolve(root, "evaluation/results/v8/smoke");
const seriesId = process.env.V8_SMOKE_SERIES?.trim() || "contract-v2";
if (!/^[a-z0-9-]+$/.test(seriesId)) throw new Error("V8_SMOKE_SERIES_INVALID");
const inputPath = resolve(smokeRoot, `raw/synthesis-attempts-${seriesId}.jsonl`);
const outputPath = resolve(smokeRoot, `score-${seriesId}.json`);
const manifest = JSON.parse(await readFile(resolve(smokeRoot, "input/evaluator-manifest.json"), "utf8"));
const caseIdBySample = new Map(manifest.samples.map((item) => [item.sampleId, item.caseId]));
const attempts = (await readFile(inputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effective = new Map();
for (const item of attempts) {
  if (!effective.has(item.sampleId) || !item.error) effective.set(item.sampleId, item);
}
const dataset = loadInvestigationBenchmarkDevDataset();
const fixtureByCase = new Map(dataset.fixtures.map((item) => [item.benchmarkCase.caseId,
  item.benchmarkCase]));
const cases = [...effective.values()].map((record) => {
  const caseId = caseIdBySample.get(record.sampleId);
  const fixture = fixtureByCase.get(caseId);
  if (!caseId || !fixture) throw new Error(`V8_SMOKE_SCORE_MAPPING_MISSING:${record.sampleId}`);
  const claims = record.decision?.type === "FINALIZE" ? record.decision.diagnosis.claims : [];
  const citedEvidenceIds = [...new Set(claims.flatMap((claim) => claim.evidenceIds ?? []))];
  const predictedRootCause = record.decision?.type === "FINALIZE"
    ? claims.find((claim) => claim.type === "ROOT_CAUSE")?.statement
      ?? record.decision.diagnosis.summary
    : record.decision?.type === "STOP_INCONCLUSIVE"
      ? `Insufficient evidence: ${record.decision.reason}`
      : "";
  const normalizedPrediction = {
    caseId,
    predictedRootCause,
    predictedRootCauseId: null,
    citedEvidenceIds,
    diagnosisClaims: claims,
    modelCallCount: record.modelCalls.length,
    toolCallCount: 0,
    durationMs: record.durationMs,
  };
  return {
    sampleId: record.sampleId,
    caseId,
    decisionType: record.decision?.type ?? null,
    error: record.error,
    normalizedPrediction,
    scoring: scoreInvestigationCase(fixture, normalizedPrediction, {
      runtimeFailed: Boolean(record.error),
    }),
  };
});
const strictCorrect = cases.filter((item) => item.scoring.rootCause.correct === true).length;
const reviewRequired = cases.filter((item) => item.scoring.rootCause.correct === null).length;
const technicalSuccess = cases.filter((item) => !item.error).length;
const criticalCitationHits = cases.filter((item) => {
  const required = new Set(fixtureByCase.get(item.caseId).groundTruth.requiredEvidenceIds);
  return [...required].some((id) => item.normalizedPrediction.citedEvidenceIds.includes(id));
}).length;
const aggregate = {
  expectedCases: 17,
  cases: cases.length,
  technicalSuccess,
  technicalSuccessRate: cases.length ? technicalSuccess / cases.length : 0,
  strictCorrect,
  strictRootCauseRate: cases.length ? strictCorrect / cases.length : 0,
  automaticReviewRequired: reviewRequired,
  criticalEvidenceCitationHits: criticalCitationHits,
  criticalEvidenceCitationRate: cases.length ? criticalCitationHits / cases.length : 0,
  toolCalls: 0,
  modelCalls: cases.reduce((total, item) => total + item.normalizedPrediction.modelCallCount, 0),
};
const output = {
  schemaVersion: "releaseguard-v8-offline-smoke-score-v2",
  seriesId,
  boundary: "SCORING_RUN_AFTER_MODEL_OUTPUTS; EVALUATOR_MANIFEST_AND_GOLD_NOT_MODEL_VISIBLE",
  aggregate,
  retainedAttempts: { total: attempts.length, failed: attempts.filter((item) => item.error).length },
  cases,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, aggregate }, null, 2));
