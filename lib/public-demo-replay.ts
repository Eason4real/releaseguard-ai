import type {
  PublicDemoAuditEvent,
  PublicDemoAuditKind,
  PublicDemoBudget,
  PublicDemoDecision,
  PublicDemoDecisionStatus,
  PublicDemoDecisionType,
  PublicDemoDiagnosis,
  PublicDemoEvidence,
  PublicDemoEvidenceLink,
  PublicDemoHypothesis,
  PublicDemoReplayAction,
  PublicDemoReplayMode,
  PublicDemoReplaySnapshot,
  PublicDemoReplayState,
  PublicDemoReplayStep,
  PublicDemoToolCall,
} from "./public-demo-replay-types";

export const PUBLIC_DEMO_LIMITS = {
  maxModelCalls: 20,
  maxToolCalls: 10,
  maxIterations: 16,
} as const;

export const PUBLIC_DEMO_FIXTURE = {
  scenario: "Android 7.3.0 优惠券领取成功率下降",
  release: "Android 7.3.0",
  metric: "coupon_claim_success_rate",
  baseline: "96.4%",
  observed: "78.1%",
  recovered: "95.2%",
  workItemReference: "DEMO-WORK-ITEM-001",
} as const;

const hypothesisCatalog: Record<PublicDemoHypothesis["id"], Omit<PublicDemoHypothesis, "status">> = {
  H1: {
    id: "H1",
    statement: "Android 7.3.0 重试改动与 IdempotencyGuard 生命周期冲突。",
    supportIf: "异常集中于 7.3.0，且发布改动和真实失败反馈指向重试与幂等冲突。",
    refuteIf: "旧版本同样下降，或反馈只显示统计上报异常而无真实领取失败。",
  },
  H2: {
    id: "H2",
    statement: "第三方依赖导致所有版本同步失败。",
    supportIf: "Android 新旧版本及其他平台在同一窗口同步下降。",
    refuteIf: "只有 Android 7.3.0 明显下降，控制组保持稳定。",
  },
  H3: {
    id: "H3",
    statement: "成功事件漏报导致指标假性下降。",
    supportIf: "用户体验正常，但成功事件记录数量异常减少。",
    refuteIf: "用户反馈出现超时、重复加载与实际领券失败。",
  },
};

const evidenceCatalog: Record<PublicDemoEvidence["id"], PublicDemoEvidence> = {
  "E-RELEASE": {
    id: "E-RELEASE",
    title: "7.3.0 发布改动",
    observation: "CouponClaimService 新增服务端重试，并调整 IdempotencyGuard 生命周期。",
    sourceTool: "get_release",
    provenance: "DETERMINISTIC_FIXTURE",
  },
  "E-SEGMENT": {
    id: "E-SEGMENT",
    title: "版本分群对照",
    observation: "Android 7.3.0 为 78.1%，Android 7.2.9 保持 95.9%，iOS 7.3.0 保持 96.2%。",
    sourceTool: "segment_metric",
    provenance: "DETERMINISTIC_FIXTURE",
  },
  "E-FEEDBACK": {
    id: "E-FEEDBACK",
    title: "领取失败反馈主题",
    observation: "受影响用户集中报告超时、重复加载和优惠券未到账。",
    sourceTool: "search_user_feedback",
    provenance: "DETERMINISTIC_FIXTURE",
  },
};

const diagnosis: PublicDemoDiagnosis = {
  selectedHypothesisId: "H1",
  confidence: "HIGH",
  rootCause: "Android 7.3.0 的重试改动与 IdempotencyGuard 生命周期冲突，导致真实优惠券领取失败。",
  causalChain: "7.3.0 重试改动 → 幂等锁提前释放 → 重复请求竞争 → 领取失败率上升",
  proposedAction: "创建受审批的修复工作项：恢复幂等锁覆盖范围，并增加重试回归验证。",
};

const hypothesis = (
  id: PublicDemoHypothesis["id"],
  status: PublicDemoHypothesis["status"],
): PublicDemoHypothesis => ({ ...hypothesisCatalog[id], status });

