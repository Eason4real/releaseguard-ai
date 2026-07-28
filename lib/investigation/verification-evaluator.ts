import { aggregateBucketFacts } from "../risk-detection/detector";
import type { MetricBucket, MetricFilters } from "../analytics/types";
import type {
  VerificationEvidence,
  VerificationEvidenceKind,
  VerificationOutcome,
  VerificationPolicySnapshot,
} from "./types";

export type VerificationFeedbackRecord = {
  id: string;
  timestamp: string;
  tags: string[];
  source: string;
  sourceReference: string;
};

export type VerificationSignalErrors = Partial<Record<VerificationEvidenceKind, string>>;

export type VerificationEvaluationResult = {
  outcome: VerificationOutcome;
  reasonCode: string;
  evidence: VerificationEvidence[];
  result: Record<string, unknown>;
};

const EPSILON = 1e-9;
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const negativeTags = new Set(["negative", "error", "failure", "failed", "timeout", "complaint"]);
const greaterOrEqual = (value: number, threshold: number) => value + EPSILON >= threshold;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const nonNegative = (value: unknown): value is number => finite(value) && value >= 0;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const nonNegativeInteger = (value: unknown): value is number =>
  nonNegative(value) && Number.isSafeInteger(value);
const positiveInteger = (value: unknown): value is number =>
  positive(value) && Number.isSafeInteger(value);
const unitInterval = (value: unknown): value is number =>
  finite(value) && value >= 0 && value <= 1;

const recoveryRatio = (value: number, baseline: number, direction: "DOWN" | "UP") => {
  if (!nonNegative(value) || !positive(baseline)) return null;
  if (direction === "UP" && value === 0) return null;
  const ratio = direction === "DOWN" ? value / baseline : baseline / value;
  return finite(ratio) ? ratio : null;
};

function validatePolicy(policy: VerificationPolicySnapshot): string[] {
  const reasons: string[] = [];
  if (!Number.isFinite(Date.parse(policy.anchorAt))) reasons.push("INVALID_ANCHOR");
  if (!positive(policy.baselineValue)) reasons.push("INVALID_BASELINE");
  if (!nonNegative(policy.incidentObservedValue)) reasons.push("INVALID_INCIDENT_OBSERVED_VALUE");
  if (policy.direction !== "DOWN" && policy.direction !== "UP") reasons.push("INVALID_DIRECTION");
  if (!positiveInteger(policy.granularityMinutes)) reasons.push("INVALID_GRANULARITY");
  if (!positiveInteger(policy.verificationWindowMinutes)) reasons.push("INVALID_WINDOW");
  if (!nonNegativeInteger(policy.settlingPeriodMinutes)) reasons.push("INVALID_SETTLING_PERIOD");
  if (!positiveInteger(policy.minimumSampleSize)) reasons.push("INVALID_MINIMUM_SAMPLE_SIZE");
  if (!positiveInteger(policy.requiredConsecutiveBuckets)) reasons.push("INVALID_CONSECUTIVE_BUCKETS");
  if (!unitInterval(policy.metricRecoveryThreshold)) reasons.push("INVALID_RECOVERY_THRESHOLD");
  if (!unitInterval(policy.minimumImprovementThreshold)) reasons.push("INVALID_IMPROVEMENT_THRESHOLD");
  if (!unitInterval(policy.feedbackTrendThreshold)) reasons.push("INVALID_FEEDBACK_THRESHOLD");
  if (!positiveInteger(policy.feedbackMinimumSampleSize)) reasons.push("INVALID_FEEDBACK_SAMPLE_SIZE");
  if (policy.controlFilters !== null && !positive(policy.controlBaselineValue)) {
    reasons.push("INVALID_CONTROL_BASELINE");
  }
  if (positiveInteger(policy.granularityMinutes)
    && positiveInteger(policy.verificationWindowMinutes)) {
    if (policy.verificationWindowMinutes % policy.granularityMinutes !== 0) {
      reasons.push("WINDOW_NOT_DIVISIBLE_BY_GRANULARITY");
    } else if (positiveInteger(policy.requiredConsecutiveBuckets)
      && policy.requiredConsecutiveBuckets
        > policy.verificationWindowMinutes / policy.granularityMinutes) {
      reasons.push("CONSECUTIVE_BUCKETS_EXCEED_WINDOW");
    }
  }
  if (policy.direction === "UP" && policy.incidentObservedValue === 0) {
    reasons.push("INVALID_INCIDENT_DENOMINATOR");
  }
  return [...new Set(reasons)];
}

