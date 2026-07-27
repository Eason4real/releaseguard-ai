import { and, asc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { metricBuckets, releases, riskEvents } from "@/db/schema";
import type { AnalyticsStore, MetricQuery } from "./store";
import type { MetricBucket, Release, RiskEvent } from "./types";

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const mapRelease = (row: typeof releases.$inferSelect): Release => ({
  id: row.id,
  version: row.version,
  platform: row.platform,
  releasedAt: row.releasedAt,
  rolloutStatus: row.rolloutStatus,
  rolloutPercentage: row.rolloutPercentage,
  featureFlags: parseJson(row.featureFlagsJson, []),
  changedModules: parseJson(row.changedModulesJson, []),
  provenance: row.provenance,
  createdAt: row.createdAt,
});

const mapBucket = (row: typeof metricBuckets.$inferSelect): MetricBucket => ({
  id: row.id,
  metricKey: row.metricKey,
  bucketStart: row.bucketStart,
  bucketEnd: row.bucketEnd,
  granularityMinutes: row.granularityMinutes,
  numerator: row.numerator,
  denominator: row.denominator,
  value: row.value,
  sampleSize: row.sampleSize,
  platform: row.platform,
  appVersion: row.appVersion,
  region: row.region,
  userType: row.userType,
  dimensionSignature: row.dimensionSignature,
  releaseId: row.releaseId,
  provenance: row.provenance,
  createdAt: row.createdAt,
});

const mapRiskEvent = (row: typeof riskEvents.$inferSelect): RiskEvent => ({
  id: row.id,
  correlatedReleaseId: row.correlatedReleaseId,
  metricKey: row.metricKey,
  status: row.status as RiskEvent["status"],
  direction: row.direction as RiskEvent["direction"],
  filters: parseJson(row.filtersJson, {}),
  segmentSignature: row.segmentSignature,
  detectedAt: row.detectedAt,
  firstBreachedAt: row.firstBreachedAt,
  lastBreachedAt: row.lastBreachedAt,
  observedValue: row.observedValue,
  baselineValue: row.baselineValue,
  absoluteDeviation: row.absoluteDeviation,
  relativeDeviation: row.relativeDeviation,
  sampleSize: row.sampleSize,
  thresholdPct: row.thresholdPct,
  minSampleSize: row.minSampleSize,
  requiredConsecutiveBuckets: row.requiredConsecutiveBuckets,
  triggerBucketIds: parseJson(row.triggerBucketIdsJson, []),
  baselineMethod: row.baselineMethod as RiskEvent["baselineMethod"],
  baselinePointCount: row.baselinePointCount,
  triggerSignature: row.triggerSignature,
  provenance: row.provenance,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class D1AnalyticsStore implements AnalyticsStore {
  async upsertRelease(release: Release) {
    await (await getDb()).insert(releases).values({
      ...release,
      featureFlagsJson: JSON.stringify(release.featureFlags),
      changedModulesJson: JSON.stringify(release.changedModules),
    }).onConflictDoNothing({ target: releases.id });
  }

  async upsertMetricBuckets(buckets: MetricBucket[]) {
    if (buckets.length === 0) return;
    const db = await getDb();
    for (const bucket of buckets) {
      await db.insert(metricBuckets).values(bucket).onConflictDoNothing({
        target: metricBuckets.id,
      });
    }
  }

  async saveRiskEvent(event: RiskEvent) {
    const db = await getDb();
    await db.insert(riskEvents).values({
      ...event,
      filtersJson: JSON.stringify(event.filters),
      triggerBucketIdsJson: JSON.stringify(event.triggerBucketIds),
    }).onConflictDoNothing({ target: riskEvents.triggerSignature });
    const saved = await this.getRiskEventBySignature(event.triggerSignature);
    if (!saved) throw new Error("RiskEvent could not be persisted");
    return saved;
  }

  async getRelease(releaseId: string) {
    const rows = await (await getDb()).select().from(releases)
      .where(eq(releases.id, releaseId)).limit(1);
    return rows[0] ? mapRelease(rows[0]) : null;
  }

  async getRiskEvent(riskEventId: string) {
    const rows = await (await getDb()).select().from(riskEvents)
      .where(eq(riskEvents.id, riskEventId)).limit(1);
    return rows[0] ? mapRiskEvent(rows[0]) : null;
  }

  async getRiskEventBySignature(signature: string) {
    const rows = await (await getDb()).select().from(riskEvents)
      .where(eq(riskEvents.triggerSignature, signature)).limit(1);
    return rows[0] ? mapRiskEvent(rows[0]) : null;
  }

  async queryMetricBuckets(query: MetricQuery) {
    const filters = query.filters ?? {};
    const clauses = [
      eq(metricBuckets.metricKey, query.metricKey),
      gte(metricBuckets.bucketStart, query.startTime),
      lte(metricBuckets.bucketEnd, query.endTime),
    ];
    if (filters.platform) clauses.push(eq(metricBuckets.platform, filters.platform));
    if (filters.appVersion) clauses.push(eq(metricBuckets.appVersion, filters.appVersion));
    if (filters.region) clauses.push(eq(metricBuckets.region, filters.region));
    if (filters.userType) clauses.push(eq(metricBuckets.userType, filters.userType));
    const rows = await (await getDb()).select().from(metricBuckets)
      .where(and(...clauses)).orderBy(asc(metricBuckets.bucketStart));
    return rows.map(mapBucket);
  }
}
