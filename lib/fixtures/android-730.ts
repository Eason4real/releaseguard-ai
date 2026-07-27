import type { AnalyticsStore, MetricQuery } from "../analytics/store";
import type { MetricBucket, Release, RiskEvent } from "../analytics/types";
import { detectAndPersistRiskEvent } from "../risk-detection/detector";
import { couponClaimPolicy } from "../risk-detection/policy";

export const ANDROID_730_RELEASE_ID = "REL-ANDROID-730";
export const ANDROID_730_METRIC = "coupon_claim_success_rate";
export const ANDROID_730_RELEASED_AT = "2026-07-26T02:00:00.000Z";
export const ANDROID_730_DETECTED_AT = "2026-07-26T02:22:00.000Z";
export const ANDROID_730_MONITOR_FILTERS = {
  platform: "Android",
  appVersion: "7.3.0",
} as const;

const release: Release = {
  id: ANDROID_730_RELEASE_ID,
  version: "7.3.0",
  platform: "Android",
  releasedAt: ANDROID_730_RELEASED_AT,
  rolloutStatus: "FULL",
  rolloutPercentage: 100,
  featureFlags: ["coupon_claim_server_retry"],
  changedModules: ["CouponClaimService", "IdempotencyGuard"],
  provenance: "deterministic_fixture",
  createdAt: "2026-07-26T01:55:00.000Z",
};

const segments = [
  { region: "AU", userType: "NEW", weight: 250 },
  { region: "AU", userType: "RETURNING", weight: 300 },
  { region: "US", userType: "RETURNING", weight: 250 },
] as const;

const iso = (time: number) => new Date(time).toISOString();
const fiveMinutes = 5 * 60_000;

function makeFact(input: {
  key: string;
  start: string;
  rate: number;
  denominator: number;
  platform: string;
  appVersion: string;
  region: string;
  userType: string;
  releaseId?: string | null;
}): MetricBucket {
  const numerator = Math.round(input.denominator * input.rate);
  const dimensionSignature = [
    `platform=${input.platform}`,
    `appVersion=${input.appVersion}`,
    `region=${input.region}`,
    `userType=${input.userType}`,
  ].join("|");
  return {
    id: `MB-${input.key}-${input.platform}-${input.appVersion}-${input.region}-${input.userType}`,
    metricKey: ANDROID_730_METRIC,
    bucketStart: input.start,
    bucketEnd: iso(new Date(input.start).getTime() + fiveMinutes),
    granularityMinutes: 5,
    numerator,
    denominator: input.denominator,
    value: numerator / input.denominator,
    sampleSize: input.denominator,
    platform: input.platform,
    appVersion: input.appVersion,
    region: input.region,
    userType: input.userType,
    dimensionSignature,
    releaseId: input.releaseId ?? null,
    provenance: "deterministic_fixture",
    createdAt: "2026-07-26T02:21:00.000Z",
  };
}