function invalidEvidence(input: {
  runId: string;
  verificationRunId: string;
  kind: VerificationEvidenceKind;
  source: string;
  query: Record<string, unknown>;
  windowStart: string;
  windowEnd: string;
  baselineValue: number | null;
  reasonCodes: string[];
  createdAt: string;
  qualityStatus?: "INVALID_DATA" | "ERROR";
}): VerificationEvidence {
  return {
    id: id("VE"), runId: input.runId, verificationRunId: input.verificationRunId,
    kind: input.kind, source: input.source, query: input.query,
    windowStart: input.windowStart, windowEnd: input.windowEnd, sampleSize: 0,
    observedValue: null, baselineValue: finite(input.baselineValue) ? input.baselineValue : null,
    recoveryRatio: null, qualityStatus: input.qualityStatus ?? "INVALID_DATA",
    details: { valid: false, reasonCodes: input.reasonCodes },
    provenance: "deterministic_verification", createdAt: input.createdAt,
  };
}

function validateRawBuckets(input: {
  buckets: MetricBucket[];
  metricKey: string;
  granularityMinutes: number;
  windowStart: string;
  windowEnd: string;
}) {
  const reasons: string[] = [];
  const interval = input.granularityMinutes * 60_000;
  const startMs = Date.parse(input.windowStart);
  const endMs = Date.parse(input.windowEnd);
  const expectedCount = (endMs - startMs) / interval;
  const starts = new Set<string>();

  if (input.buckets.length !== expectedCount) reasons.push("BUCKET_COUNT_MISMATCH");
  input.buckets.forEach((bucket, index) => {
    const bucketStart = Date.parse(bucket.bucketStart);
    const bucketEnd = Date.parse(bucket.bucketEnd);
    if (starts.has(bucket.bucketStart)) reasons.push("DUPLICATE_BUCKET_START");
    starts.add(bucket.bucketStart);
    if (!Number.isFinite(bucketStart) || !Number.isFinite(bucketEnd)) reasons.push("INVALID_BUCKET_TIME");
    if (bucket.metricKey !== input.metricKey) reasons.push("METRIC_KEY_MISMATCH");
    if (bucket.granularityMinutes !== input.granularityMinutes) reasons.push("WRONG_GRANULARITY");
    if (bucketEnd - bucketStart !== interval) reasons.push("WRONG_BUCKET_DURATION");
    if (bucketEnd !== bucketStart + interval) reasons.push("WRONG_BUCKET_END");
    if (bucketStart < startMs || bucketEnd > endMs) reasons.push("BUCKET_OUTSIDE_WINDOW");
    if (!nonNegative(bucket.value)) reasons.push("INVALID_BUCKET_VALUE");
    if (!nonNegativeInteger(bucket.sampleSize)) reasons.push("INVALID_BUCKET_SAMPLE_SIZE");
    const expectedStart = startMs + index * interval;
    if (bucketStart !== expectedStart) reasons.push(index === 0
      ? "WINDOW_START_MISALIGNED" : "BUCKET_GAP_OR_OVERLAP");
    if (index > 0) {
      const previousEnd = Date.parse(input.buckets[index - 1].bucketEnd);
      if (bucketStart <= Date.parse(input.buckets[index - 1].bucketStart)) {
        reasons.push("BUCKETS_NOT_STRICTLY_INCREASING");
      }
      if (bucketStart !== previousEnd) reasons.push("BUCKET_GAP_OR_OVERLAP");
    }
  });
  if (input.buckets.length > 0) {
    if (input.buckets[0].bucketStart !== input.windowStart) reasons.push("WINDOW_START_MISALIGNED");
    if (input.buckets.at(-1)?.bucketEnd !== input.windowEnd) reasons.push("WINDOW_END_MISALIGNED");
  }
  return { valid: reasons.length === 0, reasonCodes: [...new Set(reasons)], expectedCount };
}