const budget = (
  modelCallsUsed: number,
  toolCallsUsed: number,
  iterationsUsed: number,
): PublicDemoBudget => ({ ...PUBLIC_DEMO_LIMITS, modelCallsUsed, toolCallsUsed, iterationsUsed });

const validDecision = (
  type: PublicDemoDecisionType,
  modelCallOrdinal: number,
  serverSummary: string,
  publicRationale: string,
  status: Exclude<PublicDemoDecisionStatus, "REJECTED"> = "ACCEPTED",
  repairAttempt: 0 | 1 = 0,
): PublicDemoDecision => ({
  type,
  status,
  plannerState: status,
  modelCallOrdinal,
  repairAttempt,
  serverSummary,
  publicRationale,
  validation: {
    schema: "VALID",
    semantic: "VALID",
    errorType: null,
    code: null,
    path: null,
  },
});

const rejectedDecision = (
  modelCallOrdinal: number,
): PublicDemoDecision => ({
  type: "ASSESS_EVIDENCE",
  status: "REJECTED",
  plannerState: "REJECTED",
  modelCallOrdinal,
  repairAttempt: 0,
  serverSummary: "响应未通过 typed decision contract，未被 AgentLoop 接受。",
  publicRationale: "故障注入响应将 evidenceId 错放在 decision 顶层。",
  validation: {
    schema: "INVALID",
    semantic: "NOT_RUN",
    errorType: "PlannerDecisionValidationError",
    code: "INVALID_PLANNER_DECISION",
    path: "assessments[0].evidenceId",
  },
});

type AuditInput = [
  kind: PublicDemoAuditKind,
  label: string,
  status: PublicDemoAuditEvent["status"],
  source?: PublicDemoAuditEvent["source"],
];

const audits = (
  stepSequence: number,
  offsetSeconds: number,
  entries: AuditInput[],
): PublicDemoAuditEvent[] => entries.map(([kind, label, status, source], index) => ({
  id: `AUD-${stepSequence.toString().padStart(2, "0")}-${index.toString().padStart(2, "0")}`,
  kind,
  label,
  source: source ?? "REPLAY_FIXTURE",
  offsetSeconds,
  tieBreaker: stepSequence * 100 + index,
  status,
}));

const acceptedAudits = (
  stepSequence: number,
  offsetSeconds: number,
  decisionType: PublicDemoDecisionType,
  extras: AuditInput[] = [],
  repaired = false,
) => audits(stepSequence, offsetSeconds, [
  ...(repaired ? [["REPAIR_ATTEMPTED", "bounded repair 已预留同一 iteration 的第二次模型调用", "OBSERVED"] as AuditInput] : []),
  ["PLANNER_RESPONSE_OBSERVED", `${decisionType} 响应结构已安全观测`, "OBSERVED"],
  ["DECISION_VALIDATED", "Schema 与 semantic validation 通过", "VALID"],
  ["DECISION_ACCEPTED", `${decisionType} decision 已接受`, "ACCEPTED"],
  ...extras,
]);

const callTool = (
  name: PublicDemoToolCall["name"],
  argumentsSummary: string,
  resultSummary: string,
): PublicDemoToolCall => ({ name, status: "SUCCESS", argumentsSummary, resultSummary });

