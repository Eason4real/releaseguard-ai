import type { MetricBucket, MetricFilters, Release, RiskEvent } from "./types";

export type MetricQuery = {
  metricKey: string;
  startTime: string;
  endTime: string;
  filters?: MetricFilters;
};

export interface AnalyticsStore {
  upsertRelease(release: Release): Promise<void>;
  upsertMetricBuckets(buckets: MetricBucket[]): Promise<void>;
  saveRiskEvent(event: RiskEvent): Promise<RiskEvent>;
  getRelease(releaseId: string): Promise<Release | null>;
  getRiskEvent(riskEventId: string): Promise<RiskEvent | null>;
  getRiskEventBySignature(signature: string): Promise<RiskEvent | null>;
  queryMetricBuckets(query: MetricQuery): Promise<MetricBucket[]>;
}