function metricEvidence(input: {
  runId: string;
  verificationRunId: string;
  kind: "AFFECTED_METRIC" | "CONTROL_METRIC";
  metricKey: string;
  filters: MetricFilters;
  buckets: MetricBucket[];
  baselineValue: number;
  policy: VerificationPolicySnapshot;
  windowStart: string;
  windowEnd: string;
  createdAt: string;
}) {
  const rawValidation = validateRawBuckets({
    buckets: input.buckets, metricKey: input.metricKey,
    granularityMinutes: input.policy.granularityMinutes!,
    windowStart: input.windowStart, windowEnd: input.windowEnd,
  });
  if (!rawValidation.valid) {
    return {
      evidence: invalidEvidence({
        runId: input.runId, verificationRunId: input.verificationRunId, kind: input.kind,
        source: "Product Analytics D1", query: { metricKey: input.metricKey, filters: input.filters },
        windowStart: input.windowStart, windowEnd: input.windowEnd,
        baselineValue: input.baselineValue, reasonCodes: rawValidation.reasonCodes,
        createdAt: input.createdAt,
      }),
      consecutiveRecovered: false,
      ratio: null,
    };
  }

  const aggregated = aggregateBucketFacts(input.buckets);
  const sampleSufficient = aggregated.every((bucket) =>
    bucket.sampleSize >= input.policy.minimumSampleSize);
  const sampleSize = aggregated.reduce((sum, bucket) => sum + bucket.sampleSize, 0);
  const weightedTotal = aggregated.reduce((sum, bucket) => sum + bucket.value * bucket.sampleSize, 0);
  const observedValue = sampleSize > 0 ? weightedTotal / sampleSize : null;
  const ratios = aggregated.map((bucket) =>
    recoveryRatio(bucket.value, input.baselineValue, input.policy.direction!));
  const numericValid = nonNegativeInteger(sampleSize)
    && observedValue !== null && nonNegative(observedValue)
    && ratios.every((ratio) => ratio !== null && finite(ratio));
  if (!numericValid) {
    return {
      evidence: invalidEvidence({
        runId: input.runId, verificationRunId: input.verificationRunId, kind: input.kind,
        source: "Product Analytics D1", query: { metricKey: input.metricKey, filters: input.filters },
        windowStart: input.windowStart, windowEnd: input.windowEnd,
        baselineValue: input.baselineValue, reasonCodes: ["INVALID_AGGREGATED_NUMERIC_DATA"],
        createdAt: input.createdAt,
      }),
      consecutiveRecovered: false,
      ratio: null,
    };
  }
  const consecutiveRecovered = ratios.slice(-input.policy.requiredConsecutiveBuckets)
    .every((ratio) => ratio !== null && greaterOrEqual(ratio, input.policy.metricRecoveryThreshold));
  const ratio = recoveryRatio(observedValue, input.baselineValue, input.policy.direction!);
  const qualityStatus = !sampleSufficient ? "INSUFFICIENT" as const : "SUFFICIENT" as const;
  const evidence: VerificationEvidence = {
    id: id("VE"), runId: input.runId, verificationRunId: input.verificationRunId,
    kind: input.kind, source: "Product Analytics D1",
    query: { metricKey: input.metricKey, filters: input.filters },
    windowStart: input.windowStart, windowEnd: input.windowEnd,
    sampleSize, observedValue, baselineValue: input.baselineValue, recoveryRatio: ratio,
    qualityStatus,
    details: {
      expectedBuckets: rawValidation.expectedCount, observedBuckets: input.buckets.length,
      rawWindowValid: true, sampleSufficient, consecutiveRecovered,
      requiredConsecutiveBuckets: input.policy.requiredConsecutiveBuckets,
      bucketRecoveryRatios: ratios,
    },
    provenance: "deterministic_verification", createdAt: input.createdAt,
  };
  return { evidence, consecutiveRecovered, ratio };
}

const negativeRate = (items: VerificationFeedbackRecord[]) => items.length === 0
  ? null
  : items.filter((item) => item.tags.some((tag) => negativeTags.has(tag.toLowerCase()))).length / items.length;

