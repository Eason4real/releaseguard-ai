import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadPredictions,
  summarizeBlindJudgeRecords,
} from "../eval/releaseguard-evaluation/blind-judge";

const predictionCase = (index: number, status = "PASS") => ({
  caseId: `CASE-${String(200 + index).padStart(3, "0")}`,
  execution: { status },
  normalizedPrediction: status === "PASS" ? {
    predictedRootCause: `root cause ${index}`,
    citedEvidenceIds: [`EV-${index}-A`, `EV-${index}-B`],
  } : null,
});

test("single-run Portfolio Final report loads all 22 predictions without a three-run layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseguard-final-judge-"));
  try {
    const reportPath = join(root, "portfolio-final-v8.json");
    await writeFile(reportPath, JSON.stringify({
      schemaVersion: "investigation-live-benchmark-report-v1",
      reportStatus: "COMPLETE",
      manifest: { totalCases: 22, processedCases: 22 },
      cases: Array.from({ length: 22 }, (_, index) =>
        predictionCase(index + 1, index === 1 ? "FAIL" : "PASS")),
    }));

    const predictions = await loadPredictions(root, "PORTFOLIO_FINAL", reportPath);
    assert.equal(predictions.length, 22);
    assert.equal(predictions[0].diagnosis, "root cause 1");
    assert.deepEqual(predictions[0].evidenceIds, ["EV-1-A", "EV-1-B"]);
    assert.equal(predictions[1].technicalStatus, "FAIL");
    assert.equal(predictions[1].diagnosis, null);
    assert.deepEqual(predictions[1].evidenceIds, []);
    assert.ok(predictions.every((item) => item.runIndex === 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical Harness v7 loader still reads three runs per case", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseguard-v7-judge-"));
  try {
    const raw = join(root, "evaluation/results/v7/raw");
    await mkdir(raw, { recursive: true });
    for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
      await writeFile(join(raw, `harness-v7-run-${runIndex}.json`), JSON.stringify({
        cases: [{
          caseId: "CASE-201",
          execution: { status: "PASS" },
          normalizedPrediction: {
            predictedRootCause: `v7 diagnosis ${runIndex}`,
            citedEvidenceIds: [`EV-${runIndex}`],
          },
        }],
      }));
    }
    const predictions = await loadPredictions(root, "HARNESS_V7");
    assert.equal(predictions.length, 3);
    assert.deepEqual(predictions.map((item) => item.runIndex), [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict and lenient aggregation keeps the existing score definitions", () => {
  const summary = summarizeBlindJudgeRecords([
    { case_id: "CASE-201", scores: [{ score: "2" }], error: null },
    { case_id: "CASE-202", scores: [{ score: "1" }], error: null },
    { case_id: "CASE-203", scores: [{ score: "0" }], error: null },
    { case_id: "CASE-204", scores: [{ score: "N/A" }], error: null },
    { case_id: "CASE-205", scores: [], error: "provider failure" },
  ]);
  assert.deepEqual(summary.scores, { "0": 1, "1": 1, "2": 1, "N/A": 1 });
  assert.equal(summary.strict, 1);
  assert.equal(summary.lenient, 2);
  assert.equal(summary.scorable, 3);
  assert.equal(summary.strictRate, 1 / 3);
  assert.equal(summary.lenientRate, 2 / 3);
  assert.equal(summary.cases, 5);
  assert.equal(summary.errors, 1);
});
