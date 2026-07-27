export type MetricFilters = {
  platform?: string;
  appVersion?: string;
  region?: string;
  userType?: string;
};

export type Release = {
  id: string;
  version: string;
  platform: string;
  releasedAt: string;
  rolloutStatus: string;
  rolloutPercentage: number;
  featureFlags: string[];
  changedModules: string[];
  provenance: string;
  createdAt: string;
};

export type MetricBucket = {
  id: string;
  metricKey: string;
  bucketStart: string;
  bucketEnd: string;
  granularityMinutes: number;
  numerator: number | null;
  denominator: number | null;
  value: number;
  sampleSize: number;
  platform: string | null;
  appVersion: string | null;
  region: string | null;
  userType: string | null;
  dimensionSignature: string;
  releaseId: string | null;
  provenance: string;
  createdAt: string;
};

export type RiskEvent = {
  id: string;
  correlatedReleaseId: string | null;
  metricKey: string;
  status: "OPEN" | "INVESTIGATING";
  direction: "DOWN" | "UP";
  filters: MetricFilters;
  segmentSignature: string;
  detectedAt: string;
  firstBreachedAt: string;
  lastBreachedAt: string;
  observedValue: number;
  baselineValue: number;
  absoluteDeviation: number;
  relativeDeviation: number;
  sampleSize: number;
  thresholdPct: number;
  minSampleSize: number;
  requiredConsecutiveBuckets: number;
  triggerBucketIds: string[];
  baselineMethod: "SEASONAL_MEDIAN" | "RECENT_MEDIAN";
  baselinePointCount: number;
  triggerSignature: string;
  provenance: string;
  createdAt: string;
  updatedAt: string;
};

export type AggregatedMetricBucket = {
  bucketStart: string;
  bucketEnd: string;
  value: number;
  numerator: number | null;
  denominator: number | null;
  sampleSize: number;
  sourceBucketIds: string[];
};

export type MetricPolicy = {
  metricKey: string;
  direction: "DOWN" | "UP";
  granularityMinutes: number;
  relativeThreshold: number;
  minimumAbsoluteMovement: number;
  minSampleSize: number;
  requiredConsecutiveBuckets: number;
  seasonalLookbackDays: number;
  minimumSeasonalPoints: number;
  recentFallbackBuckets: number;
  minimumFallbackPoints: number;
  noiseMultiplier: number;
};

export type BaselineResult = {
  value: number;
  method: "SEASONAL_MEDIAN" | "RECENT_MEDIAN";
  pointCount: number;
  robustSigma: number;
};