function feedbackSignalEvidence(input: {
  runId: string;
  verificationRunId: string;
  kind: "FEEDBACK_REFERENCE" | "FEEDBACK_VERIFICATION";
  filters: MetricFilters;
  records: VerificationFeedbackRecord[];
  windowStart: string;
  windowEnd: string;
  minimumSampleSize: number;
  baselineValue: number | null;
  createdAt: string;
}) {
  const recordsValid = input.records.every((item) =>
    Number.isFinite(Date.parse(item.timestamp)) && Array.isArray(item.tags));
  const rate = negativeRate(input.records);
  const numericValid = recordsValid && (rate === null || unitInterval(rate));
  const qualityStatus = !numericValid ? "INVALID_DATA" as const
    : input.records.length === 0 ? "EMPTY" as const
      : input.records.length >= input.minimumSampleSize ? "SUFFICIENT" as const : "INSUFFICIENT" as const;
  const evidence: VerificationEvidence = {
    id: id("VE"), runId: input.runId, verificationRunId: input.verificationRunId,
    kind: input.kind, source: "Feedback Repository", query: { filters: input.filters },
    windowStart: input.windowStart, windowEnd: input.windowEnd,
    sampleSize: input.records.length, observedValue: rate, baselineValue: input.baselineValue,
    recoveryRatio: null, qualityStatus,
    details: { negativeRate: rate, role: input.kind === "FEEDBACK_REFERENCE" ? "REFERENCE" : "VERIFICATION" },
    provenance: "deterministic_verification", createdAt: input.createdAt,
  };
  return { evidence, rate };
}

function feedbackEvidence(input: {
  runId: string;
  verificationRunId: string;
  filters: MetricFilters;
  reference: VerificationFeedbackRecord[];
  observed: VerificationFeedbackRecord[];
  referenceStart: string;
  referenceEnd: string;
  windowStart: string;
  windowEnd: string;
  policy: VerificationPolicySnapshot;
  createdAt: string;
}) {
  const recordsValid = [...input.reference, ...input.observed].every((item) =>
    Number.isFinite(Date.parse(item.timestamp)) && Array.isArray(item.tags));
  const referenceRate = negativeRate(input.reference);
  const observedRate = negativeRate(input.observed);
  const numericValid = recordsValid
    && (referenceRate === null || unitInterval(referenceRate))
    && (observedRate === null || unitInterval(observedRate));
  const sufficient = numericValid
    && input.reference.length >= input.policy.feedbackMinimumSampleSize
    && input.observed.length >= input.policy.feedbackMinimumSampleSize;
  const recovered = sufficient && referenceRate !== null && observedRate !== null
    && greaterOrEqual(referenceRate * (1 - input.policy.feedbackTrendThreshold), observedRate);
  const qualityStatus = !numericValid ? "INVALID_DATA" as const
    : input.reference.length === 0 && input.observed.length === 0 ? "EMPTY" as const
      : sufficient ? "SUFFICIENT" as const : "INSUFFICIENT" as const;
  const referenceEvidence = feedbackSignalEvidence({
    runId: input.runId, verificationRunId: input.verificationRunId, kind: "FEEDBACK_REFERENCE",
    filters: input.filters, records: input.reference, windowStart: input.referenceStart,
    windowEnd: input.referenceEnd, minimumSampleSize: input.policy.feedbackMinimumSampleSize,
    baselineValue: null, createdAt: input.createdAt,
  }).evidence;
  const observedEvidence = feedbackSignalEvidence({
    runId: input.runId, verificationRunId: input.verificationRunId, kind: "FEEDBACK_VERIFICATION",
    filters: input.filters, records: input.observed, windowStart: input.windowStart,
    windowEnd: input.windowEnd, minimumSampleSize: input.policy.feedbackMinimumSampleSize,
    baselineValue: referenceRate, createdAt: input.createdAt,
  }).evidence;
  referenceEvidence.qualityStatus = qualityStatus;
  observedEvidence.qualityStatus = qualityStatus;
  observedEvidence.details.recovered = recovered;
  return { evidence: [referenceEvidence, observedEvidence], recovered, qualityStatus };
}

