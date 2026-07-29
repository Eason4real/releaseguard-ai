import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = new URL("../.sites-runtime/tests/", import.meta.url);
const outputFile = new URL("investigation-runtime.test.mjs", outputDirectory);

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [new URL("../tests/investigation-runtime.test.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outputFile.pathname,
  sourcemap: "inline",
});

const result = spawnSync(process.execPath, ["--test", outputFile.pathname], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    RELEASEGUARD_DEPLOYMENT_MODE: "PRIVATE_LIVE",
    RELEASEGUARD_SCHEMA_MODE: "LOCAL_AUTO",
  },
});
await rm(outputFile, { force: true });
process.exitCode = result.status ?? 1;
