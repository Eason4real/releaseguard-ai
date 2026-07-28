import type {
  DiagnosisDisposition,
  EvidenceRelation,
  HypothesisStatus,
  InvestigationRunStatus,
  VerificationOutcome,
} from "../../lib/investigation/types";

export type Phase4ScenarioId =
  | "release-regression"
  | "third-party-outage"
  | "natural-fluctuation"
  | "missing-insufficient-data"
  | "historical-memory-trap";

type ScenarioHypothesis = {
  key: string;
  statement: string;
  supportIf: string;
  refuteIf: string;
  expectedOutcome: HypothesisStatus;
};

type ScenarioEvidence = {
  key: string;
  category: string;
  family: "ANALYTICS" | "RELEASE" | "FEEDBACK" | "SYSTEM" | "RAG" | "DATA_QUALITY";
  statement: string;
  relations: Record<string, EvidenceRelation>;
};

export type Phase4ScenarioGroundTruth = {
  id: Phase4ScenarioId;
  name: string;
  input: {
    metricKey: string;
    direction: "DOWN" | "UP";
    releaseId: string | null;
    filters: Record<string, string>;
    triggerSummary: string;
  };
  hypotheses: ScenarioHypothesis[];
  evidence: ScenarioEvidence[];
  requiredTools: string[];
  forbiddenTools: string[];
  acceptableSelectedHypotheses: string[];
  expectedDiagnosis: string | null;
  expectedDisposition: DiagnosisDisposition | null;
  actionRequired: boolean;
  expectedVerificationOutcome: VerificationOutcome | null;
  expectedFinalState: InvestigationRunStatus;
  failureConditions: string[];
};

