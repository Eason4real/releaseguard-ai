import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = new URL("../.sites-runtime/eval-real/", import.meta.url);
const outputFile = new URL("real-public-rag-eval.mjs", outputDirectory);
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [new URL("../eval/real-public-rag-eval.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outputFile.pathname,
});
const result = spawnSync(process.execPath, [outputFile.pathname], { stdio: "inherit" });
await rm(outputFile, { force: true });
process.exitCode = result.status ?? 1;
