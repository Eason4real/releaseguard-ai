import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const configured = Boolean(
  process.env.LIVE_EVAL_PROVIDER
  && ["deepseek", "openai-compatible"].includes(process.env.LIVE_EVAL_PROVIDER)
  &&
  process.env.LIVE_EVAL_API_KEY
  && process.env.LIVE_EVAL_BASE_URL
  && process.env.LIVE_EVAL_MODEL,
);
if (!configured) {
  console.log("LIVE_EVAL_SKIPPED");
  console.log("reason = missing credentials or invalid LIVE_EVAL_PROVIDER");
  process.exit(0);
}
const outputDirectory = new URL("../.sites-runtime/eval/", import.meta.url);
const outputFile = new URL("live-phase4-eval.mjs", outputDirectory);
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [new URL("../eval/live-phase4-eval.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "node", target: "node22", outfile: outputFile.pathname,
});
const result = spawnSync(process.execPath, [outputFile.pathname], { stdio: "inherit" });
await rm(outputFile, { force: true });
process.exitCode = result.status ?? 1;
