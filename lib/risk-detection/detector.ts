import type { AnalyticsStore } from "../analytics/store";
import type {
  AggregatedMetricBucket,
  MetricBucket,
  MetricFilters,
  MetricPolicy,
  RiskEvent,
} from "../analytics/types";
import { calculateBaseline, samplingSigma } from "./baseline";

export function aggregateBucketFacts(facts: MetricBucket[]): AggregatedMetricBucket[] {
  const groups = new Map<string, MetricBucket[]>();
  for (const fact of facts) {
    const group = groups.get(fact.bucketStart) ?? [];
    group.push(fact);
    groups.set(fact.bucketStart, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
    ([bucketStart, group]) => {
      const numerator = group.every((item) => item.numerator !== null)
        ? group.reduce((sum, item) => sum + (item.numerator ?? 0), 0)
        : null;
      const denominator = group.every((item) => item.denominator !== null)
        ? group.reduce((sum, item) => sum + (item.denominator ?? 0), 0)
        : null;
      const sampleSize = group.reduce((sum, item) => sum + item.sampleSize, 0);
      const value = numerator !== null && denominator
        ? numerator / denominator
        : group.reduce((sum, item) => sum + item.value * item.sampleSize, 0) / sampleSize;
      return {
        bucketStart,
        bucketEnd: group[0].bucketEnd,
        value,
        numerator,
        denominator,
        sampleSize,
        sourceBucketIds: group.map((item) => item.id),
      };
    },
  );
}

const filtersSignature = (filters: MetricFilters) =>
  Object.entries(filters).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join("|");

export function evaluateRiskWindow(input: {
  metricKey: string;
  releaseId: string | null;
  filters: MetricFilters;
  buckets: AggregatedMetricBucket[];
  policy: MetricPolicy;
  detectedAt: string;
}): RiskEvent | null {
  const { buckets, policy } = input;
  if (buckets.length < policy.requiredConsecutiveBuckets) return null;
  const candidates = buckets.slice(-policy.requiredConsecutiveBuckets);
  const interval = policy.granularityMinutes * 60_000;
  for (let index = 1; index < candidates.length; index += 1) {
    if (
      new Date(candidates[index].bucketStart).getTime()
      - new Date(candidates[index - 1].bucketStart).getTime()
      !== interval
    ) return null;
  }
  const firstCandidate = candidates[0];
  const history = buckets.filter((bucket) => bucket.bucketStart < firstCandidate.bucketStart);
  const baseline = calculateBaseline(history, firstCandidate.bucketStart, policy);
  if (!baseline) return null;
  for (const candidate of candidates) {
    if (candidate.sampleSize < policy.minSampleSize) return null;
    const absolute = policy.direction === "DOWN"
      ? baseline.value - candidate.value
      : candidate.value - baseline.value;
    const relative = baseline.value > 0 ? absolute / baseline.value : 0;
    const noiseFloor = Math.max(
      policy.minimumAbsoluteMovement,
      policy.noiseMultiplier * baseline.robustSigma,
      policy.noiseMultiplier * samplingSigma(baseline.value, candidate.sampleSize),
    );
    if (relative < policy.relativeThreshold || absolute < noiseFloor) return null;
  }
  const observedNumerator = candidates.every((item) => item.numerator !== null)
    ? candidates.reduce((sum, item) => sum + (item.numerator ?? 0), 0)
    : null;
  const observedDenominator = candidates.every((item) => item.denominator !== null)
    ? candidates.reduce((sum, item) => sum + (item.denominator ?? 0), 0)
    : null;
  const sampleSize = candidates.reduce((sum, item) => sum + item.sampleSize, 0);
  const observedValue = observedNumerator !== null && observedDenominator
    ? observedNumerator / observedDenominator
    : candidates.reduce((sum, item) => sum + item.value * item.sampleSize, 0) / sampleSize;
  const absoluteDeviation = Math.abs(observedValue - baseline.value);
  const segmentSignature = filtersSignature(input.filters);
  const triggerSignature = [
    input.metricKey,
    segmentSignature,
    input.releaseId ?? "no-release",
    firstCandidate.bucketStart,
  ].join("::");
  return {
    id: `RISK-${crypto.randomUUID()}`,
    correlatedReleaseId: input.releaseId,
    metricKey: input.metricKey,
    status: "OPEN",
    direction: policy.direction,
    filters: input.filters,
    segmentSignature,
    detectedAt: input.detectedAt,
    firstBreachedAt: firstCandidate.bucketStart,
    lastBreachedAt: candidates.at(-1)!.bucketEnd,
    observedValue,
    baselineValue: baseline.value,
    absoluteDeviation,
    relativeDeviation: baseline.value ? absoluteDeviation / baseline.value : 0,
    sampleSize,
    thresholdPct: policy.relativeThreshold,
    minSampleSize: policy.minSampleSize,
    requiredConsecutiveBuckets: policy.requiredConsecutiveBuckets,
    triggerBucketIds: candidates.flatMap((item) => item.sourceBucketIds),
    baselineMethod: baseline.method,
    baselinePointCount: baseline.pointCount,
    triggerSignature,
    provenance: "deterministic_detector",
    createdAt: input.detectedAt,
    updatedAt: input.detectedAt,
  };
}

export async function detectAndPersistRiskEvent(
  store: AnalyticsStore,
  input: {
    metricKey: string;
    releaseId: string | null;
    filters: MetricFilters;
    startTime: string;
    endTime: string;
    policy: MetricPolicy;
    detectedAt: string;
  },
) {
  const facts = await store.queryMetricBuckets(input);
  const event = evaluateRiskWindow({
    ...input,
    buckets: aggregateBucketFacts(facts),
  });
  return event ? store.saveRiskEvent(event) : null;
}
