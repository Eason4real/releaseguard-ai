import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const reportArgument = process.argv.slice(2).find((value) => value.startsWith("--report="));
if (!reportArgument) throw new Error("PORTFOLIO_FINAL_REPORT_ARGUMENT_REQUIRED");
const root = resolve(new URL("..", import.meta.url).pathname);
const suppliedPath = reportArgument.slice("--report=".length).trim();
const reportPath = isAbsolute(suppliedPath) ? suppliedPath : resolve(root, suppliedPath);
const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.schemaVersion !== "investigation-live-benchmark-report-v1"
  || report.reportStatus !== "COMPLETE"
  || report.manifest?.modelConfiguration?.harnessVersion !== "V8"
  || report.manifest?.totalCases !== 22
  || report.manifest?.processedCases !== 22
  || report.cases?.length !== 22) {
  throw new Error("PORTFOLIO_FINAL_V8_REPORT_INVALID");
}

const buildDirectory = resolve(root, ".sites-runtime/releaseguard-portfolio-final-judge");
const bundle = resolve(buildDirectory, "blind-judge.mjs");
const outputDirectory = resolve(dirname(reportPath), "judge");
const output = resolve(outputDirectory, "blind-judge.jsonl");
const summaryPath = resolve(outputDirectory, "summary.json");
await mkdir(buildDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, "eval/releaseguard-evaluation/blind-judge.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: bundle,
});

let existing = [];
try {
  existing = (await readFile(output, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const completedCaseIds = existing.filter((record) => !record.error).map((record) => record.case_id);
const { runBlindJudge, summarizeBlindJudgeRecords } = await import(
  `${pathToFileURL(bundle).href}?run=${Date.now()}`
);
await runBlindJudge({
  root,
  provider: required("LIVE_EVAL_PROVIDER"),
  baseUrl: required("LIVE_EVAL_BASE_URL"),
  apiKey: required("LIVE_EVAL_API_KEY"),
  model: required("LIVE_EVAL_MODEL"),
  predictionSet: "PORTFOLIO_FINAL",
  reportPath,
  judgeVersion: "releaseguard-portfolio-final-blind-v1",
  skipCaseIds: completedCaseIds,
  async onCase(record) {
    await appendFile(output, `${JSON.stringify(record)}\n`);
    console.error(`[${record.case_id}] ${record.error ? `ERROR ${record.error}` : "JUDGED"}`);
  },
});
const allRecords = (await readFile(output, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effective = new Map();
for (const record of allRecords) {
  if (!effective.has(record.case_id) || !record.error) effective.set(record.case_id, record);
}
const records = [...effective.values()];
const summary = {
  schemaVersion: "releaseguard-portfolio-final-blind-judge-summary-v1",
  reportPath,
  output,
  ...summarizeBlindJudgeRecords(records),
  caseResults: records.map((record) => ({
    caseId: record.case_id,
    score: record.scores?.[0]?.score ?? null,
    reason: record.scores?.[0]?.reason ?? null,
    confidence: record.scores?.[0]?.confidence ?? null,
    error: record.error ?? null,
  })),
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
