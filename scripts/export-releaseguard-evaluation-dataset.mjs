import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const buildDirectory = new URL(".sites-runtime/evaluation-export/", root);
const bundle = new URL("dataset.mjs", buildDirectory);
const outputDirectory = new URL("evaluation/dataset/", root);

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
  return value;
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

await mkdir(buildDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [new URL("../eval/investigation-benchmark/dataset/dev/index.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: bundle.pathname,
});

const { loadInvestigationBenchmarkDevDataset } = await import(
  `${pathToFileURL(bundle.pathname).href}?export=${Date.now()}`
);
const dataset = loadInvestigationBenchmarkDevDataset();
const fixtureByRef = new Map(dataset.fixtures.map((fixture) => [fixture.fixtureRef, fixture]));
const cases = dataset.manifest.caseEntries.map((entry) => {
  const fixture = fixtureByRef.get(entry.fixtureRef);
  if (!fixture) throw new Error(`MISSING_FIXTURE:${entry.fixtureRef}`);
  const benchmark = fixture.benchmarkCase;
  return {
    case_id: entry.caseId,
    incident_type: entry.category,
    source_class: entry.provenance.sourceType,
    public_source: entry.provenance.sourceReference ?? null,
    public_gold_basis: null,
    provenance_description: entry.provenance.description,
    initial_anomaly: benchmark.input,
    agent_accessible_sources: benchmark.dataSources,
    agent_accessible_observations: fixture.evidence.map((evidence) => {
      const observation = { ...evidence };
      delete observation.role;
      return observation;
    }),
    gold_root_cause: benchmark.groundTruth.canonicalRootCause,
    gold_root_cause_id: benchmark.groundTruth.canonicalRootCauseId,
    critical_evidence_ids: benchmark.groundTruth.requiredEvidenceIds,
    acceptable_equivalents: benchmark.groundTruth.acceptableAliases,
    unacceptable_statements: benchmark.groundTruth.rootCauseEvaluation.forbiddenConcepts,
    difficulty: entry.difficulty,
    difficulty_score: entry.difficultyScore,
    potential_answer_leakage: "Gold and fixture observations share an evaluator-owned source module.",
    leakage_control: "The harness projects a strict execution whitelist and removes Gold, evidence roles, case metadata, and provenance before Planner execution.",
    review_status: entry.manualReview,
  };
});

const frozen = {
  schema_version: "releaseguard-frozen-evaluation-dataset-v1",
  claim_boundary: "Offline reconstructed governed Dev cases; not 22 public incidents and not a Holdout set.",
  source_dataset: dataset.manifest,
  cases,
};
const json = `${JSON.stringify(stable(frozen), null, 2)}\n`;
const output = new URL("frozen-cases.json", outputDirectory);
await writeFile(output, json, { flag: "w" });

const files = [
  output,
  new URL("../config/scoring.json", outputDirectory),
  new URL("../config/model.json", outputDirectory),
];
const hashes = [];
for (const file of files) {
  const content = await readFile(file);
  hashes.push(`${createHash("sha256").update(content).digest("hex")}  ${file.pathname.split("/evaluation/")[1]}`);
}
await writeFile(new URL("SHA256SUMS", outputDirectory), `${hashes.join("\n")}\n`, { flag: "w" });
console.log(JSON.stringify({ caseCount: cases.length, frozenCasesSha256: sha256(json), hashes }, null, 2));
