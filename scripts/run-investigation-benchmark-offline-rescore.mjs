import { createHash, randomUUID } from "node:crypto";
import { link, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const repository = new URL("../", import.meta.url);
const frozenSourceFile = new URL(
  "../eval-results/investigation-benchmark/untuned-live-dev-baseline-1.log",
  import.meta.url,
);
const frozenOutputFile = new URL(
  "../eval-results/investigation-benchmark/untuned-live-dev-baseline-1.rescored-phase1a-v2.json",
  import.meta.url,
);
const expectedSourceSha256 = "8936b90cf62be13984c45837f77b39e09ad28b890a7b9f8d6ca553ea7e72cc53";
const inputArgument = process.argv.find((item) => item.startsWith("--input="));
const outputArgument = process.argv.find((item) => item.startsWith("--output="));
const inputPath = inputArgument?.slice("--input=".length);
const outputPath = outputArgument?.slice("--output=".length);
if (inputArgument && !inputPath) throw new Error("RESCORE_INPUT_PATH_REQUIRED");
if (outputArgument && !outputPath) throw new Error("RESCORE_OUTPUT_PATH_REQUIRED");
const sourceFile = inputPath ? pathToFileURL(resolve(inputPath)) : frozenSourceFile;
const outputFile = outputPath
  ? pathToFileURL(resolve(outputPath))
  : inputPath
    ? pathToFileURL(resolve(`${inputPath.replace(/\.json$/i, "")}.rescored-phase1a-v2.json`))
    : frozenOutputFile;
const comparisonFile = new URL(outputFile.href.replace(/\.json$/i, ".comparison.md"));
const outputDirectory = new URL(".sites-runtime/investigation-benchmark/", repository);
const bundleFile = new URL("offline-rescore.mjs", outputDirectory);

async function atomicCreate(file, content) {
  await mkdir(new URL(".", file), { recursive: true });
  const temporary = pathToFileURL(`${file.pathname}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const sourceBytes = await readFile(sourceFile);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
if (!inputPath && sourceSha256 !== expectedSourceSha256) {
  throw new Error("FROZEN_BASELINE_SHA256_MISMATCH");
}
const sourceText = sourceBytes.toString("utf8");
const jsonStart = sourceText.indexOf("{");
if (jsonStart < 0) throw new Error("FROZEN_BASELINE_JSON_MISSING");
const sourceReport = JSON.parse(sourceText.slice(jsonStart));

await mkdir(outputDirectory, { recursive: true });
try {
  await build({
    entryPoints: [new URL(
      "../eval/investigation-benchmark/harness/offline-rescore.ts",
      import.meta.url,
    ).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundleFile.pathname,
  });
  const evaluator = await import(`${pathToFileURL(bundleFile.pathname).href}?run=${Date.now()}`);
  const report = await evaluator.rescoreFrozenBaselineReport(sourceReport, sourceSha256);
  const sourceScore = sourceReport.aggregate?.rootCauseSemanticAccuracy
    ?? sourceReport.aggregate?.rootCauseTop1Accuracy
    ?? null;
  const comparison = [
    "# Investigation Benchmark Offline Rescore",
    "",
    `- Source: ${sourceFile.pathname}`,
    `- Source SHA-256: ${sourceSha256}`,
    `- Dataset: ${report.identity.datasetVersion}`,
    `- Evaluation contract: ${report.identity.evaluationContractVersion}`,
    `- Source semantic score: ${sourceScore ?? "unavailable"}`,
    `- Rescored semantic score: ${report.aggregate.rootCauseSemanticAccuracy ?? "unavailable"}`,
    `- Completed: ${report.aggregate.completedCases}`,
    `- Failed: ${report.aggregate.failedCases}`,
    `- Inconclusive: ${report.aggregate.inconclusiveCases}`,
    `- Planner repair rate: ${report.aggregate.plannerDecisionRepairRate ?? "unavailable"}`,
    "",
  ].join("\n");
  await atomicCreate(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  try {
    await atomicCreate(comparisonFile, `${comparison}\n`);
  } catch (error) {
    await rm(outputFile, { force: true });
    throw error;
  }
  console.log(JSON.stringify({
    output: outputFile.pathname,
    comparison: comparisonFile.pathname,
    report,
  }, null, 2));
} finally {
  await rm(bundleFile, { force: true });
}
