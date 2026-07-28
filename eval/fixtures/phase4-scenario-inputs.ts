import type { MetricFilters } from "../../lib/analytics/types";

export type LiveScenarioInput = {
  id: string;
  riskEvent: {
    metricKey: string;
    direction: "DOWN" | "UP";
    releaseId: string | null;
    filters: MetricFilters;
    triggerSummary: string;
    observedValue: number;
    baselineValue: number;
  };
  release: null | {
    version: string;
    platform: string;
    changedModules: string[];
  };
  metricSeries: Array<{
    value: number;
    sampleSize: number;
    platform?: string;
    appVersion?: string;
    region?: string;
    userType?: string;
  }>;
  feedback: string[];
  historicalIncidents: string[];
  unavailableSources: Array<"METRICS" | "FEEDBACK" | "INCIDENTS">;
  actionCompletion: { effectiveAt: string; changeReference: string };
  verification: { metricValues: number[]; sampleSize: number };
};

const effectiveAt = "2030-07-28T03:00:00.000Z";

// These fixtures describe only the observable scenario world. Expected answers live in
// phase4-scenarios.ts and are loaded by the scorer after runtime completion.
export const phase4ScenarioInputs: readonly LiveScenarioInput[] = [
  {
    id: "release-regression",
    riskEvent: { metricKey: "coupon_claim_success_rate", direction: "DOWN",
      releaseId: "REL-P4-RELEASE-REGRESSION",
      filters: { platform: "Android", appVersion: "8.4.0" },
      triggerSummary: "Android 8.4.0 发布后领券成功率连续三个窗口显著下降。",
      observedValue: 0.5, baselineValue: 1 },
    release: { version: "8.4.0", platform: "Android",
      changedModules: ["ImmediateRetry", "IdempotencyGuard"] },
    metricSeries: [
      { value: 0.5, sampleSize: 1200, platform: "Android", appVersion: "8.4.0" },
      { value: 0.98, sampleSize: 1100, platform: "Android", appVersion: "8.3.9" },
      { value: 0.99, sampleSize: 1000, platform: "iOS", appVersion: "8.4.0" },
    ],
    feedback: ["Android 8.4.0 领券后立即重试仍失败，提示请求重复。"],
    historicalIncidents: [], unavailableSources: [],
    actionCompletion: { effectiveAt, changeReference: "eval://change/release-regression" },
    verification: { metricValues: Array(24).fill(0.96), sampleSize: 1000 },
  },
  {
    id: "third-party-outage",
    riskEvent: { metricKey: "payment_success_rate", direction: "DOWN",
      releaseId: "REL-P4-UNRELATED-RELEASE", filters: { region: "US" },
      triggerSummary: "US 支付成功率下降，多个版本与平台同步受影响。",
      observedValue: 0.5, baselineValue: 1 },
    release: { version: "5.1.0", platform: "Android", changedModules: ["Recommendations"] },
    metricSeries: [
      { value: 0.5, sampleSize: 1200, platform: "Android", appVersion: "5.1.0", region: "US" },
      { value: 0.51, sampleSize: 1000, platform: "iOS", appVersion: "5.0.0", region: "US" },
      { value: 0.98, sampleSize: 900, platform: "Android", region: "AU" },
    ],
    feedback: ["US 用户报告支付提供商不可用，Android 和 iOS 都无法完成扣款。"],
    historicalIncidents: [], unavailableSources: [],
    actionCompletion: { effectiveAt, changeReference: "eval://change/provider-escalation" },
    verification: { metricValues: Array(24).fill(0.55), sampleSize: 1000 },
  },
  {
    id: "natural-fluctuation",
    riskEvent: { metricKey: "coupon_claim_request_count", direction: "UP", releaseId: null,
      filters: { region: "AU" }, triggerSummary: "营销活动开始后领券请求量超过历史动态基线。",
      observedValue: 1.4, baselineValue: 1 },
    release: null,
    metricSeries: [
      { value: 1.4, sampleSize: 1500, region: "AU" },
      { value: 1.02, sampleSize: 1200, region: "US" },
    ],
    feedback: ["营销活动反馈正常，没有领券失败或延迟投诉。"],
    historicalIncidents: [], unavailableSources: [],
    actionCompletion: { effectiveAt, changeReference: "eval://observation/campaign" },
    verification: { metricValues: Array(24).fill(1), sampleSize: 1000 },
  },
  {
    id: "missing-insufficient-data",
    riskEvent: { metricKey: "checkout_success_rate", direction: "DOWN",
      releaseId: "REL-P4-MISSING-DATA", filters: { platform: "Android" },
      triggerSummary: "结账成功率下降，但版本分群与反馈源当前不可用。",
      observedValue: 0.6, baselineValue: 1 },
    release: { version: "4.0.0", platform: "Android", changedModules: ["CheckoutShell"] },
    metricSeries: [], feedback: [], historicalIncidents: [],
    unavailableSources: ["METRICS", "FEEDBACK", "INCIDENTS"],
    actionCompletion: { effectiveAt, changeReference: "eval://change/missing-data" },
    verification: { metricValues: [], sampleSize: 0 },
  },
  {
    id: "historical-memory-trap",
    riskEvent: { metricKey: "coupon_claim_success_rate", direction: "DOWN",
      releaseId: "REL-P4-HISTORY-TRAP",
      filters: { platform: "Android", region: "US", userType: "NEW" },
      triggerSummary: "症状类似历史幂等事故，但异常横跨 Android 新旧版本。",
      observedValue: 0.5, baselineValue: 1 },
    release: { version: "7.3.0", platform: "Android", changedModules: ["UITheme"] },
    metricSeries: [
      { value: 0.5, sampleSize: 1000, platform: "Android", appVersion: "7.3.0", region: "US", userType: "NEW" },
      { value: 0.51, sampleSize: 900, platform: "Android", appVersion: "7.2.9", region: "US", userType: "NEW" },
      { value: 0.98, sampleSize: 900, platform: "Android", region: "US", userType: "RETURNING" },
    ],
    feedback: ["US 新用户看到库存不足或资格不符合提示。"],
    historicalIncidents: ["历史事故曾由幂等锁冲突造成超时和重复加载。"],
    unavailableSources: [],
    actionCompletion: { effectiveAt, changeReference: "eval://change/inventory-eligibility" },
    verification: { metricValues: Array(24).fill(0.8), sampleSize: 1000 },
  },
] as const;

export const getPhase4ScenarioInput = (id: string) => {
  const scenario = phase4ScenarioInputs.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown Phase 4 scenario input: ${id}`);
  return scenario;
};
