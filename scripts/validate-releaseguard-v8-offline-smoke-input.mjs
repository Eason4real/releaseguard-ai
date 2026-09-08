import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidencePacketV2, evaluateEvidenceReadinessV2 } from
  "../lib/investigation/evidence-packet-v2.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(root, "evaluation/results/v8/smoke/input/agent-input.json");
const inputBytes = await readFile(inputPath, "utf8");
const input = JSON.parse(inputBytes);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
if (input.schemaVersion !== "releaseguard-v8-offline-smoke-agent-input-v1"
  || input.expectedSamples !== 17 || input.samples?.length !== 17) {
  throw new Error("V8_SMOKE_AGENT_INPUT_INVALID");
}
if (/CASE-\d+|gold_root_cause|critical_evidence_ids|acceptable_equivalents|unacceptable_statements|review_status|difficulty_score|\"scoring\"/i.test(inputBytes)) {
  throw new Error("V8_SMOKE_AGENT_INPUT_LEAKAGE_DETECTED");
}
const currentIdentity = {
  datasetSha256: sha256(await readFile(resolve(root, "evaluation/dataset/frozen-cases.json"))),
  ablationSha256: sha256(await readFile(resolve(root, "evaluation/results/v7/ablation.json"))),
};
for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
  currentIdentity[`v7Run${runIndex}`] = sha256(await readFile(
    resolve(root, `evaluation/results/v7/raw/harness-v7-run-${runIndex}.json`)));
}
if (JSON.stringify(input.sourceIdentity) !== JSON.stringify(currentIdentity)) {
  throw new Error("V8_SMOKE_SOURCE_IDENTITY_MISMATCH");
}
const samples = input.samples.map((sample) => {
  const readiness = evaluateEvidenceReadinessV2(sample.aggregate, 0);
  const packet = buildEvidencePacketV2(sample.aggregate, readiness);
  const factCount = packet.evidence.reduce((total, item) => total + item.facts.length, 0);
  const emptyFactEvidence = packet.evidence.filter((item) => item.facts.length === 0).length;
  if (packet.evidence.length === 0 || factCount === 0 || emptyFactEvidence > 0) {
    throw new Error(`V8_SMOKE_PACKET_FACTS_INVALID:${sample.sampleId}`);
  }
  if (!sample.aggregate.toolCalls.every((call) => call.result?.output)) {
    throw new Error(`V8_SMOKE_TOOL_RESULT_OUTPUT_MISSING:${sample.sampleId}`);
  }
  return {
    sampleId: sample.sampleId,
    readiness: readiness.status,
    evidence: packet.evidence.length,
    facts: factCount,
  };
});
console.log(JSON.stringify({
  input: inputPath,
  samples: samples.length,
  evidence: samples.reduce((total, item) => total + item.evidence, 0),
  facts: samples.reduce((total, item) => total + item.facts, 0),
  readiness: Object.fromEntries([...new Set(samples.map((item) => item.readiness))]
    .sort().map((status) => [status, samples.filter((item) => item.readiness === status).length])),
  leakageDetected: false,
}, null, 2));
