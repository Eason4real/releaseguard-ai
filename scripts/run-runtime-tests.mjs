import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = new URL("../.sites-runtime/tests/", import.meta.url);
const testNames = [
  "investigation-runtime",
  "public-demo-replay",
  "investigation-benchmark-scorer",
];
const outputFiles = testNames.map((name) => new URL(`${name}.test.mjs`, outputDirectory));

await mkdir(outputDirectory, { recursive: true });
await Promise.all(testNames.map((name, index) => build({
  entryPoints: [new URL(`../tests/${name}.test.ts`, import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outputFiles[index].pathname,
  sourcemap: "inline",
})));

const result = spawnSync(process.execPath, ["--test", ...outputFiles.map((file) => file.pathname)], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    RELEASEGUARD_DEPLOYMENT_MODE: "PRIVATE_LIVE",
    RELEASEGUARD_SCHEMA_MODE: "LOCAL_AUTO",
  },
});
await Promise.all(outputFiles.map((file) => rm(file, { force: true })));
process.exitCode = result.status ?? 1;
