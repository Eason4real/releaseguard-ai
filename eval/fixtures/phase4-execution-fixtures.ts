import type { DiagnosisDisposition } from "../../lib/investigation/types";
import type { Phase4ScenarioId } from "./phase4-scenarios";

// These are frozen deterministic planner/tool observations, not expected answers.
// The scorer never passes ground-truth outcomes into this execution transcript.
export type Phase4ExecutionFixture = {
  id: Phase4ScenarioId;
  calledTools: string[];
  selectedHypothesisKey: string | null;
  diagnosisSummary: string | null;
  disposition: DiagnosisDisposition | null;
  createAction: boolean;
  approveAction: boolean;
  completeAction: boolean;
  verificationBucketValue: number | null;
};

export const phase4ExecutionFixtures: readonly Phase4ExecutionFixture[] = [
  {
    id: "release-regression",
    calledTools: ["get_release", "query_metric", "segment_metric", "search_user_feedback"],
    selectedHypothesisKey: "release-retry-regression",
    diagnosisSummary: "Android 8.4.0 的立即重试改动与幂等锁生命周期冲突。",
    disposition: "FIX",
    createAction: true,
    approveAction: true,
    completeAction: true,
    verificationBucketValue: 0.95,
  },
  {
    id: "third-party-outage",
    calledTools: ["get_release", "query_metric", "segment_metric", "search_user_feedback"],
    selectedHypothesisKey: "provider-outage",
    diagnosisSummary: "US 第三方支付提供商发生区域性故障。",
    disposition: "ESCALATE",
    createAction: true,
    approveAction: true,
    completeAction: true,
    verificationBucketValue: 0.5,
  },
  {
    id: "natural-fluctuation",
    calledTools: ["query_metric", "segment_metric", "search_user_feedback"],
    selectedHypothesisKey: "campaign-traffic",
    diagnosisSummary: "营销活动带来预期的自然流量增长。",
    disposition: "OBSERVE",
    createAction: false,
    approveAction: false,
    completeAction: false,
    verificationBucketValue: 0.95,
  },
  {
    id: "missing-insufficient-data",
    calledTools: ["get_release", "query_metric", "segment_metric", "search_user_feedback"],
    selectedHypothesisKey: null,
    diagnosisSummary: null,
    disposition: null,
    createAction: false,
    approveAction: false,
    completeAction: false,
    verificationBucketValue: null,
  },
  {
    id: "historical-memory-trap",
    calledTools: ["query_metric", "segment_metric", "search_user_feedback", "search_similar_incidents"],
    selectedHypothesisKey: "inventory-eligibility",
    diagnosisSummary: "US 新用户库存或资格配置不足。",
    disposition: "FIX",
    createAction: true,
    approveAction: true,
    completeAction: true,
    verificationBucketValue: 0.6,
  },
] as const;