export function android730FixtureBuckets() {
  const buckets: MetricBucket[] = [];
  const releaseTime = new Date(ANDROID_730_RELEASED_AT).getTime();

  for (let day = 7; day >= 1; day -= 1) {
    const start = iso(releaseTime - day * 86_400_000 + fiveMinutes);
    const rate = 0.958 + (day % 4) * 0.002;
    segments.forEach((segment, index) => buckets.push(makeFact({
      key: `season-${day}-${index}`,
      start,
      rate,
      denominator: segment.weight,
      platform: "Android",
      appVersion: "7.3.0",
      region: segment.region,
      userType: segment.userType,
      releaseId: ANDROID_730_RELEASE_ID,
    })));
  }

  for (let index = 12; index >= 1; index -= 1) {
    const start = iso(releaseTime - index * fiveMinutes);
    const rate = index === 8 ? 0.78 : 0.96 + ((index % 3) - 1) * 0.002;
    const lowSample = index === 5;
    segments.forEach((segment, segmentIndex) => buckets.push(makeFact({
      key: `pre-${index}-${segmentIndex}`,
      start,
      rate: lowSample ? 0.55 : rate,
      denominator: lowSample ? 20 : segment.weight,
      platform: "Android",
      appVersion: "7.3.0",
      region: segment.region,
      userType: segment.userType,
      releaseId: ANDROID_730_RELEASE_ID,
    })));
  }

  [0.79, 0.77, 0.78].forEach((rate, index) => {
    const start = iso(releaseTime + (index + 1) * fiveMinutes);
    segments.forEach((segment, segmentIndex) => buckets.push(makeFact({
      key: `post-${index + 1}-${segmentIndex}`,
      start,
      rate,
      denominator: segment.weight,
      platform: "Android",
      appVersion: "7.3.0",
      region: segment.region,
      userType: segment.userType,
      releaseId: ANDROID_730_RELEASE_ID,
    })));
    buckets.push(makeFact({
      key: `control-old-${index}`,
      start,
      rate: 0.959,
      denominator: 900,
      platform: "Android",
      appVersion: "7.2.9",
      region: "AU",
      userType: "RETURNING",
    }));
    buckets.push(makeFact({
      key: `control-ios-${index}`,
      start,
      rate: 0.962,
      denominator: 950,
      platform: "iOS",
      appVersion: "7.3.0",
      region: "AU",
      userType: "RETURNING",
    }));
  });
  return buckets;
}

export async function seedAndroid730Fixture(store: AnalyticsStore) {
  await store.upsertRelease(release);
  await store.upsertMetricBuckets(android730FixtureBuckets());
  return release;
}

export async function ensureAndroid730RiskEvent(store: AnalyticsStore) {
  await seedAndroid730Fixture(store);
  const event = await detectAndPersistRiskEvent(store, {
    metricKey: ANDROID_730_METRIC,
    releaseId: ANDROID_730_RELEASE_ID,
    filters: ANDROID_730_MONITOR_FILTERS,
    startTime: "2026-07-19T00:00:00.000Z",
    endTime: "2026-07-26T02:20:00.000Z",
    policy: couponClaimPolicy,
    detectedAt: ANDROID_730_DETECTED_AT,
  });
  if (!event) throw new Error("Deterministic fixture did not produce the expected RiskEvent");
  return { release, event };
}

export class MemoryAnalyticsStore implements AnalyticsStore {
  releases = new Map<string, Release>();
  buckets = new Map<string, MetricBucket>();
  events = new Map<string, RiskEvent>();

  async upsertRelease(item: Release) {
    if (!this.releases.has(item.id)) this.releases.set(item.id, structuredClone(item));
  }

  async upsertMetricBuckets(items: MetricBucket[]) {
    items.forEach((item) => {
      if (!this.buckets.has(item.id)) this.buckets.set(item.id, structuredClone(item));
    });
  }

  async saveRiskEvent(item: RiskEvent) {
    const existing = await this.getRiskEventBySignature(item.triggerSignature);
    if (existing) return existing;
    this.events.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async getRelease(releaseId: string) {
    return structuredClone(this.releases.get(releaseId) ?? null);
  }

  async getRiskEvent(riskEventId: string) {
    return structuredClone(this.events.get(riskEventId) ?? null);
  }

  async getRiskEventBySignature(signature: string) {
    const event = [...this.events.values()].find((item) => item.triggerSignature === signature);
    return structuredClone(event ?? null);
  }

  async queryMetricBuckets(query: MetricQuery) {
    const filters = query.filters ?? {};
    return [...this.buckets.values()].filter((bucket) =>
      bucket.metricKey === query.metricKey
      && bucket.bucketStart >= query.startTime
      && bucket.bucketEnd <= query.endTime
      && (!filters.platform || bucket.platform === filters.platform)
      && (!filters.appVersion || bucket.appVersion === filters.appVersion)
      && (!filters.region || bucket.region === filters.region)
      && (!filters.userType || bucket.userType === filters.userType)
    ).sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
      .map((item) => structuredClone(item));
  }
}