const normalSteps: readonly PublicDemoReplayStep[] = [
  {
    id: "detect",
    sequence: 0,
    stage: "DETECTED",
    phase: "Detect",
    title: "确定性规则发现发布风险",
    summary: `${PUBLIC_DEMO_FIXTURE.metric} 从 ${PUBLIC_DEMO_FIXTURE.baseline} 降至 ${PUBLIC_DEMO_FIXTURE.observed}。`,
    iteration: null,
    decision: null,
    budget: budget(0, 0, 0),
    toolCall: null,
    hypothesisUpdates: [],
    evidenceCreated: [],
    relationUpdates: [],
    businessObjects: ["RiskEvent fixture"],
    outcome: {},
    auditEvents: audits(0, 0, [["RISK_DETECTED", "coupon_claim_success_rate 异常已检测", "SUCCESS"]]),
  },
  {
    id: "create-hypotheses",
    sequence: 1,
    stage: "INVESTIGATING",
    phase: "Planner",
    title: "建立三个竞争假设",
    summary: "Agent 明确每个假设的支持条件和反驳条件，再选择调查工具。",
    iteration: 1,
    decision: validDecision(
      "CREATE_HYPOTHESES",
      1,
      "创建 3 个 active hypothesis，未超过服务端上限。",
      "先保留发布回归、第三方故障和指标漏报三种解释，避免过早锁定根因。",
    ),
    budget: budget(1, 0, 1),
    toolCall: null,
    hypothesisUpdates: [hypothesis("H1", "ACTIVE"), hypothesis("H2", "ACTIVE"), hypothesis("H3", "ACTIVE")],
    evidenceCreated: [],
    relationUpdates: [],
    businessObjects: ["Hypothesis H1", "Hypothesis H2", "Hypothesis H3"],
    outcome: {},
    auditEvents: acceptedAudits(1, 4, "CREATE_HYPOTHESES"),
  },
  {
    id: "get-release",
    sequence: 2,
    stage: "INVESTIGATING",
    phase: "Tool",
    title: "检查 Android 7.3.0 发布改动",
    summary: "Planner 选择 get_release，验证异常窗口是否有相关代码与配置变更。",
    iteration: 2,
    decision: validDecision(
      "CALL_TOOL",
      2,
      "get_release 在可见只读工具集合中，参数与 H1/H2 的判别目标有效。",
      "发布相关性是区分版本回归与全局第三方故障的第一项服务端可验证事实。",
    ),
    budget: budget(2, 1, 2),
    toolCall: callTool(
      "get_release",
      "releaseId=REL-ANDROID-730",
      "FULL rollout；changedModules=CouponClaimService, IdempotencyGuard；featureFlag=coupon_claim_server_retry",
    ),
    hypothesisUpdates: [],
    evidenceCreated: [evidenceCatalog["E-RELEASE"]],
    relationUpdates: [],
    businessObjects: ["ToolCall", "ToolResult", "Evidence E-RELEASE"],
    outcome: {},
    auditEvents: acceptedAudits(2, 8, "CALL_TOOL", [
      ["TOOL_CALL_STARTED", "get_release 调用开始", "OBSERVED"],
      ["TOOL_RESULT_RECORDED", "get_release 返回规范化 SUCCESS", "SUCCESS"],
      ["EVIDENCE_CREATED", "由 ToolResult 解释生成 E-RELEASE", "SUCCESS"],
    ]),
  },
  {
    id: "assess-release",
    sequence: 3,
    stage: "INVESTIGATING",
    phase: "Assessment",
    title: "评估发布改动证据",
    summary: "版本改动支持 H1，但单一相关性尚不足以形成 Diagnosis。",
    iteration: 3,
    decision: validDecision(
      "ASSESS_EVIDENCE",
      3,
      "E-RELEASE 与 active H1 均存在，SUPPORTS relation 通过语义校验。",
      "重试与幂等模块同时变化，值得继续用版本分群验证影响范围。",
    ),
    budget: budget(3, 1, 3),
    toolCall: null,
    hypothesisUpdates: [hypothesis("H1", "SUPPORTED")],
    evidenceCreated: [],
    relationUpdates: [{
      evidenceId: "E-RELEASE",
      targetHypothesisId: "H1",
      relation: "SUPPORTS",
      explanation: "发布改动直接涉及 H1 指向的重试与幂等生命周期。",
    }],
    businessObjects: ["HypothesisEvidenceLink"],
    outcome: {},
    auditEvents: acceptedAudits(3, 12, "ASSESS_EVIDENCE", [
      ["EVIDENCE_ASSESSED", "E-RELEASE → H1 · SUPPORTS", "SUCCESS"],
    ]),
  },
  {
    id: "segment-metric",
    sequence: 4,
    stage: "INVESTIGATING",
    phase: "Tool",
    title: "比较 7.3.0 与控制版本",
    summary: "Planner 选择 segment_metric，检查问题是否只发生在新版本。",
    iteration: 4,
    decision: validDecision(
      "CALL_TOOL",
      4,
      "segment_metric 参数限定 metric、platform 与 appVersion，目标 H1/H2 均为 active。",
      "版本控制组能直接区分新版本回归与所有版本同步失败。",
    ),
    budget: budget(4, 2, 4),
    toolCall: callTool(
      "segment_metric",
      "metric=coupon_claim_success_rate；dimension=appVersion；platform=Android",
      "7.3.0=78.1%；7.2.9=95.9%；iOS 7.3.0=96.2%",
    ),
    hypothesisUpdates: [],
    evidenceCreated: [evidenceCatalog["E-SEGMENT"]],
    relationUpdates: [],
    businessObjects: ["ToolCall", "ToolResult", "Evidence E-SEGMENT"],
    outcome: {},
    auditEvents: acceptedAudits(4, 16, "CALL_TOOL", [
      ["TOOL_CALL_STARTED", "segment_metric 调用开始", "OBSERVED"],
      ["TOOL_RESULT_RECORDED", "segment_metric 返回规范化 SUCCESS", "SUCCESS"],
      ["EVIDENCE_CREATED", "由 ToolResult 解释生成 E-SEGMENT", "SUCCESS"],
    ]),
  },
  {
    id: "assess-segment",
    sequence: 5,
    stage: "INVESTIGATING",
    phase: "Assessment",
    title: "用控制组反驳全局故障",
    summary: "相同窗口内旧版本稳定，支持 H1 并反驳 H2。",
    iteration: 5,
    decision: validDecision(
      "ASSESS_EVIDENCE",
      5,
      "E-SEGMENT 同时形成一条 SUPPORTS 和一条 CONTRADICTS relation。",
      "异常被版本边界隔离，第三方依赖导致所有版本同步失败的解释不成立。",
    ),
    budget: budget(5, 2, 5),
    toolCall: null,
    hypothesisUpdates: [hypothesis("H1", "SUPPORTED"), hypothesis("H2", "REJECTED")],
    evidenceCreated: [],
    relationUpdates: [
      {
        evidenceId: "E-SEGMENT",
        targetHypothesisId: "H1",
        relation: "SUPPORTS",
        explanation: "异常集中于包含重试改动的 Android 7.3.0。",
      },
      {
        evidenceId: "E-SEGMENT",
        targetHypothesisId: "H2",
        relation: "CONTRADICTS",
        explanation: "旧 Android 与 iOS 控制组稳定，反驳所有版本同步失败。",
      },
    ],
    businessObjects: ["HypothesisEvidenceLink × 2"],
    outcome: {},
    auditEvents: acceptedAudits(5, 20, "ASSESS_EVIDENCE", [
      ["EVIDENCE_ASSESSED", "E-SEGMENT → H1 SUPPORTS；→ H2 CONTRADICTS", "SUCCESS"],
    ]),
  },
  {
    id: "search-feedback",
    sequence: 6,
    stage: "INVESTIGATING",
    phase: "Tool",
    title: "检索真实用户体验信号",
    summary: "Planner 选择 search_user_feedback，区分真实领取失败与成功事件漏报。",
    iteration: 6,
    decision: validDecision(
      "CALL_TOOL",
      6,
      "search_user_feedback 为只读检索，时间与版本过滤有效，目标 H1/H3 为 active。",
      "用户体验反馈可以验证业务失败是否真实发生，而不只依赖埋点指标。",
    ),
    budget: budget(6, 3, 6),
    toolCall: callTool(
      "search_user_feedback",
      "platform=Android；appVersion=7.3.0；themes=timeout, repeated_loading, claim_failed",
      "负面反馈集中于超时、重复加载与优惠券未到账；结果为聚合主题和脱敏样本摘要",
    ),
    hypothesisUpdates: [],
    evidenceCreated: [evidenceCatalog["E-FEEDBACK"]],
    relationUpdates: [],
    businessObjects: ["ToolCall", "ToolResult", "Evidence E-FEEDBACK"],
    outcome: {},
    auditEvents: acceptedAudits(6, 24, "CALL_TOOL", [
      ["TOOL_CALL_STARTED", "search_user_feedback 调用开始", "OBSERVED"],
      ["TOOL_RESULT_RECORDED", "反馈检索返回规范化 SUCCESS", "SUCCESS"],
      ["EVIDENCE_CREATED", "由 ToolResult 解释生成 E-FEEDBACK", "SUCCESS"],
    ]),
  },
  {
    id: "assess-feedback",
    sequence: 7,
    stage: "INVESTIGATING",
    phase: "Assessment",
    title: "验证真实失败并反驳漏报",
    summary: "反馈支持 H1 描述的真实领取失败，并反驳 H3 的纯埋点解释。",
    iteration: 7,
    decision: validDecision(
      "ASSESS_EVIDENCE",
      7,
      "E-FEEDBACK 的 evidenceId、目标 hypothesis 与 relation 均通过服务端校验。",
      "用户明确遭遇超时与未到账，说明业务失败真实存在。",
    ),
    budget: budget(7, 3, 7),
    toolCall: null,
    hypothesisUpdates: [hypothesis("H1", "SUPPORTED"), hypothesis("H3", "REJECTED")],
    evidenceCreated: [],
    relationUpdates: [
      {
        evidenceId: "E-FEEDBACK",
        targetHypothesisId: "H1",
        relation: "SUPPORTS",
        explanation: "超时与未到账反馈符合重试竞争导致的真实失败。",
      },
      {
        evidenceId: "E-FEEDBACK",
        targetHypothesisId: "H3",
        relation: "CONTRADICTS",
        explanation: "用户实际未领取成功，不能由成功事件漏报单独解释。",
      },
    ],
    businessObjects: ["HypothesisEvidenceLink × 2"],
    outcome: {},
    auditEvents: acceptedAudits(7, 28, "ASSESS_EVIDENCE", [
      ["EVIDENCE_ASSESSED", "E-FEEDBACK → H1 SUPPORTS；→ H3 CONTRADICTS", "SUCCESS"],
    ]),
  },
  {
    id: "finalize",
    sequence: 8,
    stage: "WAITING_APPROVAL",
    phase: "Diagnosis",
    title: "形成 Grounded Diagnosis",
    summary: "服务端在多源证据与反证覆盖满足条件后接受 FINALIZE。",
    iteration: 8,
    decision: validDecision(
      "FINALIZE",
      8,
      "H1 有独立发布、分群和反馈证据；H2/H3 已被反证；Diagnosis claims 均可追溯。",
      "证据覆盖足以选择 H1，并建议一个受人工审批约束的修复工作项。",
    ),
    budget: budget(8, 3, 8),
    toolCall: null,
    hypothesisUpdates: [hypothesis("H1", "SELECTED")],
    evidenceCreated: [],
    relationUpdates: [],
    businessObjects: ["Diagnosis", "ProposedAction", "ApprovalSnapshot"],
    outcome: { diagnosis },
    auditEvents: acceptedAudits(8, 32, "FINALIZE", [
      ["DIAGNOSIS_CREATED", "Grounded Diagnosis 与 ProposedAction 已创建", "SUCCESS"],
    ]),
  },
  {
    id: "approval",
    sequence: 9,
    stage: "APPROVED",
    phase: "Human Approval",
    title: "人工批准模拟方案",
    summary: "批准绑定冻结的 ProposedAction；Public Demo 只更新当前标签页内存。",
    iteration: null,
    decision: null,
    budget: budget(8, 3, 8),
    toolCall: null,
    hypothesisUpdates: [],
    evidenceCreated: [],
    relationUpdates: [],
    businessObjects: ["Approval"],
    outcome: { approvalGranted: true },
    auditEvents: audits(9, 36, [["APPROVAL_GRANTED", "模拟方案已由 Demo operator 批准", "ACCEPTED", "DEMO_OPERATOR"]]),
  },
  {
    id: "simulated-action",
    sequence: 10,
    stage: "ACTION_SIMULATED",
    phase: "Recoverable Action",
    title: "模拟创建本地工作项",
    summary: "只生成本地引用 DEMO-WORK-ITEM-001；不调用 GitHub，不生成外部 URL。",
    iteration: null,
    decision: null,
    budget: budget(8, 3, 8),
    toolCall: null,
    hypothesisUpdates: [],
    evidenceCreated: [],
    relationUpdates: [],
    businessObjects: ["Local demo work item"],
    outcome: { workItemReference: PUBLIC_DEMO_FIXTURE.workItemReference },
    auditEvents: audits(10, 40, [["ACTION_SIMULATED", "本地工作项 DEMO-WORK-ITEM-001 已模拟创建", "SUCCESS"]]),
  },
  {
    id: "action-completion",
    sequence: 11,
    stage: "ACTION_COMPLETED",
    phase: "Action Completion",
    title: "确认模拟 Action Completion",
    summary: "恢复语义在本地确定性 replay 中完成，不触发任何外部写入。",
    iteration: null,
    decision: null,
    budget: budget(8, 3, 8),
    toolCall: null,
    hypothesisUpdates: [],
    evidenceCreated: [],
    relationUpdates: [],
    businessObjects: ["ActionCompletion"],
    outcome: { actionCompleted: true },
    auditEvents: audits(11, 44, [["ACTION_COMPLETED", "模拟 Action Completion 已确认", "SUCCESS", "DEMO_OPERATOR"]]),
  },
  {
    id: "verification",
    sequence: 12,
    stage: "VERIFIED",
    phase: "Verification",
    title: "验证恢复窗口",
    summary: `静态恢复窗口显示成功率回到 ${PUBLIC_DEMO_FIXTURE.recovered}，回放停在 VERIFIED。`,
    iteration: null,
    decision: null,
    budget: budget(8, 3, 8),
    toolCall: null,
    hypothesisUpdates: [],
    evidenceCreated: [],
    relationUpdates: [],
    businessObjects: ["VerificationResult"],
    outcome: { verificationRate: PUBLIC_DEMO_FIXTURE.recovered },
    auditEvents: audits(12, 48, [["VERIFICATION_COMPLETED", "确定性恢复验证完成：95.2%", "SUCCESS"]]),
  },
];

