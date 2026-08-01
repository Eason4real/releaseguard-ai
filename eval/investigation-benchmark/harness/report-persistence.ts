import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DevHarnessReport } from "./types";

export type BenchmarkReportPaths = {
  directory: string;
  partialJson: string;
  finalJson: string;
  markdown: string;
};

const filePart = (value: string) => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "");

export function resolveBenchmarkReportPaths(
  report: DevHarnessReport,
  directory = resolve("reports/investigation-benchmark"),
): BenchmarkReportPaths {
  const provider = typeof report.manifest.modelConfiguration === "string"
    ? report.manifest.executionProvider
    : report.manifest.modelConfiguration.provider;
  const timestamp = report.manifest.startedAt.replace(/[:.]/g, "-");
  const base = [
    "investigation-live-benchmark",
    filePart(provider),
    filePart(report.manifest.datasetVersion),
    timestamp,
    filePart(report.manifest.sourceCommit.slice(0, 12)),
    filePart(report.manifest.runId),
  ].join("-");
  return {
    directory,
    partialJson: join(directory, `${base}.partial.json`),
    finalJson: join(directory, `${base}.json`),
    markdown: join(directory, `${base}.md`),
  };
}

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function atomicReplace(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function atomicCreate(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export const sha256Text = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function renderBenchmarkMarkdown(report: DevHarnessReport) {
  const model = typeof report.manifest.modelConfiguration === "string"
    ? report.manifest.modelConfiguration
    : `${report.manifest.modelConfiguration.provider} / ${report.manifest.modelConfiguration.model}`;
  const aggregate = report.aggregate;
  return [
    "# Investigation Live Benchmark",
    "",
    `- Status: ${report.reportStatus}`,
    `- Schema: ${report.schemaVersion}`,
    `- Dataset: ${report.manifest.datasetId} ${report.manifest.datasetVersion}`,
    `- Evaluation contract: ${report.manifest.evaluationContractVersion}`,
    `- Model: ${model}`,
    `- Git commit: ${report.manifest.sourceCommit}`,
    `- Run: ${report.manifest.startedAt} to ${report.manifest.completedAt ?? "incomplete"}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Cases | ${report.manifest.totalCases} |`,
    `| Completed | ${aggregate.completedCases} |`,
    `| Failed | ${aggregate.failedCases} |`,
    `| Inconclusive | ${aggregate.inconclusiveCases} |`,
    `| Exact root-cause ID score | ${aggregate.rootCauseExactMatchAccuracy ?? "unavailable"} |`,
    `| Semantic root-cause score | ${aggregate.rootCauseSemanticAccuracy ?? "unavailable"} |`,
    `| Planner repair rate | ${aggregate.plannerDecisionRepairRate ?? "unavailable"} |`,
    `| Planner first-attempt success rate | ${aggregate.plannerFirstAttemptSuccessRate ?? "unavailable"} |`,
    `| Planner final success rate | ${aggregate.plannerFinalSuccessRate ?? "unavailable"} |`,
    `| Planner schema errors | ${aggregate.errorTaxonomyCounts.PLANNER_SCHEMA_ERROR} |`,
    `| Invalid planner decisions | ${aggregate.errorTaxonomyCounts.INVALID_PLANNER_DECISION} |`,
    `| Runtime errors | ${aggregate.errorTaxonomyCounts.RUNTIME_ERROR} |`,
    `| Grounded contract mismatches | ${aggregate.groundedContractMismatches} |`,
    `| Total tokens | ${aggregate.tokenUsage.totalTokens ?? "unavailable"} |`,
    `| Total latency (ms) | ${aggregate.totalDurationMs ?? "unavailable"} |`,
    "| Cost | unavailable |",
    "",
  ].join("\n");
}

export async function writePartialBenchmarkReport(
  paths: BenchmarkReportPaths,
  report: DevHarnessReport,
) {
  if (report.reportStatus !== "INCOMPLETE") throw new Error("PARTIAL_REPORT_MUST_BE_INCOMPLETE");
  await mkdir(paths.directory, { recursive: true });
  await atomicReplace(paths.partialJson, serialize(report));
}

export async function writeFinalBenchmarkReport(
  paths: BenchmarkReportPaths,
  report: DevHarnessReport,
) {
  if (report.reportStatus !== "COMPLETE") throw new Error("FINAL_REPORT_MUST_BE_COMPLETE");
  await mkdir(paths.directory, { recursive: true });
  const json = serialize(report);
  const markdown = `${renderBenchmarkMarkdown(report)}\n`;
  await atomicCreate(paths.finalJson, json);
  try {
    await atomicCreate(paths.markdown, markdown);
  } catch (error) {
    await rm(paths.finalJson, { force: true });
    throw error;
  }
  await rm(paths.partialJson, { force: true });
  return {
    json: { path: paths.finalJson, sha256: sha256Text(json) },
    markdown: { path: paths.markdown, sha256: sha256Text(markdown) },
  };
}
