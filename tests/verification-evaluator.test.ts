import assert from "node:assert/strict";
import test from "node:test";
import { evaluateVerification } from "../lib/investigation/verification-evaluator";
import {
  verificationBuckets,
  verificationPolicyFixture,
  verificationScenarioFixtures,
} from "./fixtures/verification-scenarios";

const evaluate = (overrides: Partial<Parameters<typeof evaluateVerification>[0]> = {}) =>
  evaluateVerification({
    runId: "RUN-fixture",
    verificationRunId: "VR-fixture",
    policy: verificationPolicyFixture(),
    affectedBuckets: verificationBuckets(Array(24).fill(0.95)),
    createdAt: "2026-07-28T03:00:00.000Z",
    ...overrides,
  });

test("P4.3B deterministic scenarios produce the frozen expected outcomes", () => {
  for (const scenario of verificationScenarioFixtures) {
    const result = evaluate({ affectedBuckets: scenario.buckets });
    assert.equal(result.outcome, scenario.expectedOutcome, scenario.id);
  }
});

test("P4.3B incomplete, empty, and low-sample windows are inconclusive", () => {
  assert.equal(evaluate({ affectedBuckets: [] }).outcome, "INCONCLUSIVE");
  assert.equal(evaluate({ affectedBuckets: verificationBuckets(Array(23).fill(1)) }).outcome,
    "INCONCLUSIVE");
  assert.equal(evaluate({ affectedBuckets: verificationBuckets(Array(24).fill(1), { sampleSize: 99 }) }).outcome,
    "INCONCLUSIVE");
  assert.equal(evaluate({ affectedBuckets: verificationBuckets(Array(24).fill(1), { startOffset: 1 }) }).outcome,
    "INCONCLUSIVE");
});

test("P4.3B required consecutive buckets participate in recovery", () => {
  const values = [...Array(21).fill(0.95), 0.95, 0.7, 0.95];
  const result = evaluate({ affectedBuckets: verificationBuckets(values) });
  assert.notEqual(result.outcome, "RESOLVED");
  assert.equal(result.evidence[0].details.consecutiveRecovered, false);
});

test("P4.3B control is evaluated only when frozen policy requires it", () => {
  const withoutControl = evaluate();
  assert.equal(withoutControl.evidence.some((item) => item.kind === "CONTROL_METRIC"), false);
  const policy = verificationPolicyFixture({
    controlFilters: { platform: "IOS" }, controlBaselineValue: 1,
  });
  const withControl = evaluate({
    policy,
    controlBuckets: verificationBuckets(Array(24).fill(0.5), { filters: { platform: "IOS" } }),
  });
  assert.equal(withControl.outcome, "PARTIALLY_RESOLVED");
  assert.equal(withControl.evidence.some((item) => item.kind === "CONTROL_METRIC"), true);
  const affectedStillBroken = evaluate({
    policy,
    affectedBuckets: verificationBuckets(Array(24).fill(0.5)),
    controlBuckets: verificationBuckets(Array(24).fill(1), { filters: { platform: "IOS" } }),
  });
  assert.equal(affectedStillBroken.outcome, "NOT_RECOVERED");
});

test("P4.3B required feedback blocks resolution and insufficient feedback is inconclusive", () => {
  const policy = verificationPolicyFixture({ feedbackRequired: true });
  const feedback = (prefix: string, count: number, negative: number, hour: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      timestamp: `2026-07-28T${String(hour).padStart(2, "0")}:${String(index).padStart(2, "0")}:00.000Z`,
      tags: index < negative ? ["complaint"] : ["positive"],
      source: "fixture", sourceReference: `${prefix}-${index}`,
    }));
  const reference = feedback("before", 10, 8, 0);
  const unrecovered = feedback("after", 10, 8, 1);
  assert.equal(evaluate({ policy, feedbackReference: reference, feedbackObserved: unrecovered }).outcome,
    "PARTIALLY_RESOLVED");
  assert.equal(evaluate({ policy, feedbackReference: reference, feedbackObserved: unrecovered.slice(0, 4) }).outcome,
    "INCONCLUSIVE");
  const recovered = feedback("recovered", 10, 2, 1);
  assert.equal(evaluate({ policy, feedbackReference: reference, feedbackObserved: recovered }).outcome,
    "RESOLVED");
});

test("P4.3B UP-direction recovery uses inverse baseline ratio", () => {
  const policy = verificationPolicyFixture({ direction: "UP", baselineValue: 1, incidentObservedValue: 2 });
  assert.equal(evaluate({ policy, affectedBuckets: verificationBuckets(Array(24).fill(1.05)) }).outcome,
    "RESOLVED");
});

