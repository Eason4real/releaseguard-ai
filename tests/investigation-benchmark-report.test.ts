import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeterministicHarnessProviderFactory,
  resolveBenchmarkReportPaths,
  runInvestigationBenchmarkDevHarness,
  sha256Text,
  writeFinalBenchmarkReport,
  writePartialBenchmarkReport,
  type DevHarnessReport,
} from "../eval/investigation-benchmark/harness";

test("live benchmark reports checkpoint atomically and finalize without overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "releaseguard-benchmark-report-"));
  try {
    let checkpoint: DevHarnessReport | null = null;
    const report = await runInvestigationBenchmarkDevHarness({
      sourceCommit: "73b292deb1b617fab7fc21bf1ba2d636e559527a",
      providerFactory: createDeterministicHarnessProviderFactory(),
      caseId: "CASE-208",
      runId: "REPORT-PERSISTENCE-TEST",
      now: () => "2031-02-02T03:04:05.678Z",
      onCheckpoint(value) { checkpoint = value; },
    });
    assert.ok(checkpoint);
    const paths = resolveBenchmarkReportPaths(report, directory);
    await writePartialBenchmarkReport(paths, checkpoint);
    const partial = JSON.parse(await readFile(paths.partialJson, "utf8"));
    assert.equal(partial.reportStatus, "INCOMPLETE");
    assert.equal(partial.manifest.processedCases, 1);
    assert.equal(partial.cases[0].caseId, "CASE-208");

    const artifacts = await writeFinalBenchmarkReport(paths, report);
    const json = await readFile(paths.finalJson, "utf8");
    const markdown = await readFile(paths.markdown, "utf8");
    assert.equal(artifacts.json.sha256, sha256Text(json));
    assert.equal(artifacts.markdown.sha256, sha256Text(markdown));
    assert.equal(JSON.parse(json).reportStatus, "COMPLETE");
    assert.match(markdown, /Planner repair rate/);
    await assert.rejects(readFile(paths.partialJson, "utf8"), { code: "ENOENT" });

    await assert.rejects(writeFinalBenchmarkReport(paths, report), { code: "EEXIST" });
    assert.equal(await readFile(paths.finalJson, "utf8"), json);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial and final report writers reject the wrong completion state", async () => {
  const report = await runInvestigationBenchmarkDevHarness({
    sourceCommit: "REPORT-STATE-TEST",
    providerFactory: createDeterministicHarnessProviderFactory(),
    caseId: "CASE-208",
  });
  const directory = await mkdtemp(join(tmpdir(), "releaseguard-benchmark-state-"));
  try {
    const paths = resolveBenchmarkReportPaths(report, directory);
    await assert.rejects(writePartialBenchmarkReport(paths, report),
      /PARTIAL_REPORT_MUST_BE_INCOMPLETE/);
    await assert.rejects(writeFinalBenchmarkReport(paths, { ...report, reportStatus: "INCOMPLETE" }),
      /FINAL_REPORT_MUST_BE_COMPLETE/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
