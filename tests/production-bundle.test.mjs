import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

test("production bundle does not rewrite Planner modules to the Worker entry", async () => {
  const serverRoot = new URL("../dist/server/", import.meta.url);
  const files = await readdir(serverRoot, { recursive: true });
  const javascript = files.filter((name) => name.endsWith(".js"));
  const modules = await Promise.all(javascript.map(async (name) => ({
    name,
    source: await readFile(join(serverRoot.pathname, name), "utf8"),
  })));
  const worker = await readFile(new URL("index.js", serverRoot), "utf8");

  for (const builtModule of modules.filter((item) =>
    item.source.includes("DeterministicInvestigationPlanner"))) {
    assert.doesNotMatch(
      builtModule.source,
      /import\(["']\.\.\/index\.js["']\)/,
      `${builtModule.name} dynamically imports the Worker entry beside the Planner`,
    );
  }
  assert.match(worker, /new DeterministicInvestigationPlanner\(\)/);
  assert.match(worker, /handleInvestigatePost/);
});
