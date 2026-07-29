export const PUBLIC_DEMO_STAGES = [
  "IDLE",
  "INVESTIGATED",
  "APPROVED",
  "ACTION_SIMULATED",
  "ACTION_COMPLETED",
  "VERIFIED",
] as const;

export type PublicDemoStage = (typeof PUBLIC_DEMO_STAGES)[number];
export type PublicDemoEvent =
  | "RUN_INVESTIGATION"
  | "APPROVE"
  | "SIMULATE_ACTION"
  | "COMPLETE_ACTION"
  | "VERIFY"
  | "RESET";

export type PublicDemoState = {
  stage: PublicDemoStage;
  timestamps: Partial<Record<Exclude<PublicDemoStage, "IDLE">, string>>;
};

export const PUBLIC_DEMO_FIXTURE = {
  release: "Android 7.3.0",
  metric: "coupon_claim_success_rate",
  baseline: "96.4%",
  observed: "78.1%",
  diagnosis: "Android 7.3.0 的重试改动与幂等锁生命周期冲突，导致优惠券领取失败。",
  recommendation: "创建模拟修复工作项，确认完成后运行确定性恢复验证。",
  workItemReference: "DEMO-WORK-ITEM-001",
  hypotheses: [
    {
      status: "SUPPORTED",
      title: "7.3.0 重试改动与幂等锁冲突",
      detail: "版本分群、发布改动和用户反馈共同支持该假设。",
    },
    {
      status: "REJECTED",
      title: "第三方依赖导致所有版本同步失败",
      detail: "旧版本控制组保持稳定，构成明确反证。",
    },
    {
      status: "WEAKENED",
      title: "成功事件漏报造成指标假性下降",
      detail: "用户反馈显示真实领取失败，不只是埋点缺失。",
    },
  ],
  evidence: [
    ["版本改动", "Release fixture", "7.3.0 修改了 CouponClaimService 与 IdempotencyGuard。"],
    ["业务指标", "Analytics fixture", "成功率从动态基线 96.4% 降至 78.1%。"],
    ["分群指标", "Analytics fixture", "异常集中于 Android 7.3.0，旧版本稳定。"],
    ["用户反馈", "Feedback fixture", "出现超时、重复加载和领券失败反馈。"],
  ],
} as const;

export function createPublicDemoState(): PublicDemoState {
  return { stage: "IDLE", timestamps: {} };
}

const transitions: Record<Exclude<PublicDemoEvent, "RESET">, [PublicDemoStage, PublicDemoStage]> = {
  RUN_INVESTIGATION: ["IDLE", "INVESTIGATED"],
  APPROVE: ["INVESTIGATED", "APPROVED"],
  SIMULATE_ACTION: ["APPROVED", "ACTION_SIMULATED"],
  COMPLETE_ACTION: ["ACTION_SIMULATED", "ACTION_COMPLETED"],
  VERIFY: ["ACTION_COMPLETED", "VERIFIED"],
};

export function transitionPublicDemo(
  state: PublicDemoState,
  event: PublicDemoEvent,
  now = new Date().toISOString(),
): PublicDemoState {
  if (event === "RESET") return createPublicDemoState();
  const [from, to] = transitions[event];
  if (state.stage !== from) return state;
  return { stage: to, timestamps: { ...state.timestamps, [to]: now } };
}

export function publicDemoAuditRows(state: PublicDemoState) {
  const rows = [
    ["INVESTIGATED", "Deterministic Agent", "完成静态调查、假设评价与 Diagnosis"],
    ["APPROVED", "Demo operator", "批准模拟处置方案"],
    ["ACTION_SIMULATED", "Demo Action", `模拟创建工作项 ${PUBLIC_DEMO_FIXTURE.workItemReference}`],
    ["ACTION_COMPLETED", "Demo operator", "确认模拟 Action Completion"],
    ["VERIFIED", "Deterministic Verifier", "验证指标恢复，演示闭环完成"],
  ] as const;
  return rows.flatMap(([stage, actor, action]) => {
    const at = state.timestamps[stage];
    return at ? [{ stage, at, actor, action, derived: true as const }] : [];
  });
}
