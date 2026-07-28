import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = new URL("../.sites-runtime/public-corpus/", import.meta.url);
const outputFile = new URL("public-corpus-import.mjs", outputDirectory);
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [new URL("./public-corpus-import.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outputFile.pathname,
  external: ["cloudflare:workers"],
});
const result = spawnSync(process.execPath, [outputFile.pathname, ...process.argv.slice(2)], {
  stdio: "inherit",
});
await rm(outputFile, { force: true });
process.exitCode = result.status ?? 1;