const faultRejectedStep: PublicDemoReplayStep = {
  id: "fault-assess-release-rejected",
  sequence: 3,
  stage: "INVESTIGATING",
  phase: "Fault Injection",
  title: "拒绝扁平化 ASSESS_EVIDENCE",
  summary: "故障注入响应把 evidenceId 放在顶层；typed schema validation 拒绝该 decision。",
  iteration: 3,
  decision: rejectedDecision(3),
  budget: budget(3, 1, 3),
  toolCall: null,
  hypothesisUpdates: [],
  evidenceCreated: [],
  relationUpdates: [],
  businessObjects: [],
  outcome: {},
  auditEvents: audits(3, 12, [
    ["PLANNER_RESPONSE_OBSERVED", "故障注入响应结构已安全观测", "OBSERVED"],
    ["DECISION_REJECTED", "PlannerDecisionValidationError：assessments[0].evidenceId", "REJECTED"],
  ]),
};

const repairedAssessStep: PublicDemoReplayStep = {
  ...normalSteps[3],
  id: "fault-assess-release-repaired",
  sequence: 4,
  title: "同一 iteration 完成 bounded repair",
  summary: "repair 消耗一次模型调用额度；合法 decision 通过校验后才进入 accepted trace。",
  decision: validDecision(
    "ASSESS_EVIDENCE",
    4,
    "repair 保持 iteration=3；嵌套 assessments contract 与 evidence/hypothesis 引用均有效。",
    "根据 typed validation feedback 修复结构，不改变证据结论。",
    "REPAIRED",
    1,
  ),
  budget: budget(4, 1, 3),
  auditEvents: acceptedAudits(4, 16, "ASSESS_EVIDENCE", [
    ["EVIDENCE_ASSESSED", "E-RELEASE → H1 · SUPPORTS", "SUCCESS"],
  ], true),
};

