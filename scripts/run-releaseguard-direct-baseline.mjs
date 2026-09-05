import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const runIndex = Number(process.argv.find((arg) => arg.startsWith("--run="))?.split("=")[1] ?? 1);
if (![1, 2, 3].includes(runIndex)) throw new Error("--run must be 1, 2, or 3");
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const root = new URL("../", import.meta.url);
const buildDirectory = new URL(".sites-runtime/releaseguard-evaluation/", root);
const outputDirectory = new URL("evaluation/results/raw/", root);
const bundle = new URL("direct-baseline.mjs", buildDirectory);
const output = new URL(`direct-llm-run-${runIndex}.jsonl`, outputDirectory);
await mkdir(buildDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [new URL("../eval/releaseguard-evaluation/direct-baseline.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: bundle.pathname,
});
await writeFile(output, "", { flag: "w" });
const { runDirectBaseline } = await import(`${pathToFileURL(bundle.pathname).href}?run=${Date.now()}`);
const records = await runDirectBaseline({
  provider: required("LIVE_EVAL_PROVIDER"),
  baseUrl: required("LIVE_EVAL_BASE_URL"),
  apiKey: required("LIVE_EVAL_API_KEY"),
  model: required("LIVE_EVAL_MODEL"),
  runIndex,
  async onCase(record) {
    await appendFile(output, `${JSON.stringify(record)}\n`);
    console.error(`[${record.case_id}] ${record.error ? `ERROR ${record.error}` : "DONE"}`);
  },
});
console.log(JSON.stringify({ system: "DIRECT_LLM", runIndex, cases: records.length, output: output.pathname }, null, 2));
