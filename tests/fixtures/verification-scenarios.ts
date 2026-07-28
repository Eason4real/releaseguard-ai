import type { MetricBucket } from "../../lib/analytics/types";
import type { VerificationOutcome, VerificationPolicySnapshot } from "../../lib/investigation/types";

const anchorAt = "2026-07-28T00:00:00.000Z";
const windowStartMs = Date.parse(anchorAt) + 30 * 60_000;

export const verificationPolicyFixture = (
  overrides: Partial<VerificationPolicySnapshot> = {},
): VerificationPolicySnapshot => ({
  id: "VPS-fixture",
  verificationRunId: "VR-fixture",
  runId: "RUN-fixture",
  policyVersion: "P4.3B_V1",
  anchorAt,
  settlingPeriodMinutes: 30,
  verificationWindowMinutes: 120,
  metricKey: "checkout_conversion",
  baselineValue: 1,
  incidentObservedValue: 0.5,
  direction: "DOWN",
  granularityMinutes: 5,
  affectedFilters: { platform: "ANDROID", appVersion: "7.3.0" },
  controlFilters: null,
  controlBaselineValue: null,
  minimumSampleSize: 100,
  requiredConsecutiveBuckets: 3,
  metricRecoveryThreshold: 0.9,
  minimumImprovementThreshold: 0.05,
  feedbackTrendThreshold: 0.25,
  feedbackRequired: false,
  feedbackMinimumSampleSize: 5,
  createdAt: anchorAt,
  ...overrides,
});

export const verificationBuckets = (
  values: number[],
  options: { sampleSize?: number; startOffset?: number; filters?: Record<string, string> } = {},
): MetricBucket[] => values.map((value, index) => {
  const start = windowStartMs + ((options.startOffset ?? 0) + index) * 5 * 60_000;
  return {
    id: `MB-${index}-${value}`,
    metricKey: "checkout_conversion",
    bucketStart: new Date(start).toISOString(),
    bucketEnd: new Date(start + 5 * 60_000).toISOString(),
    granularityMinutes: 5,
    numerator: null,
    denominator: null,
    value,
    sampleSize: options.sampleSize ?? 200,
    platform: options.filters?.platform ?? "ANDROID",
    appVersion: options.filters?.appVersion ?? "7.3.0",
    region: options.filters?.region ?? null,
    userType: options.filters?.userType ?? null,
    dimensionSignature: "fixture",
    releaseId: null,
    provenance: "deterministic_verification_fixture",
    createdAt: anchorAt,
  };
});

export const verificationScenarioFixtures: Array<{
  id: string;
  expectedOutcome: VerificationOutcome;
  buckets: MetricBucket[];
}> = [
  { id: "release-regression", expectedOutcome: "RESOLVED", buckets: verificationBuckets(Array(24).fill(0.95)) },
  { id: "third-party-outage", expectedOutcome: "NOT_RECOVERED", buckets: verificationBuckets(Array(24).fill(0.5)) },
  { id: "natural-fluctuation", expectedOutcome: "RESOLVED", buckets: verificationBuckets(Array(24).fill(1)) },
  { id: "missing-data", expectedOutcome: "INCONCLUSIVE", buckets: [] },
  { id: "historical-memory-trap", expectedOutcome: "PARTIALLY_RESOLVED", buckets: verificationBuckets(Array(24).fill(0.8)) },
];