const faultSteps: readonly PublicDemoReplayStep[] = [
  ...normalSteps.slice(0, 3),
  faultRejectedStep,
  repairedAssessStep,
  ...normalSteps.slice(4).map((step) => {
    const decision = step.decision
      ? { ...step.decision, modelCallOrdinal: step.decision.modelCallOrdinal + 1 }
      : null;
    return {
      ...step,
      sequence: step.sequence + 1,
      decision,
      budget: {
        ...step.budget,
        modelCallsUsed: step.budget.modelCallsUsed + 1,
      },
      auditEvents: step.auditEvents.map((event) => ({
        ...event,
        id: `FAULT-${event.id}`,
        tieBreaker: event.tieBreaker + 100,
        offsetSeconds: event.offsetSeconds + 4,
      })),
    };
  }),
];

export function getPublicDemoReplaySteps(mode: PublicDemoReplayMode) {
  return mode === "FAULT_INJECTION" ? faultSteps : normalSteps;
}

export function createPublicDemoReplayState(
  mode: PublicDemoReplayMode = "NORMAL",
): PublicDemoReplayState {
  return { mode, cursor: -1, playback: "PAUSED" };
}

export function publicDemoReplayReducer(
  state: PublicDemoReplayState,
  action: PublicDemoReplayAction,
): PublicDemoReplayState {
  const steps = getPublicDemoReplaySteps(state.mode);
  if (action.type === "SET_MODE") return createPublicDemoReplayState(action.mode);
  if (action.type === "RESET") return createPublicDemoReplayState(state.mode);
  if (action.type === "PAUSE") return { ...state, playback: "PAUSED" };
  if (action.type === "PLAY") {
    return state.cursor >= steps.length - 1
      ? state
      : { ...state, playback: "PLAYING" };
  }
  if (action.type === "PREVIOUS") {
    return { ...state, cursor: Math.max(-1, state.cursor - 1), playback: "PAUSED" };
  }
  if (state.cursor >= steps.length - 1) return { ...state, playback: "PAUSED" };
  const cursor = state.cursor + 1;
  return {
    ...state,
    cursor,
    playback: cursor >= steps.length - 1 ? "PAUSED" : state.playback,
  };
}