test("P4.3B raw bucket validation rejects duplicate, overlap, and malformed boundaries", () => {
  const duplicate = verificationBuckets(Array(24).fill(0.95));
  duplicate[1] = { ...duplicate[1], bucketStart: duplicate[0].bucketStart };
  const duplicateResult = evaluate({ affectedBuckets: duplicate });
  assert.equal(duplicateResult.outcome, "INCONCLUSIVE");
  assert.ok((duplicateResult.evidence[0].details.reasonCodes as string[])
    .includes("DUPLICATE_BUCKET_START"));

  const overlap = verificationBuckets(Array(24).fill(0.95));
  overlap[1] = { ...overlap[1], bucketStart: new Date(Date.parse(overlap[1].bucketStart) - 60_000).toISOString() };
  assert.equal(evaluate({ affectedBuckets: overlap }).outcome, "INCONCLUSIVE");

  const wrongEnd = verificationBuckets(Array(24).fill(0.95));
  wrongEnd[4] = { ...wrongEnd[4], bucketEnd: new Date(Date.parse(wrongEnd[4].bucketEnd) + 60_000).toISOString() };
  assert.equal(evaluate({ affectedBuckets: wrongEnd }).outcome, "INCONCLUSIVE");

  const wrongGranularity = verificationBuckets(Array(24).fill(0.95));
  wrongGranularity[3] = { ...wrongGranularity[3], granularityMinutes: 10 };
  assert.equal(evaluate({ affectedBuckets: wrongGranularity }).outcome, "INCONCLUSIVE");
});

test("P4.3B raw bucket validation rejects missing, extra, gaps, and window misalignment", () => {
  const complete = verificationBuckets(Array(24).fill(0.95));
  assert.equal(evaluate({ affectedBuckets: complete }).outcome, "RESOLVED");
  assert.equal(evaluate({ affectedBuckets: complete.filter((_, index) => index !== 10) }).outcome,
    "INCONCLUSIVE");
  const extra = [...complete, {
    ...complete.at(-1)!, id: "MB-extra", bucketStart: complete.at(-1)!.bucketEnd,
    bucketEnd: new Date(Date.parse(complete.at(-1)!.bucketEnd) + 5 * 60_000).toISOString(),
  }];
  assert.equal(evaluate({ affectedBuckets: extra }).outcome, "INCONCLUSIVE");
  assert.equal(evaluate({ affectedBuckets: verificationBuckets(Array(24).fill(0.95), { startOffset: 1 }) }).outcome,
    "INCONCLUSIVE");
  const gap = verificationBuckets(Array(24).fill(0.95));
  gap[10] = { ...gap[10], bucketStart: new Date(Date.parse(gap[10].bucketStart) + 60_000).toISOString(),
    bucketEnd: new Date(Date.parse(gap[10].bucketEnd) + 60_000).toISOString() };
  assert.equal(evaluate({ affectedBuckets: gap }).outcome, "INCONCLUSIVE");
});

test("P4.3B numeric safety makes invalid policy and metric values inconclusive", () => {
  for (const baselineValue of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = evaluate({ policy: verificationPolicyFixture({ baselineValue }) });
    assert.equal(result.outcome, "INCONCLUSIVE");
    assert.equal(result.reasonCode, "INVALID_POLICY");
  }
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = evaluate({ affectedBuckets: verificationBuckets([value, ...Array(23).fill(0.95)]) });
    assert.equal(result.outcome, "INCONCLUSIVE");
    assert.equal(result.evidence[0].qualityStatus, "INVALID_DATA");
  }
  const invalidSample = verificationBuckets(Array(24).fill(0.95));
  invalidSample[0] = { ...invalidSample[0], sampleSize: 1.5 };
  assert.equal(evaluate({ affectedBuckets: invalidSample }).outcome, "INCONCLUSIVE");
});

test("P4.3B recovery ratio handles zero and floating boundaries deterministically", () => {
  assert.equal(evaluate({ affectedBuckets: verificationBuckets(Array(24).fill(0)) }).outcome,
    "NOT_RECOVERED");
  assert.equal(evaluate({
    affectedBuckets: verificationBuckets(Array(24).fill(0.9 - Number.EPSILON)),
  }).outcome, "RESOLVED");
  assert.equal(evaluate({
    policy: verificationPolicyFixture({ direction: "UP", baselineValue: 1, incidentObservedValue: 2 }),
    affectedBuckets: verificationBuckets(Array(24).fill(0)),
  }).outcome, "INCONCLUSIVE");
});

test("P4.3B partial outcome requires the frozen minimum meaningful improvement", () => {
  const tiny = evaluate({ affectedBuckets: verificationBuckets(Array(24).fill(0.500001)) });
  assert.equal(tiny.outcome, "NOT_RECOVERED");
  const boundary = evaluate({ affectedBuckets: verificationBuckets(Array(24).fill(0.55 - Number.EPSILON)) });
  assert.equal(boundary.outcome, "PARTIALLY_RESOLVED");
  assert.equal(boundary.result.minimumImprovementThreshold, 0.05);
});
