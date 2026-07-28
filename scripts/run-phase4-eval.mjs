import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = new URL("../.sites-runtime/eval/", import.meta.url);
const outputFile = new URL("phase4-agent-eval.mjs", outputDirectory);
await mkdir(outputDirectory, { recursive: true });
await build({
  stdin: {
    contents: `
      import { assertPhase4HardGates, runPhase4Benchmark } from "./eval/phase4-agent-benchmark.ts";
      const report = runPhase4Benchmark();
      console.log("\\nPhase 4 Agent Benchmark");
      console.log("Scenario                     Root Cause  Grounding  Action  Verification  Final");
      for (const item of report.scenarios) {
        const columns = [
          item.name.padEnd(28),
          (item.rootCausePass ? "PASS" : "FAIL").padEnd(11),
          (item.groundingPass ? "PASS" : "FAIL").padEnd(10),
          (item.actionPass ? "PASS" : "FAIL").padEnd(8),
          (item.verificationPass ? (item.verificationOutcome ?? "N/A") : "FAIL").padEnd(19),
          item.finalStatePass ? "PASS" : "FAIL",
        ];
        console.log(columns.join(""));
      }
      console.log("\\nHard-gate summary");
      for (const [name, value] of Object.entries(report.metrics)) console.log(name + ": " + value);
      assertPhase4HardGates(report);
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "phase4-agent-eval-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outputFile.pathname,
});
const result = spawnSync(process.execPath, [outputFile.pathname], { stdio: "inherit" });
await rm(outputFile, { force: true });
process.exitCode = result.status ?? 1;