export function evaluateVerification(input: {
  runId: string;
  verificationRunId: string;
  policy: VerificationPolicySnapshot;
  affectedBuckets: MetricBucket[];
  controlBuckets?: MetricBucket[];
  feedbackReference?: VerificationFeedbackRecord[];
  feedbackObserved?: VerificationFeedbackRecord[];
  signalErrors?: VerificationSignalErrors;
  createdAt: string;
}): VerificationEvaluationResult {
  const policyErrors = validatePolicy(input.policy);
  const anchorMs = Date.parse(input.policy.anchorAt);
  const safeAnchorMs = Number.isFinite(anchorMs) ? anchorMs : Date.parse(input.createdAt);
  const safeSettling = nonNegativeInteger(input.policy.settlingPeriodMinutes)
    ? input.policy.settlingPeriodMinutes : 0;
  const safeWindow = positiveInteger(input.policy.verificationWindowMinutes)
    ? input.policy.verificationWindowMinutes : 0;
  const startMs = safeAnchorMs + safeSettling * 60_000;
  const endMs = startMs + safeWindow * 60_000;
  const windowStart = new Date(startMs).toISOString();
  const windowEnd = new Date(endMs).toISOString();
  if (policyErrors.length > 0) {
    return {
      outcome: "INCONCLUSIVE", reasonCode: "INVALID_POLICY",
      evidence: [invalidEvidence({
        runId: input.runId, verificationRunId: input.verificationRunId, kind: "AFFECTED_METRIC",
        source: "Verification Policy Runtime", query: { metricKey: input.policy.metricKey },
        windowStart, windowEnd, baselineValue: input.policy.baselineValue,
        reasonCodes: policyErrors, createdAt: input.createdAt,
      })],
      result: { policyValid: false, reasonCodes: policyErrors },
    };
  }

  const requiredKinds: VerificationEvidenceKind[] = ["AFFECTED_METRIC"];
  if (input.policy.controlFilters) requiredKinds.push("CONTROL_METRIC");
  if (input.policy.feedbackRequired) requiredKinds.push("FEEDBACK_REFERENCE", "FEEDBACK_VERIFICATION");
  const queryErrors = requiredKinds.flatMap((kind) => input.signalErrors?.[kind]
    ? [[kind, input.signalErrors[kind]!] as const] : []);
  const queryErrorEvidence = queryErrors.map(([kind, error]) => invalidEvidence({
      runId: input.runId, verificationRunId: input.verificationRunId, kind,
      source: kind.startsWith("FEEDBACK") ? "Feedback Repository" : "Product Analytics D1",
      query: kind.startsWith("FEEDBACK")
        ? { filters: input.policy.affectedFilters, signal: kind }
        : { metricKey: input.policy.metricKey, filters: kind === "CONTROL_METRIC"
          ? input.policy.controlFilters : input.policy.affectedFilters },
      windowStart, windowEnd,
      baselineValue: kind === "CONTROL_METRIC"
        ? input.policy.controlBaselineValue : input.policy.baselineValue,
      reasonCodes: ["SIGNAL_QUERY_FAILED", error], createdAt: input.createdAt,
      qualityStatus: "ERROR",
    }));
  if (input.signalErrors?.AFFECTED_METRIC) {
    return {
      outcome: "INCONCLUSIVE", reasonCode: "REQUIRED_SIGNAL_QUERY_FAILED",
      evidence: queryErrorEvidence,
      result: { failedSignals: queryErrors.map(([kind]) => kind) },
    };
  }

  const affected = metricEvidence({
    runId: input.runId, verificationRunId: input.verificationRunId, kind: "AFFECTED_METRIC",
    metricKey: input.policy.metricKey, filters: input.policy.affectedFilters,
    buckets: input.affectedBuckets, baselineValue: input.policy.baselineValue!,
    policy: input.policy, windowStart, windowEnd, createdAt: input.createdAt,
  });
  const evidence = [affected.evidence];
  if (affected.evidence.qualityStatus !== "SUFFICIENT") {
    return { outcome: "INCONCLUSIVE", reasonCode: affected.evidence.qualityStatus === "INVALID_DATA"
      ? "INVALID_METRIC_DATA" : "METRIC_DATA_INSUFFICIENT", evidence, result: {} };
  }

  let controlRecovered: boolean | null = null;
  if (input.policy.controlFilters && !input.signalErrors?.CONTROL_METRIC) {
    const control = metricEvidence({
      runId: input.runId, verificationRunId: input.verificationRunId, kind: "CONTROL_METRIC",
      metricKey: input.policy.metricKey, filters: input.policy.controlFilters,
      buckets: input.controlBuckets ?? [], baselineValue: input.policy.controlBaselineValue!,
      policy: input.policy, windowStart, windowEnd, createdAt: input.createdAt,
    });
    evidence.push(control.evidence);
    if (control.evidence.qualityStatus !== "SUFFICIENT") {
      return { outcome: "INCONCLUSIVE", reasonCode: control.evidence.qualityStatus === "INVALID_DATA"
        ? "INVALID_CONTROL_DATA" : "CONTROL_DATA_INSUFFICIENT", evidence, result: {} };
    }
    controlRecovered = control.consecutiveRecovered;
  }

  let feedbackRecovered: boolean | null = null;
  if (input.policy.feedbackRequired
    && !input.signalErrors?.FEEDBACK_REFERENCE
    && !input.signalErrors?.FEEDBACK_VERIFICATION) {
    const referenceEnd = input.policy.anchorAt;
    const referenceStart = new Date(Date.parse(referenceEnd)
      - input.policy.verificationWindowMinutes * 60_000).toISOString();
    const feedback = feedbackEvidence({
      runId: input.runId, verificationRunId: input.verificationRunId,
      filters: input.policy.affectedFilters, reference: input.feedbackReference ?? [],
      observed: input.feedbackObserved ?? [], referenceStart, referenceEnd,
      windowStart, windowEnd, policy: input.policy, createdAt: input.createdAt,
    });
    evidence.push(...feedback.evidence);
    if (feedback.qualityStatus !== "SUFFICIENT") {
      return { outcome: "INCONCLUSIVE", reasonCode: feedback.qualityStatus === "INVALID_DATA"
        ? "INVALID_FEEDBACK_DATA" : "FEEDBACK_DATA_INSUFFICIENT", evidence, result: {} };
    }
    feedbackRecovered = feedback.recovered;
  } else if (input.policy.feedbackRequired) {
    const referenceEnd = input.policy.anchorAt;
    const referenceStart = new Date(Date.parse(referenceEnd)
      - input.policy.verificationWindowMinutes * 60_000).toISOString();
    if (!input.signalErrors?.FEEDBACK_REFERENCE) {
      evidence.push(feedbackSignalEvidence({
        runId: input.runId, verificationRunId: input.verificationRunId, kind: "FEEDBACK_REFERENCE",
        filters: input.policy.affectedFilters, records: input.feedbackReference ?? [],
        windowStart: referenceStart, windowEnd: referenceEnd,
        minimumSampleSize: input.policy.feedbackMinimumSampleSize,
        baselineValue: null, createdAt: input.createdAt,
      }).evidence);
    }
    if (!input.signalErrors?.FEEDBACK_VERIFICATION) {
      evidence.push(feedbackSignalEvidence({
        runId: input.runId, verificationRunId: input.verificationRunId, kind: "FEEDBACK_VERIFICATION",
        filters: input.policy.affectedFilters, records: input.feedbackObserved ?? [],
        windowStart, windowEnd, minimumSampleSize: input.policy.feedbackMinimumSampleSize,
        baselineValue: null, createdAt: input.createdAt,
      }).evidence);
    }
  }

  evidence.push(...queryErrorEvidence);
  if (queryErrors.length > 0) {
    return {
      outcome: "INCONCLUSIVE", reasonCode: "REQUIRED_SIGNAL_QUERY_FAILED", evidence,
      result: { failedSignals: queryErrors.map(([kind]) => kind) },
    };
  }

  const metricRecovered = affected.consecutiveRecovered
    && affected.ratio !== null
    && greaterOrEqual(affected.ratio, input.policy.metricRecoveryThreshold);
  const incidentRatio = recoveryRatio(
    input.policy.incidentObservedValue!, input.policy.baselineValue!, input.policy.direction!,
  );
  if (affected.ratio === null || incidentRatio === null) {
    return { outcome: "INCONCLUSIVE", reasonCode: "INVALID_RECOVERY_RATIO", evidence, result: {} };
  }
  const improvement = affected.ratio - incidentRatio;
  const improved = greaterOrEqual(improvement, input.policy.minimumImprovementThreshold);
  const allSignalsRecovered = metricRecovered
    && controlRecovered !== false && feedbackRecovered !== false;
  const outcome: VerificationOutcome = allSignalsRecovered
    ? "RESOLVED"
    : metricRecovered || improved || feedbackRecovered === true
      ? "PARTIALLY_RESOLVED"
      : "NOT_RECOVERED";
  return {
    outcome,
    reasonCode: outcome === "RESOLVED" ? "ALL_REQUIRED_SIGNALS_RECOVERED"
      : outcome === "PARTIALLY_RESOLVED" ? "MEANINGFUL_SIGNAL_IMPROVEMENT" : "METRIC_NOT_RECOVERED",
    evidence,
    result: {
      metricRecovered, controlRecovered, feedbackRecovered,
      recoveryRatio: affected.ratio, incidentRecoveryRatio: incidentRatio,
      improvement, minimumImprovementThreshold: input.policy.minimumImprovementThreshold,
    },
  };
}