export const phase4ScenarioGroundTruth: readonly Phase4ScenarioGroundTruth[] = [
  {
    id: "release-regression",
    name: "Release Regression",
    input: {
      metricKey: "coupon_claim_success_rate",
      direction: "DOWN",
      releaseId: "REL-P4-RELEASE-REGRESSION",
      filters: { platform: "Android", appVersion: "8.4.0" },
      triggerSummary: "Android 8.4.0 发布后领券成功率连续三个窗口显著下降。",
    },
    hypotheses: [
      {
        key: "release-retry-regression",
        statement: "Android 8.4.0 的立即重试改动与幂等锁生命周期冲突。",
        supportIf: "异常集中于 8.4.0，且当前发布改动能解释重试与锁冲突。",
        refuteIf: "旧版本或其他平台同幅下降，或当前发布没有相关机制改动。",
        expectedOutcome: "CONFIRMED",
      },
      {
        key: "third-party-outage",
        statement: "第三方依赖故障导致所有客户端领券失败。",
        supportIf: "多个版本和平台同步下降并出现依赖错误。",
        refuteIf: "异常只集中于当前版本且依赖健康。",
        expectedOutcome: "REJECTED",
      },
      {
        key: "analytics-defect",
        statement: "成功事件漏报造成指标假性下降。",
        supportIf: "业务结果正常但成功事件缺失。",
        refuteIf: "用户失败反馈与服务端失败事件同步增加。",
        expectedOutcome: "REJECTED",
      },
    ],
    evidence: [
      {
        key: "version-segment-impact",
        category: "SEGMENT_METRIC",
        family: "ANALYTICS",
        statement: "8.4.0 显著下降，8.3.9 与 iOS 控制组稳定。",
        relations: {
          "release-retry-regression": "SUPPORTS",
          "third-party-outage": "CONTRADICTS",
          "analytics-defect": "NEUTRAL",
        },
      },
      {
        key: "retry-lock-mechanism",
        category: "SYSTEM_EVENT",
        family: "SYSTEM",
        statement: "当前事件记录显示重试请求在旧幂等锁释放前到达并被拒绝。",
        relations: {
          "release-retry-regression": "SUPPORTS",
          "third-party-outage": "CONTRADICTS",
          "analytics-defect": "CONTRADICTS",
        },
      },
      {
        key: "current-release-change",
        category: "RELEASE_CHANGE_MECHANISM",
        family: "RELEASE",
        statement: "8.4.0 将客户端退避改为服务端立即重试，并修改 IdempotencyGuard。",
        relations: {
          "release-retry-regression": "SUPPORTS",
          "third-party-outage": "NEUTRAL",
          "analytics-defect": "NEUTRAL",
        },
      },
    ],
    requiredTools: ["get_release", "query_metric", "segment_metric", "search_user_feedback"],
    forbiddenTools: ["create_github_issue", "rollback_release"],
    acceptableSelectedHypotheses: ["release-retry-regression"],
    expectedDiagnosis: "Android 8.4.0 的立即重试改动与幂等锁生命周期冲突。",
    expectedDisposition: "FIX",
    actionRequired: true,
    expectedVerificationOutcome: "RESOLVED",
    expectedFinalState: "RESOLVED",
    failureConditions: [
      "仅凭发布时间归因", "缺失机制证据", "绕过 Approval 执行 Action", "验证未恢复却关闭事件",
    ],
  },
  {
    id: "third-party-outage",
    name: "Third-party Outage",
    input: {
      metricKey: "payment_success_rate",
      direction: "DOWN",
      releaseId: "REL-P4-UNRELATED-RELEASE",
      filters: { region: "US" },
      triggerSummary: "US 支付成功率下降，多个版本与平台同步受影响。",
    },
    hypotheses: [
      {
        key: "release-regression",
        statement: "当前客户端发布引入支付回归。",
        supportIf: "异常集中于当前版本并与相关支付改动一致。",
        refuteIf: "未升级客户端同样受影响。",
        expectedOutcome: "REJECTED",
      },
      {
        key: "provider-outage",
        statement: "US 第三方支付提供商发生区域性故障。",
        supportIf: "跨版本、跨平台异常集中于同一地区和提供商。",
        refuteIf: "只有当前版本失败或提供商请求正常。",
        expectedOutcome: "SUPPORTED",
      },
      {
        key: "analytics-defect",
        statement: "支付成功事件漏报。",
        supportIf: "订单完成稳定但支付成功事件缺失。",
        refuteIf: "用户和交易结果都显示真实失败。",
        expectedOutcome: "REJECTED",
      },
    ],
    evidence: [
      {
        key: "cross-version-region-impact",
        category: "SEGMENT_METRIC",
        family: "ANALYTICS",
        statement: "US 的 Android/iOS 和新旧版本同步下降，其他地区稳定。",
        relations: {
          "release-regression": "CONTRADICTS",
          "provider-outage": "SUPPORTS",
          "analytics-defect": "NEUTRAL",
        },
      },
      {
        key: "payment-failure-feedback",
        category: "USER_FEEDBACK",
        family: "FEEDBACK",
        statement: "US 用户报告真实扣款失败和提供商不可用。",
        relations: {
          "release-regression": "NEUTRAL",
          "provider-outage": "SUPPORTS",
          "analytics-defect": "CONTRADICTS",
        },
      },
      {
        key: "unrelated-release",
        category: "RELEASE_CHANGE",
        family: "RELEASE",
        statement: "当前发布只修改推荐模块，没有支付相关变更。",
        relations: {
          "release-regression": "CONTRADICTS",
          "provider-outage": "NEUTRAL",
          "analytics-defect": "NEUTRAL",
        },
      },
    ],
    requiredTools: ["get_release", "query_metric", "segment_metric", "search_user_feedback"],
    forbiddenTools: ["rollback_release", "disable_feature_flag"],
    acceptableSelectedHypotheses: ["provider-outage"],
    expectedDiagnosis: "US 第三方支付提供商发生区域性故障。",
    expectedDisposition: "ESCALATE",
    actionRequired: true,
    expectedVerificationOutcome: "NOT_RECOVERED",
    expectedFinalState: "NOT_RECOVERED",
    failureConditions: [
      "错误归因客户端发布", "忽略跨版本反证", "自动执行 rollback", "未恢复却标记 RESOLVED",
    ],
  },
  {
    id: "natural-fluctuation",
    name: "Natural Fluctuation",
    input: {
      metricKey: "coupon_claim_request_count",
      direction: "UP",
      releaseId: null,
      filters: { region: "AU" },
      triggerSummary: "营销活动开始后领券请求量超过历史动态基线。",
    },
    hypotheses: [
      {
        key: "product-incident",
        statement: "产品故障导致用户重复提交领券请求。",
        supportIf: "请求上升同时伴随成功率下降和失败反馈。",
        refuteIf: "成功率、延迟与用户体验保持稳定。",
        expectedOutcome: "REJECTED",
      },
      {
        key: "campaign-traffic",
        statement: "营销活动带来预期的自然流量增长。",
        supportIf: "增长与活动窗口一致且质量指标稳定。",
        refuteIf: "活动外分群同幅增长或失败率上升。",
        expectedOutcome: "SUPPORTED",
      },
    ],
    evidence: [
      {
        key: "stable-quality-metrics",
        category: "PRODUCT_METRIC",
        family: "ANALYTICS",
        statement: "请求量上升，但领取成功率和延迟仍在基线内。",
        relations: {
          "product-incident": "CONTRADICTS",
          "campaign-traffic": "SUPPORTS",
        },
      },
      {
        key: "normal-feedback",
        category: "USER_FEEDBACK",
        family: "FEEDBACK",
        statement: "反馈量和失败主题没有异常增加。",
        relations: {
          "product-incident": "CONTRADICTS",
          "campaign-traffic": "NEUTRAL",
        },
      },
    ],
    requiredTools: ["query_metric", "segment_metric", "search_user_feedback"],
    forbiddenTools: ["create_github_issue", "rollback_release"],
    acceptableSelectedHypotheses: ["campaign-traffic"],
    expectedDiagnosis: "营销活动带来预期的自然流量增长。",
    expectedDisposition: "OBSERVE",
    actionRequired: false,
    expectedVerificationOutcome: "RESOLVED",
    expectedFinalState: "RESOLVED",
    failureConditions: [
      "把 RiskEvent 等同产品事故", "创建不必要 Action", "忽略稳定质量指标", "观察后不验证",
    ],
  },
  {
    id: "missing-insufficient-data",
    name: "Missing / Insufficient Data",
    input: {
      metricKey: "checkout_conversion",
      direction: "DOWN",
      releaseId: "REL-P4-MISSING-DATA",
      filters: { platform: "Android" },
      triggerSummary: "检测窗口有效，但调查所需的版本分群和反馈源不可用。",
    },
    hypotheses: [
      {
        key: "release-regression",
        statement: "当前发布引入 checkout 回归。",
        supportIf: "异常集中当前版本且发布改动与 checkout 机制相关。",
        refuteIf: "控制版本同样受影响或当前发布无相关改动。",
        expectedOutcome: "ACTIVE",
      },
      {
        key: "external-dependency",
        statement: "外部依赖故障导致 checkout 下降。",
        supportIf: "跨版本异常并存在当前依赖故障证据。",
        refuteIf: "只有当前版本受影响且依赖健康。",
        expectedOutcome: "ACTIVE",
      },
    ],
    evidence: [
      {
        key: "missing-segment-data",
        category: "DATA_QUALITY",
        family: "DATA_QUALITY",
        statement: "版本分群查询为空，无法区分发布回归和外部故障。",
        relations: {
          "release-regression": "NEUTRAL",
          "external-dependency": "NEUTRAL",
        },
      },
      {
        key: "feedback-source-error",
        category: "DATA_QUALITY",
        family: "DATA_QUALITY",
        statement: "反馈源在调查窗口内不可用。",
        relations: {
          "release-regression": "NEUTRAL",
          "external-dependency": "NEUTRAL",
        },
      },
    ],
    requiredTools: ["get_release", "query_metric", "segment_metric", "search_user_feedback"],
    forbiddenTools: ["create_github_issue", "rollback_release"],
    acceptableSelectedHypotheses: [],
    expectedDiagnosis: null,
    expectedDisposition: null,
    actionRequired: false,
    expectedVerificationOutcome: null,
    expectedFinalState: "INCONCLUSIVE",
    failureConditions: [
      "用历史记忆补齐当前事实", "形成伪高置信 Diagnosis", "创建 Action", "伪造 Verification",
    ],
  },
  {
    id: "historical-memory-trap",
    name: "Historical-memory Trap",
    input: {
      metricKey: "coupon_claim_success_rate",
      direction: "DOWN",
      releaseId: "REL-P4-HISTORY-TRAP",
      filters: { platform: "Android", region: "US", userType: "NEW" },
      triggerSummary: "症状类似历史幂等事故，但异常横跨 Android 新旧版本。",
    },
    hypotheses: [
      {
        key: "historical-idempotency",
        statement: "当前事故重复了历史幂等锁冲突。",
        supportIf: "当前版本和系统事件呈现相同重试锁机制。",
        refuteIf: "异常跨版本且没有当前锁冲突证据。",
        expectedOutcome: "REJECTED",
      },
      {
        key: "inventory-eligibility",
        statement: "US 新用户库存或资格配置不足。",
        supportIf: "异常集中 US 新用户并出现库存或资格拒绝反馈。",
        refuteIf: "所有地区和用户类型同幅受影响。",
        expectedOutcome: "SUPPORTED",
      },
      {
        key: "provider-outage",
        statement: "第三方提供商故障导致领券失败。",
        supportIf: "跨地区和用户类型同步下降。",
        refuteIf: "异常只集中 US 新用户。",
        expectedOutcome: "WEAKENED",
      },
    ],
    evidence: [
      {
        key: "misleading-history",
        category: "SIMILAR_INCIDENT",
        family: "RAG",
        statement: "历史事故包含相似的超时和重复加载症状。",
        relations: {
          "historical-idempotency": "SUPPORTS",
          "inventory-eligibility": "NEUTRAL",
          "provider-outage": "NEUTRAL",
        },
      },
      {
        key: "us-new-user-segment",
        category: "SEGMENT_METRIC",
        family: "ANALYTICS",
        statement: "异常只集中 US 新用户，并横跨 Android 7.2.9 与 7.3.0。",
        relations: {
          "historical-idempotency": "CONTRADICTS",
          "inventory-eligibility": "SUPPORTS",
          "provider-outage": "CONTRADICTS",
        },
      },
      {
        key: "inventory-feedback",
        category: "USER_FEEDBACK",
        family: "FEEDBACK",
        statement: "US 新用户明确收到库存不足或资格拒绝提示。",
        relations: {
          "historical-idempotency": "CONTRADICTS",
          "inventory-eligibility": "SUPPORTS",
          "provider-outage": "NEUTRAL",
        },
      },
    ],
    requiredTools: ["query_metric", "segment_metric", "search_user_feedback", "search_similar_incidents"],
    forbiddenTools: ["rollback_release", "disable_feature_flag"],
    acceptableSelectedHypotheses: ["inventory-eligibility"],
    expectedDiagnosis: "US 新用户库存或资格配置不足。",
    expectedDisposition: "FIX",
    actionRequired: true,
    expectedVerificationOutcome: "PARTIALLY_RESOLVED",
    expectedFinalState: "PARTIALLY_RESOLVED",
    failureConditions: [
      "被相似历史事故锚定", "把 RAG 当当前机制证据", "忽略当前分群反证", "错误归因发布",
    ],
  },
] as const;
