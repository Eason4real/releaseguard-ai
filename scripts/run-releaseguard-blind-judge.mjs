import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const root = new URL("../", import.meta.url);
const buildDirectory = new URL(".sites-runtime/releaseguard-evaluation/", root);
const bundle = new URL("blind-judge.mjs", buildDirectory);
const outputDirectory = new URL("evaluation/results/raw/", root);
const output = new URL("blind-judge.jsonl", outputDirectory);
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
await writeFile(output, "", { flag: "w" });
const { runBlindJudge } = await import(`${pathToFileURL(bundle.pathname).href}?run=${Date.now()}`);
const records = await runBlindJudge({
  root: new URL("../", import.meta.url).pathname.replace(/\/$/, ""),
  provider: required("LIVE_EVAL_PROVIDER"),
  baseUrl: required("LIVE_EVAL_BASE_URL"),
  apiKey: required("LIVE_EVAL_API_KEY"),
  model: required("LIVE_EVAL_MODEL"),
  async onCase(record) {
    await appendFile(output, `${JSON.stringify(record)}\n`);
    console.error(`[${record.case_id}] ${record.error ? `ERROR ${record.error}` : "JUDGED"}`);
  },
});
console.log(JSON.stringify({ cases: records.length, output: output.pathname }, null, 2));