export function selectPublicDemoReplay(
  state: PublicDemoReplayState,
): PublicDemoReplaySnapshot {
  const steps = getPublicDemoReplaySteps(state.mode);
  const applied = steps.slice(0, state.cursor + 1);
  const hypotheses = new Map<PublicDemoHypothesis["id"], PublicDemoHypothesis>();
  const evidence = new Map<PublicDemoEvidence["id"], PublicDemoEvidence>();
  const relations = new Map<string, PublicDemoEvidenceLink>();
  let selectedDiagnosis: PublicDemoDiagnosis | null = null;
  let approvalGranted = false;
  let workItemReference: string | null = null;
  let actionCompleted = false;
  let verificationRate: string | null = null;

  for (const step of applied) {
    for (const item of step.hypothesisUpdates) hypotheses.set(item.id, { ...item });
    for (const item of step.evidenceCreated) evidence.set(item.id, { ...item });
    for (const item of step.relationUpdates) {
      relations.set(`${item.evidenceId}:${item.targetHypothesisId}`, { ...item });
    }
    if (step.outcome.diagnosis) selectedDiagnosis = { ...step.outcome.diagnosis };
    if (step.outcome.approvalGranted) approvalGranted = true;
    if (step.outcome.workItemReference) workItemReference = step.outcome.workItemReference;
    if (step.outcome.actionCompleted) actionCompleted = true;
    if (step.outcome.verificationRate) verificationRate = step.outcome.verificationRate;
  }

  const auditEvents = applied.flatMap((step) => step.auditEvents).sort((left, right) =>
    left.offsetSeconds - right.offsetSeconds
    || left.tieBreaker - right.tieBreaker
    || left.id.localeCompare(right.id));

  return {
    stage: applied.at(-1)?.stage ?? "IDLE",
    currentStep: applied.at(-1) ?? null,
    steps,
    hypotheses: [...hypotheses.values()],
    evidence: [...evidence.values()],
    relations: [...relations.values()],
    auditEvents,
    diagnosis: selectedDiagnosis,
    approvalGranted,
    workItemReference,
    actionCompleted,
    verificationRate,
  };
}

