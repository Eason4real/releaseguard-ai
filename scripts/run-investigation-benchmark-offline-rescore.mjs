import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const repository = new URL("../", import.meta.url);
const sourceFile = new URL(
  "../eval-results/investigation-benchmark/untuned-live-dev-baseline-1.log",
  import.meta.url,
);
const outputFile = new URL(
  "../eval-results/investigation-benchmark/untuned-live-dev-baseline-1.rescored-phase1a-v2.json",
  import.meta.url,
);
const expectedSourceSha256 = "8936b90cf62be13984c45837f77b39e09ad28b890a7b9f8d6ca553ea7e72cc53";
const outputDirectory = new URL(".sites-runtime/investigation-benchmark/", repository);
const bundleFile = new URL("offline-rescore.mjs", outputDirectory);

const sourceBytes = await readFile(sourceFile);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
if (sourceSha256 !== expectedSourceSha256) throw new Error("FROZEN_BASELINE_SHA256_MISMATCH");
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
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output: outputFile.pathname, report }, null, 2));
} finally {
  await rm(bundleFile, { force: true });
}
