import assert from "node:assert/strict";
import test from "node:test";
import type { AggregatedMetricBucket } from "../lib/analytics/types";
import {
  MemoryAnalyticsStore,
  ensureAndroid730RiskEvent,
} from "../lib/fixtures/android-730";
import { evaluateRiskWindow } from "../lib/risk-detection/detector";
import { couponClaimPolicy } from "../lib/risk-detection/policy";

const bucket = (
  start: string,
  value: number,
  sampleSize = 800,
): AggregatedMetricBucket => ({
  bucketStart: start,
  bucketEnd: new Date(new Date(start).getTime() + 300_000).toISOString(),
  value,
  numerator: Math.round(value * sampleSize),
  denominator: sampleSize,
  sampleSize,
  sourceBucketIds: [`B-${start}`],
});

const history = Array.from({ length: 8 }, (_, index) =>
  bucket(new Date(Date.UTC(2026, 6, 18 + index, 2, 5)).toISOString(), 0.958 + (index % 3) * 0.002)
);
const candidates = [0.79, 0.77, 0.78].map((value, index) =>
  bucket(new Date(Date.UTC(2026, 6, 26, 2, 5 + index * 5)).toISOString(), value)
);
const evaluate = (items: AggregatedMetricBucket[]) => evaluateRiskWindow({
  metricKey: "coupon_claim_success_rate",
  releaseId: "REL-ANDROID-730",
  filters: { platform: "Android", appVersion: "7.3.0" },
  buckets: items,
  policy: couponClaimPolicy,
  detectedAt: "2026-07-26T02:22:00.000Z",
});

test("Risk Detector only triggers after three adjacent qualified buckets", () => {
  assert.equal(evaluate([...history, candidates[0]]), null);
  assert.equal(evaluate([...history, ...candidates.slice(0, 2)]), null);
  const event = evaluate([...history, ...candidates]);
  assert.ok(event);
  assert.equal(event.requiredConsecutiveBuckets, 3);
  assert.equal(event.baselineMethod, "SEASONAL_MEDIAN");
  assert.ok(event.relativeDeviation > 0.15);
});

test("low sample, missing window, isolated spike and normal noise do not trigger", () => {
  const lowSample = candidates.map((item, index) =>
    index === 1 ? { ...item, sampleSize: 40, denominator: 40, numerator: 10 } : item
  );
  assert.equal(evaluate([...history, ...lowSample]), null);
  assert.equal(evaluate([...history, candidates[0], candidates[2]]), null);
  assert.equal(evaluate([...history, candidates[0], bucket(candidates[1].bucketStart, 0.96), candidates[2]]), null);
  const noise = candidates.map((item) => ({ ...item, value: 0.952, numerator: 762 }));
  assert.equal(evaluate([...history, ...noise]), null);
});

test("deterministic fixture persists one idempotent RiskEvent", async () => {
  const store = new MemoryAnalyticsStore();
  const first = await ensureAndroid730RiskEvent(store);
  const second = await ensureAndroid730RiskEvent(store);
  assert.equal(first.event.id, second.event.id);
  assert.equal(store.events.size, 1);
  assert.equal(first.event.sampleSize, 2_400);
  assert.equal(first.event.status, "OPEN");
});