export function assertPublicDemoReplayDefinition(steps: readonly PublicDemoReplayStep[]) {
  const hypothesisIds = new Set<PublicDemoHypothesis["id"]>();
  const evidenceIds = new Set<PublicDemoEvidence["id"]>();
  const repairAttempts = new Map<number, number>();
  let previousModelCallOrdinal = 0;
  let hasSupportingEvidence = false;
  let hasContradictedAlternative = false;

  for (const step of steps) {
    if (step.decision) {
      if (step.decision.modelCallOrdinal !== previousModelCallOrdinal + 1) {
        throw new Error(`Replay model-call ordinal is not contiguous at ${step.id}.`);
      }
      previousModelCallOrdinal = step.decision.modelCallOrdinal;
      if (step.budget.modelCallsUsed !== step.decision.modelCallOrdinal) {
        throw new Error(`Replay model-call budget does not match ordinal at ${step.id}.`);
      }
      if (step.decision.repairAttempt > 0) {
        if (step.iteration === null) throw new Error("Replay repair requires an iteration.");
        const attempts = (repairAttempts.get(step.iteration) ?? 0) + 1;
        repairAttempts.set(step.iteration, attempts);
        if (attempts > 1) throw new Error("Replay bounded repair exceeds one attempt.");
      }
    }

    if (step.decision?.status === "REJECTED") {
      if (step.auditEvents.some((event) => event.kind === "DECISION_ACCEPTED")) {
        throw new Error("Rejected replay decision cannot have an accepted audit.");
      }
      if (
        step.toolCall
        || step.evidenceCreated.length > 0
        || step.relationUpdates.length > 0
        || step.businessObjects.length > 0
      ) {
        throw new Error("Rejected replay decision cannot create business artifacts.");
      }
    }

    for (const item of step.hypothesisUpdates) hypothesisIds.add(item.id);
    if (step.evidenceCreated.length > 0) {
      if (!step.toolCall || step.toolCall.status !== "SUCCESS") {
        throw new Error(`Replay evidence requires a successful ToolCall at ${step.id}.`);
      }
      const toolAuditIndex = step.auditEvents.findIndex((event) => event.kind === "TOOL_CALL_STARTED");
      const evidenceAuditIndex = step.auditEvents.findIndex((event) => event.kind === "EVIDENCE_CREATED");
      if (toolAuditIndex < 0 || evidenceAuditIndex <= toolAuditIndex) {
        throw new Error(`Replay evidence precedes its ToolCall at ${step.id}.`);
      }
      for (const item of step.evidenceCreated) evidenceIds.add(item.id);
    }

    for (const relation of step.relationUpdates) {
      if (!evidenceIds.has(relation.evidenceId) || !hypothesisIds.has(relation.targetHypothesisId)) {
        throw new Error(`Replay relation references an unavailable object at ${step.id}.`);
      }
      if (relation.relation === "SUPPORTS") hasSupportingEvidence = true;
      if (relation.relation === "CONTRADICTS") hasContradictedAlternative = true;
    }

    if (step.decision?.type === "FINALIZE") {
      if (!hasSupportingEvidence || !hasContradictedAlternative || !step.outcome.diagnosis) {
        throw new Error("Replay FINALIZE is not grounded in supporting and contradicting evidence.");
      }
    }
  }
}

assertPublicDemoReplayDefinition(normalSteps);
assertPublicDemoReplayDefinition(faultSteps);
