import assert from "node:assert/strict";
import test from "node:test";
import { calculateHypothesisConfidence } from "../lib/investigation/confidence";
import type {
  Evidence,
  EvidenceRelation,
  HypothesisEvidenceLink,
} from "../lib/investigation/types";

const evidence = (
  id: string,
  category: string,
  source: string,
  provenance: Evidence["provenance"] = "derived",
): Evidence => ({
  id,
  runId: "RUN-P4",
  toolResultId: `TR-${id}`,
  category,
  statement: `${category} evidence`,
  source,
  strength: "HIGH",
  provenance,
  collectedAt: "2026-07-27T00:00:00.000Z",
});

const link = (
  item: Evidence,
  relation: EvidenceRelation,
): HypothesisEvidenceLink => ({
  id: `HEL-${item.id}`,
  runId: item.runId,
  hypothesisId: "HYP-P4",
  evidenceId: item.id,
  relation,
  explanation: "explicit assessment",
  linkedBy: "AGENT",
  createdAt: item.collectedAt,
});

test("NEUTRAL evidence does not increase hypothesis scores", () => {
  const item = evidence("NEUTRAL", "PRODUCT_METRIC", "Product Analytics D1");
  const result = calculateHypothesisConfidence([item], [link(item, "NEUTRAL")]);
  assert.equal(result.supportScore, 0);
  assert.equal(result.contradictionScore, 0);
  assert.equal(result.confidence, "LOW");
  assert.equal(result.status, "ACTIVE");
});

test("CONTRADICTS lowers confidence and strong current-event contradiction rejects", () => {
  const supporting = [
    evidence("METRIC", "PRODUCT_METRIC", "Product Analytics D1"),
    evidence("RELEASE", "RELEASE_CHANGE", "Release Registry"),
    evidence("FEEDBACK", "USER_FEEDBACK", "Feedback Index"),
  ];
  const high = calculateHypothesisConfidence(
    supporting,
    supporting.map((item) => link(item, "SUPPORTS")),
  );
  assert.equal(high.confidence, "HIGH");

  const contradictions = [
    evidence("CONTRA-1", "USER_FEEDBACK", "Support Desk"),
    evidence("CONTRA-2", "USER_FEEDBACK", "Community"),
    evidence("CONTRA-3", "USER_FEEDBACK", "Feedback Survey"),
  ];
  const weakened = calculateHypothesisConfidence(
    [...supporting, ...contradictions],
    [
      ...supporting.map((item) => link(item, "SUPPORTS")),
      ...contradictions.map((item) => link(item, "CONTRADICTS")),
    ],
  );
  assert.equal(weakened.contradictionScore, 6);
  assert.equal(weakened.confidence, "MEDIUM");
  assert.equal(weakened.status, "SUPPORTED");

  const segmentContradiction = evidence(
    "SEGMENT-CONTRA",
    "SEGMENT_METRIC",
    "Product Analytics D1",
  );
  const rejected = calculateHypothesisConfidence(
    [...supporting, segmentContradiction],
    [
      ...supporting.map((item) => link(item, "SUPPORTS")),
      link(segmentContradiction, "CONTRADICTS"),
    ],
  );
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.confidence, "LOW");
});

test("RAG-only support cannot produce HIGH or CONFIRMED", () => {
  const rag = evidence(
    "RAG",
    "SIMILAR_INCIDENT",
    "Incident Knowledge Base",
    "public_reference",
  );
  const result = calculateHypothesisConfidence([rag], [link(rag, "SUPPORTS")]);
  assert.equal(result.supportScore, 1);
  assert.equal(result.confidence, "LOW");
  assert.equal(result.status, "SUPPORTED");
});

test("HIGH remains SUPPORTED without mechanism evidence and becomes CONFIRMED with it", () => {
  const impact = evidence("IMPACT", "PRODUCT_METRIC", "Product Analytics D1");
  const release = evidence("CHANGE", "RELEASE_CHANGE", "Release Registry");
  const feedback = evidence("USER", "USER_FEEDBACK", "Feedback Index");
  const withoutMechanism = [impact, release, feedback];
  const supported = calculateHypothesisConfidence(
    withoutMechanism,
    withoutMechanism.map((item) => link(item, "SUPPORTS")),
  );
  assert.equal(supported.confidence, "HIGH");
  assert.equal(supported.status, "SUPPORTED");
  assert.match(supported.confidenceReason, /机制证据 无/);

  const mechanism = evidence("MECHANISM", "SYSTEM_EVENT", "Current Incident Runtime");
  const withMechanism = [...withoutMechanism, mechanism];
  const confirmed = calculateHypothesisConfidence(
    withMechanism,
    withMechanism.map((item) => link(item, "SUPPORTS")),
  );
  assert.equal(confirmed.confidence, "HIGH");
  assert.equal(confirmed.status, "CONFIRMED");
});
