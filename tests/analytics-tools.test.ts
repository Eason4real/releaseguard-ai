import assert from "node:assert/strict";
import test from "node:test";
import {
  ANDROID_730_RELEASE_ID,
  MemoryAnalyticsStore,
  ensureAndroid730RiskEvent,
} from "../lib/fixtures/android-730";
import { executeNamedTool, modelToolDefinitions } from "../lib/investigation/tools";

test("formal analytics tool contracts are the only metric/release tools exposed to the model", () => {
  const names = modelToolDefinitions.map((item) => item.function.name);
  assert.ok(names.includes("get_release"));
  assert.ok(names.includes("query_metric"));
  assert.ok(names.includes("segment_metric"));
  assert.ok(!names.includes("query_metrics"));
  assert.ok(!names.includes("inspect_release_diff"));
});

test("get_release returns structured success and empty results", async () => {
  const analytics = new MemoryAnalyticsStore();
  const { event, release } = await ensureAndroid730RiskEvent(analytics);
  const found = await executeNamedTool(
    "get_release",
    { release_id: ANDROID_730_RELEASE_ID },
    { analytics, riskEvent: event, release },
  );
  assert.equal(found.status, "SUCCESS");
  assert.equal(
    ((found.output as { data: { version: string } }).data.version),
    "7.3.0",
  );
  const missing = await executeNamedTool(
    "get_release",
    { release_id: "REL-MISSING" },
    { analytics, riskEvent: event, release },
  );
  assert.equal(missing.status, "EMPTY");
});

test("query_metric uses weighted aggregation and persists baseline metadata", async () => {
  const analytics = new MemoryAnalyticsStore();
  const { event, release } = await ensureAndroid730RiskEvent(analytics);
  const result = await executeNamedTool("query_metric", {
    metric_key: event.metricKey,
    start_time: event.firstBreachedAt,
    end_time: event.lastBreachedAt,
    filters: event.filters,
    granularity_minutes: 5,
    include_baseline: true,
  }, { analytics, riskEvent: event, release });
  assert.equal(result.status, "SUCCESS");
  const output = result.output as {
    data: {
      summary: { numerator: number; denominator: number; value: number; baseline: number };
      baseline: { method: string };
    };
  };
  assert.equal(output.data.summary.value, output.data.summary.numerator / output.data.summary.denominator);
  assert.equal(output.data.summary.baseline, event.baselineValue);
  assert.equal(output.data.baseline.method, "SEASONAL_MEDIAN");
});

test("segment_metric isolates app versions and marks sample quality", async () => {
  const analytics = new MemoryAnalyticsStore();
  const { event, release } = await ensureAndroid730RiskEvent(analytics);
  const result = await executeNamedTool("segment_metric", {
    metric_key: event.metricKey,
    start_time: event.firstBreachedAt,
    end_time: event.lastBreachedAt,
    filters: { platform: "Android" },
    dimension: "app_version",
    limit: 10,
  }, { analytics, riskEvent: event, release });
  assert.equal(result.status, "SUCCESS");
  const breakdown = (result.output as {
    data: { breakdown: Array<{ segment_value: string; data_quality: string; value: number }> };
  }).data.breakdown;
  assert.deepEqual(new Set(breakdown.map((item) => item.segment_value)), new Set(["7.3.0", "7.2.9"]));
  assert.ok(breakdown.every((item) => item.data_quality === "OK"));
  assert.ok(breakdown.find((item) => item.segment_value === "7.3.0")!.value < 0.8);
  assert.ok(breakdown.find((item) => item.segment_value === "7.2.9")!.value > 0.95);
});

test("analytics tools return EMPTY and ERROR without throwing", async () => {
  const analytics = new MemoryAnalyticsStore();
  const { event, release } = await ensureAndroid730RiskEvent(analytics);
  const empty = await executeNamedTool("query_metric", {
    metric_key: event.metricKey,
    start_time: "2026-07-26T05:00:00.000Z",
    end_time: "2026-07-26T06:00:00.000Z",
    filters: event.filters,
    granularity_minutes: 5,
  }, { analytics, riskEvent: event, release });
  assert.equal(empty.status, "EMPTY");
  const invalid = await executeNamedTool("query_metric", {
    metric_key: event.metricKey,
    start_time: event.firstBreachedAt,
    end_time: event.lastBreachedAt,
    filters: { forbidden: "value" },
    granularity_minutes: 5,
  }, { analytics, riskEvent: event, release });
  assert.equal(invalid.status, "ERROR");
});
