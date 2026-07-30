import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

if (!process.argv.includes("--provider=live")) {
  console.error("LIVE_BENCHMARK_EXPLICIT_OPT_IN_REQUIRED: pass --provider=live");
  process.exit(2);
}

const outputDirectory = new URL("../.sites-runtime/investigation-benchmark/", import.meta.url);
const outputFile = new URL("live-harness.mjs", outputDirectory);
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
  const providerFactory = harness.createLiveLLMHarnessProviderFactory({
    provider: process.env.LIVE_EVAL_PROVIDER,
    baseUrl: process.env.LIVE_EVAL_BASE_URL,
    apiKey: process.env.LIVE_EVAL_API_KEY,
    model: process.env.LIVE_EVAL_MODEL,
  });
  const report = await harness.runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory,
    ...(caseId ? { caseId } : {}),
    runId: `LIVE-DEV-${crypto.randomUUID()}`,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.manifest.failedCases > 0) process.exitCode = 1;
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "LIVE_BENCHMARK_FAILED";
  console.error(code);
  process.exitCode = 1;
} finally {
  await rm(outputFile, { force: true });
}
