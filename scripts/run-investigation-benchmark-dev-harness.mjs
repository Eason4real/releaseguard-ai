import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outputDirectory = new URL("../.sites-runtime/investigation-benchmark/", import.meta.url);
const outputFile = new URL("dev-harness.mjs", outputDirectory);
const caseArgument = process.argv.find((item) => item.startsWith("--case="));
const caseId = caseArgument?.slice("--case=".length);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
}).trim();

await mkdir(outputDirectory, { recursive: true });
try {
  await build({
    entryPoints: [new URL("../eval/investigation-benchmark/harness/index.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: outputFile.pathname,
  });
  const harness = await import(`${pathToFileURL(outputFile.pathname).href}?run=${Date.now()}`);
  const execute = (runId) => harness.runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: harness.createDeterministicHarnessProviderFactory(),
    ...(caseId ? { caseId } : {}),
    runId,
  });
  const runA = await execute("DEV-HARNESS-RUN-A");
  const runB = await execute("DEV-HARNESS-RUN-B");
  const summary = (report) => ({
    label: report.label,
    manifest: report.manifest,
    aggregate: report.aggregate,
    breakdown: report.breakdown,
    semanticHash: report.semanticHash,
  });
  console.log(JSON.stringify({
    runA: summary(runA),
    runB: summary(runB),
    deterministic: runA.semanticHash === runB.semanticHash,
  }, null, 2));
  if (runA.semanticHash !== runB.semanticHash) process.exitCode = 1;
} finally {
  await rm(outputFile, { force: true });
}
