import type {
  AggregatedMetricBucket,
  BaselineResult,
  MetricPolicy,
} from "../analytics/types";

export const median = (values: number[]) => {
  if (values.length === 0) throw new Error("Cannot calculate median of an empty list");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const sameSydneyMinute = (left: string, right: string) => {
  const parts = (value: string) => new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
  return parts(left) === parts(right);
};

export function calculateBaseline(
  history: AggregatedMetricBucket[],
  candidateStart: string,
  policy: MetricPolicy,
): BaselineResult | null {
  const candidateTime = new Date(candidateStart).getTime();
  const seasonalCutoff = candidateTime - policy.seasonalLookbackDays * 86_400_000;
  const seasonal = history.filter((bucket) => {
    const time = new Date(bucket.bucketStart).getTime();
    return time < candidateTime
      && time >= seasonalCutoff
      && sameSydneyMinute(bucket.bucketStart, candidateStart);
  });
  const selected = seasonal.length >= policy.minimumSeasonalPoints
    ? seasonal
    : history.filter((bucket) => new Date(bucket.bucketStart).getTime() < candidateTime)
      .slice(-policy.recentFallbackBuckets);
  const method = seasonal.length >= policy.minimumSeasonalPoints
    ? "SEASONAL_MEDIAN"
    : "RECENT_MEDIAN";
  const minimum = method === "SEASONAL_MEDIAN"
    ? policy.minimumSeasonalPoints
    : policy.minimumFallbackPoints;
  if (selected.length < minimum) return null;
  const values = selected.map((bucket) => bucket.value);
  const value = median(values);
  const absoluteDeviations = values.map((point) => Math.abs(point - value));
  return {
    value,
    method,
    pointCount: values.length,
    robustSigma: 1.4826 * median(absoluteDeviations),
  };
}

export function samplingSigma(baseline: number, sampleSize: number) {
  if (sampleSize <= 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt(Math.max(0, baseline * (1 - baseline)) / sampleSize);
}
