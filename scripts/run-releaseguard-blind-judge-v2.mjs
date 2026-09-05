import { appendFile, mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const root = new URL("../", import.meta.url);
const buildDirectory = new URL(".sites-runtime/releaseguard-evaluation-v2/", root);
const bundle = new URL("blind-judge-v2.mjs", buildDirectory);
const outputDirectory = new URL("evaluation/results/v2/judge/", root);
const output = new URL("blind-judge-v2.jsonl", outputDirectory);
await mkdir(buildDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [new URL("../eval/releaseguard-evaluation/blind-judge.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: bundle.pathname,
});
let existing = [];
try {
  existing = (await readFile(output, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const completedCaseIds = existing.filter((record) => !record.error).map((record) => record.case_id);
const { runBlindJudge } = await import(`${pathToFileURL(bundle.pathname).href}?run=${Date.now()}`);
const records = await runBlindJudge({
  root: new URL("../", import.meta.url).pathname.replace(/\/$/, ""),
  provider: required("LIVE_EVAL_PROVIDER"),
  baseUrl: required("LIVE_EVAL_BASE_URL"),
  apiKey: required("LIVE_EVAL_API_KEY"),
  model: required("LIVE_EVAL_MODEL"),
  predictionSet: "HARNESS_V2",
  judgeVersion: "releaseguard-blind-v2",
  skipCaseIds: completedCaseIds,
  async onCase(record) {
    await appendFile(output, `${JSON.stringify(record)}\n`);
    console.error(`[${record.case_id}] ${record.error ? `ERROR ${record.error}` : "JUDGED"}`);
    if (/PROVIDER_QUOTA_EXHAUSTED|\b402\b|Insufficient Balance/i.test(record.error ?? "")) {
      const error = new Error("PROVIDER_QUOTA_EXHAUSTED");
      error.code = "PROVIDER_QUOTA_EXHAUSTED";
      throw error;
    }
  },
});
console.log(JSON.stringify({
  previousCases: completedCaseIds.length,
  newCases: records.length,
  totalCases: completedCaseIds.length + records.length,
  output: output.pathname,
}, null, 2));
