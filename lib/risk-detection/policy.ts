import type { MetricPolicy } from "../analytics/types";

export const couponClaimPolicy: MetricPolicy = {
  metricKey: "coupon_claim_success_rate",
  direction: "DOWN",
  granularityMinutes: 5,
  relativeThreshold: 0.15,
  minimumAbsoluteMovement: 0.01,
  minSampleSize: 500,
  requiredConsecutiveBuckets: 3,
  seasonalLookbackDays: 7,
  minimumSeasonalPoints: 5,
  recentFallbackBuckets: 12,
  minimumFallbackPoints: 8,
  noiseMultiplier: 3,
};

export const metricPolicies: Record<string, MetricPolicy> = {
  [couponClaimPolicy.metricKey]: couponClaimPolicy,
};
