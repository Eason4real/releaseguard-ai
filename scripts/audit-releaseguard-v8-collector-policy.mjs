import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildEvidencePacketV2, evaluateEvidenceReadinessV2 } from
  "../lib/investigation/evidence-packet-v2.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(root, "evaluation/results/v8/smoke/input/agent-input.json");
const input = JSON.parse(await readFile(inputPath, "utf8"));
if (input.schemaVersion !== "releaseguard-v8-offline-smoke-agent-input-v1") {
  throw new Error("V8_COLLECTOR_AUDIT_INPUT_INVALID");
}

const audit = input.samples.map((sample) => {
  const readiness = evaluateEvidenceReadinessV2(sample.aggregate, 0);
  const packet = buildEvidencePacketV2(sample.aggregate, readiness);
  const byEvidence = new Map(packet.evidence.map((item) => [item.id, item]));
  const relations = sample.aggregate.hypothesisEvidenceLinks.map((link) => ({
    ...link,
    category: byEvidence.get(link.evidenceId)?.category ?? null,
  }));
  const releaseOnlySupport = [...new Set(relations
    .filter((link) => link.relation === "SUPPORTS" && link.category === "RELEASE_CHANGE")
    .map((link) => link.hypothesisId))].filter((hypothesisId) => !relations.some((link) =>
      link.hypothesisId === hypothesisId
      && link.relation === "SUPPORTS"
      && ["PRODUCT_METRIC", "SEGMENT_METRIC"].includes(link.category ?? "")));
  const explanationRelationMismatch = relations.filter((link) => {
    const explanation = String(link.explanation ?? "").toLowerCase();
    return link.relation !== "CONTRADICTS"
      && /(contradict|contradicting|反驳|相反|不支持)/i.test(explanation);
  }).map((link) => link.evidenceId);
  return {
    sampleId: sample.sampleId,
    readiness: readiness.status,
    readinessReasons: readiness.reasons,
    releaseOnlySupport,
    explanationRelationMismatch,
    evidenceCount: packet.evidence.length,
    factCount: packet.evidence.reduce((total, item) => total + item.facts.length, 0),
  };
});

const countBy = (values) => Object.fromEntries([...new Set(values)].sort()
  .map((value) => [value, values.filter((item) => item === value).length]));
const summary = {
  schemaVersion: "releaseguard-v8-collector-policy-audit-v1",
  boundary: "OFFLINE_AUDIT_OF_SANITIZED_AGENT_PLANE_AND_FROZEN_PUBLIC_TRAJECTORY",
  input: inputPath,
  samples: audit.length,
  readiness: countBy(audit.map((item) => item.readiness)),
  releaseOnlySupportCases: audit.filter((item) => item.releaseOnlySupport.length > 0).length,
  explanationRelationMismatchCases: audit
    .filter((item) => item.explanationRelationMismatch.length > 0).length,
  totalReleaseOnlySupport: audit.reduce((total, item) => total + item.releaseOnlySupport.length, 0),
  totalExplanationRelationMismatches: audit
    .reduce((total, item) => total + item.explanationRelationMismatch.length, 0),
  allPacketsHaveFacts: audit.every((item) => item.factCount > 0),
  cases: audit,
};
console.log(JSON.stringify(summary, null, 2));
