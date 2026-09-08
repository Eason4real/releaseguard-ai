import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

if (!process.argv.includes("--provider=live")) {
  console.error("LIVE_BENCHMARK_EXPLICIT_OPT_IN_REQUIRED: pass --provider=live");
  process.exit(2);
}

const boundedIntegerEnv = (name, fallback, maximum) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_INVALID`);
  return Math.min(maximum, Number(raw));
};
const booleanEnv = (name, fallback) => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name}_INVALID`);
};
const harnessVersionEnv = () => {
  const value = process.env.LIVE_EVAL_HARNESS_VERSION?.trim().toUpperCase() || "V2";
  if (!["V2", "V3", "V4", "V5", "V6", "V7", "V8"].includes(value)) throw new Error("LIVE_EVAL_HARNESS_VERSION_INVALID");
  return value;
};

const outputDirectory = new URL("../.sites-runtime/investigation-benchmark/", import.meta.url);
const outputFile = new URL("live-harness.mjs", outputDirectory);
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
  const command = harness.resolveLiveHarnessCommand(process.argv.slice(2));
  const providerFactory = harness.createLiveLLMHarnessProviderFactory({
    provider: process.env.LIVE_EVAL_PROVIDER,
    baseUrl: process.env.LIVE_EVAL_BASE_URL,
    apiKey: process.env.LIVE_EVAL_API_KEY,
    model: process.env.LIVE_EVAL_MODEL,
    transportMaxRetries: boundedIntegerEnv("LIVE_EVAL_TRANSPORT_RETRIES", 0, 2),
    transportRetryBaseDelayMs: boundedIntegerEnv("LIVE_EVAL_RETRY_BASE_DELAY_MS", 500, 4_000),
    fixtureQueryHints: booleanEnv("LIVE_EVAL_FIXTURE_QUERY_HINTS", false),
    harnessVersion: harnessVersionEnv(),
    sourceIdentity: process.env.LIVE_EVAL_SOURCE_IDENTITY,
  });
  const stopOnQuota = booleanEnv("LIVE_EVAL_STOP_ON_QUOTA", false);
  let reportPaths;
  const reportDirectory = process.env.LIVE_EVAL_REPORT_DIR;
  const caseIds = process.env.LIVE_EVAL_CASE_IDS?.trim()
    ? process.env.LIVE_EVAL_CASE_IDS.split(",").map((value) => value.trim()).filter(Boolean)
    : undefined;
  const resumeReport = process.env.LIVE_EVAL_RESUME_PARTIAL
    ? JSON.parse(await readFile(process.env.LIVE_EVAL_RESUME_PARTIAL, "utf8"))
    : undefined;
  const report = command.mode === "PREFLIGHT"
    ? await harness.runLivePreflight({ sourceCommit, providerFactory })
    : await harness.runInvestigationBenchmarkDevHarness({
      sourceCommit,
      providerFactory,
      ...(resumeReport ? { resumeReport } : {}),
      ...(command.caseId ? { caseId: command.caseId } : {}),
      ...(caseIds ? { caseIds } : {}),
      runId: process.env.LIVE_EVAL_RUN_ID ?? `LIVE-DEV-${crypto.randomUUID()}`,
      async onCheckpoint(partialReport) {
        reportPaths ??= harness.resolveBenchmarkReportPaths(partialReport, reportDirectory);
        await harness.writePartialBenchmarkReport(reportPaths, partialReport);
        const latestCase = partialReport.cases.at(-1);
        if (stopOnQuota && latestCase?.execution.error === "PROVIDER_QUOTA_EXHAUSTED") {
          const quotaError = new Error("PROVIDER_QUOTA_EXHAUSTED");
          quotaError.code = "PROVIDER_QUOTA_EXHAUSTED";
          throw quotaError;
        }
      },
      onProgress(event) {
        if (event.phase === "START") {
          console.error(`[${event.index}/${event.total}] ${event.caseId} START`);
          return;
        }
        console.error(
          `[${event.index}/${event.total}] ${event.caseId} END state=${event.terminalState}`
          + ` model=${event.modelCallCount} tool=${event.toolCallCount}`
          + ` duration=${Math.round(event.durationMs)}ms`,
        );
      },
    });
  const artifacts = command.mode === "PREFLIGHT"
    ? null
    : await harness.writeFinalBenchmarkReport(
        reportPaths ?? harness.resolveBenchmarkReportPaths(report, reportDirectory),
        report,
      );
  console.log(JSON.stringify({ report, artifacts }, null, 2));
  if (command.mode === "PREFLIGHT") {
    if (report.status !== "PASS") process.exitCode = 1;
  } else if (report.manifest.failedCases > 0) process.exitCode = 1;
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "LIVE_BENCHMARK_FAILED";
  console.error(code);
  process.exitCode = 1;
} finally {
  await rm(outputFile, { force: true });
}
