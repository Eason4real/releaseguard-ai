import {
  callModel,
  parseModelFinalization,
  type ModelConfig,
  type ModelMessage,
} from "./model";
import { modelToolDefinitions } from "./tools";
import {
  GROUNDING_REPAIR_DECISION_TYPES,
  PLANNER_STOP_REASON_CODES,
  PLANNER_WAIT_REASON_CODES,
  type InvestigationDecision,
  type InvestigationPlanner,
  type PlannerContext,
  type PlannerResponseStructureObservation,
  type PlannerModelCallObservation,
  type PlannerDecisionValidationCode,
  type PlannerDecisionValidationObservation,
} from "./planner";
import type { InvestigationAggregate } from "./types";
import { getActiveHypotheses, getPendingEvidence } from "./hypothesis-invariants";
import { ModelCallBudgetExhaustedError } from "./model-call-budget";
import {
  PlannerDecisionSemanticError,
  validatePlannerDecisionSemantics,
} from "./planner-decision-semantics";

const DECISION_TYPES = [
  "CREATE_HYPOTHESES",
  "ASSESS_EVIDENCE",
  "CALL_TOOL",
  "ASK_HUMAN",
  "FINALIZE",
  "STOP_INCONCLUSIVE",
] as const satisfies readonly InvestigationDecision["type"][];

const KNOWN_SLICE_DIMENSIONS = [
  "platform",
  "app_version",
  "region",
  "user_type",
  "rollout",
] as const;

export type KnownInvestigationSlice = {
  dimension: (typeof KNOWN_SLICE_DIMENSIONS)[number];
  values: Array<string | number>;
  unit: "PERCENT" | null;
  sources: string[];
};

type KnownSliceAggregate = Pick<
  InvestigationAggregate,
  "riskEvent" | "release" | "toolCalls" | "evidence"
>;

const structuredRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const structuredText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const structuredNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const knownSliceDimension = (value: unknown) => {
  const candidate = structuredText(value);
  return candidate && KNOWN_SLICE_DIMENSIONS.includes(
    candidate as (typeof KNOWN_SLICE_DIMENSIONS)[number],
  )
    ? candidate as (typeof KNOWN_SLICE_DIMENSIONS)[number]
    : null;
};

const rolloutPercent = (value: unknown) => {
  const candidate = structuredNumber(value);
  if (candidate === null || candidate < 0) return null;
  const percent = candidate <= 1 ? candidate * 100 : candidate;
  if (percent > 100) return null;
  return Math.round(percent * 1_000) / 1_000;
};

export const buildKnownInvestigationSlices = (
  aggregate: KnownSliceAggregate,
): KnownInvestigationSlice[] => {
  const values = new Map<KnownInvestigationSlice["dimension"], Map<string, string | number>>();
  const sources = new Map<KnownInvestigationSlice["dimension"], Set<string>>();
  const add = (
    dimension: KnownInvestigationSlice["dimension"],
    value: unknown,
    source: string,
  ) => {
    const normalized = dimension === "rollout"
      ? rolloutPercent(value)
      : structuredText(value);
    if (normalized === null) return;
    const key = `${typeof normalized}:${String(normalized).toLocaleLowerCase()}`;
    const dimensionValues = values.get(dimension) ?? new Map<string, string | number>();
    dimensionValues.set(key, normalized);
    values.set(dimension, dimensionValues);
    const dimensionSources = sources.get(dimension) ?? new Set<string>();
    dimensionSources.add(source);
    sources.set(dimension, dimensionSources);
  };
  const addFilters = (value: unknown, source: string) => {
    const filters = structuredRecord(value);
    add("platform", filters.platform, source);
    add("app_version", filters.appVersion, source);
    add("region", filters.region, source);
    add("user_type", filters.userType, source);
  };
  const addScope = (value: unknown, source: string) => {
    const scope = structuredRecord(value);
    add("platform", scope.platform, source);
    add("app_version", scope.appVersion ?? scope.version, source);
    add("region", scope.region, source);
    add("user_type", scope.userType, source);
  };

  addFilters(aggregate.riskEvent?.filters, "RISK_EVENT");
  if (aggregate.release) {
    add("platform", aggregate.release.platform, "RELEASE");
    add("app_version", aggregate.release.version, "RELEASE");
    add("rollout", aggregate.release.rolloutPercentage, "RELEASE");
  }

  for (const call of aggregate.toolCalls.filter((item) => item.proposedActionId === null)) {
    const argumentSource = `TOOL_ARGUMENT:${call.name}`;
    addFilters(call.arguments.filters, argumentSource);
    addScope(call.arguments, argumentSource);
    if (!call.result) continue;

    const resultSource = `TOOL_RESULT:${call.name}`;
    const output = structuredRecord(call.result.output);
    const query = structuredRecord(output.query);
    const data = structuredRecord(output.data);
    addFilters(query.filters, resultSource);
    addScope(query, resultSource);
    addScope(data, resultSource);
    const rolloutSteps = Array.isArray(data.rolloutSteps) ? data.rolloutSteps : [];
    for (const step of rolloutSteps) add("rollout", step, resultSource);

    const dimension = knownSliceDimension(data.dimension ?? query.dimension);
    const breakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
    if (dimension && dimension !== "rollout") {
      for (const item of breakdown) {
        const entry = structuredRecord(item);
        add(dimension, entry.segment_value ?? entry.value, resultSource);
      }
    }

    const evidenceCategories = aggregate.evidence
      .filter((item) => item.toolResultId === call.result?.id)
      .map((item) => item.category);
    if (evidenceCategories.length > 0) {
      for (const dimensionWithResult of KNOWN_SLICE_DIMENSIONS) {
        if (!sources.get(dimensionWithResult)?.has(resultSource)) continue;
        for (const category of evidenceCategories) {
          sources.get(dimensionWithResult)?.add(`PERSISTED_EVIDENCE:${category}`);
        }
      }
    }
  }

  return KNOWN_SLICE_DIMENSIONS.flatMap((dimension) => {
    const dimensionValues = values.get(dimension);
    if (!dimensionValues?.size) return [];
    const orderedValues = [...dimensionValues.values()].sort((left, right) =>
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right)));
    return [{
      dimension,
      values: orderedValues,
      unit: dimension === "rollout" ? "PERCENT" as const : null,
      sources: [...(sources.get(dimension) ?? [])],
    }];
  });
};

const isDecisionType = (value: string): value is InvestigationDecision["type"] =>
  DECISION_TYPES.includes(value as InvestigationDecision["type"]);

const extractObject = (text: string) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const detectDecisionType = (content: string, parsed: Record<string, unknown> | null) => {
  const parsedType = String(parsed?.type ?? "");
  if (isDecisionType(parsedType)) return parsedType;
  const matched = content.match(/["']type["']\s*:\s*["']([A-Z_]+)["']/)?.[1] ?? "";
  return isDecisionType(matched) ? matched : null;
};

export class PlannerDecisionValidationError extends Error {
  readonly name = "PlannerDecisionValidationError";
  readonly validationKind = "SCHEMA" as const;

  constructor(
    readonly code: PlannerDecisionValidationCode,
    readonly decisionType: InvestigationDecision["type"] | null,
    readonly path: string,
    message: string,
    readonly attempt: number,
  ) {
    super(message);
  }
}

const validationError = (
  code: PlannerDecisionValidationCode,
  decisionType: InvestigationDecision["type"] | null,
  path: string,
  message: string,
  attempt: number,
): never => {
  throw new PlannerDecisionValidationError(code, decisionType, path, message, attempt);
};

const requiredString = (
  value: unknown,
  decisionType: InvestigationDecision["type"],
  path: string,
  label: string,
  attempt: number,
) => {
  if (value === undefined || value === null) {
    return validationError("MISSING_REQUIRED_FIELD", decisionType, path, `${label} 缺失。`, attempt);
  }
  if (typeof value !== "string") {
    return validationError("INVALID_FIELD_TYPE", decisionType, path, `${label} 必须是字符串。`, attempt);
  }
  const normalized = value.trim();
  if (!normalized) {
    return validationError("INVALID_FIELD_VALUE", decisionType, path, `${label} 不得为空。`, attempt);
  }
  return normalized;
};

const requiredStringArray = (
  value: unknown,
  decisionType: InvestigationDecision["type"],
  path: string,
  label: string,
  attempt: number,
  allowEmpty = false,
) => {
  if (value === undefined || value === null) {
    return validationError("MISSING_REQUIRED_FIELD", decisionType, path, `${label} 缺失。`, attempt);
  }
  if (!Array.isArray(value)) {
    return validationError("INVALID_FIELD_TYPE", decisionType, path, `${label} 必须是数组。`, attempt);
  }
  if (!allowEmpty && value.length === 0) {
    return validationError("INVALID_FIELD_VALUE", decisionType, path, `${label} 不得为空。`, attempt);
  }
  return value.map((item, index) =>
    requiredString(item, decisionType, `${path}[${index}]`, `${label}[${index}]`, attempt));
};

type PlannerDecisionContractSource = {
  schema: string | Readonly<Record<string, unknown>>;
  requirements: readonly string[];
};

const DECISION_CONTRACT_SOURCES: Record<
  InvestigationDecision["type"],
  PlannerDecisionContractSource
> = {
  CREATE_HYPOTHESES: {
    schema: "{type:'CREATE_HYPOTHESES',hypotheses:[{statement:string,supportIf:string,refuteIf:string}],rationale:string}; hypotheses 必须包含 1–3 项。",
    requirements: [],
  },
  ASSESS_EVIDENCE: {
    schema: {
      type: "ASSESS_EVIDENCE",
      rationale: "<required string>",
      assessments: [{
        evidenceId: "<required current Run Evidence id>",
        relations: [{
          targetHypothesisId: "<required active Hypothesis id>",
          relation: "<SUPPORTS | CONTRADICTS | NEUTRAL>",
          explanation: "<required string>",
        }],
      }],
    },
    requirements: [
      "rationale、assessments、每项 evidenceId、relations，以及每条 relation 的 targetHypothesisId、relation、explanation 都是必填字段。",
      "assessments 和每项 relations 必须为非空数组。",
      "decision 顶层只放 type、rationale、assessments；evidenceId 和 relations 不得放在 decision 顶层。",
      "relation 必须根据当前 Evidence 选择 SUPPORTS、CONTRADICTS 或 NEUTRAL，不得从结构示例推断业务结论。",
    ],
  },
  CALL_TOOL: {
    schema: "{type:'CALL_TOOL',toolName:string,arguments:object,targetHypothesisIds:string[],testIntent:'SUPPORT'|'REFUTE'|'DISCRIMINATE',rationale:string}",
    requirements: [],
  },
  ASK_HUMAN: {
    schema: "{type:'ASK_HUMAN',reasonCode:'HUMAN_CONTEXT_REQUIRED'|'NO_APPLICABLE_TOOL',question:string,rationale:string}",
    requirements: [],
  },
  FINALIZE: {
    schema: "{type:'FINALIZE',selectedHypothesisId:string,diagnosis:{summary:string,claims:[{type,statement,evidenceIds:string[],limitationType?}]},disposition:'OBSERVE'|'FIX'|'ROLLBACK'|'ESCALATE',rationale:string}",
    requirements: [],
  },
  STOP_INCONCLUSIVE: {
    schema: "{type:'STOP_INCONCLUSIVE',reasonCode:'INSUFFICIENT_EVIDENCE'|'NO_APPLICABLE_TOOL'|'MAX_TOOL_CALLS'|'MAX_ITERATIONS',reason:string,rationale:string}",
    requirements: [],
  },
};

export const getPlannerDecisionContractSource = (type: InvestigationDecision["type"]) =>
  DECISION_CONTRACT_SOURCES[type];

export const formatPlannerDecisionContract = (type: InvestigationDecision["type"]) => {
  const source = getPlannerDecisionContractSource(type);
  const schema = typeof source.schema === "string"
    ? source.schema
    : JSON.stringify(source.schema);
  return [schema, ...source.requirements].join(" ");
};

export const buildInitialPlannerSystemPrompt = (policyVersion: "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8" = "V2") => [
  "你是 ReleaseGuard 的调查 Planner。你只决定下一步，不执行工具、不改变服务端状态。不要输出思维链，只给产品经理可审计的简短 rationale。必须仅输出 JSON。type 只能是 CREATE_HYPOTHESES、ASSESS_EVIDENCE、CALL_TOOL、ASK_HUMAN、FINALIZE、STOP_INCONCLUSIVE。",
  "没有假设时先用 CREATE_HYPOTHESES 创建 1–3 个竞争假设，每项只含 statement、supportIf、refuteIf。",
  "存在 pendingEvidenceIds 时必须先用一个 ASSESS_EVIDENCE 批量处理全部 pending Evidence；每条 Evidence 的 relations 必须逐一覆盖所有未 REJECTED Hypothesis。",
  `ASSESS_EVIDENCE 正式 contract：${formatPlannerDecisionContract("ASSESS_EVIDENCE")}`,
  "evidenceRelations 中已有的 pair 是不可改写的审计记录，重新补齐矩阵时必须原样重复其 relation。",
  "CALL_TOOL 必须包含 toolName、arguments、targetHypothesisIds、testIntent(SUPPORT/REFUTE/DISCRIMINATE)、rationale。你不能设置 Hypothesis status、confidence、supportScore 或 contradictionScore。",
  "使用 knownInvestigationSlices 规划正交下钻：优先验证当前 incident、release 和已执行工具明确给出的异常切片是否具有区分度，但不得把合法 dimension enum 当作当前一定有数据的 available-dimensions 列表。",
  "segment_metric 的 dimension 是 group-by 维度。选择 app_version 时必须省略 filters.appVersion 并保留 platform 等正交 filters；选择 platform 时省略 filters.platform；选择 region 时省略 filters.region；选择 user_type 时省略 filters.userType。不得由 runtime 静默改写参数，Planner 必须显式输出符合该 contract 的 arguments。",
  "某个 segment_metric query shape 返回 EMPTY 后，将该 dimension + filters 组合视为当前查询形状不可用，不得重复完全相同调用。只在剩余 Hypothesis 明确需要时选择另一个有判别力的维度；不要为消耗预算枚举全部维度，无合理下一步时使用 STOP_INCONCLUSIVE。region 和 user_type 仍可在相应 Hypothesis 需要地理或 cohort 区分时选择。",
  "收敛规则：如果相关当前事件来源已经查询，某个替代 Hypothesis 仍没有任何 SUPPORTS Evidence，且现有当前事件 Evidence 支持另一 Hypothesis，不得仅因这个无支持的推测继续保持多解；应通过 ASSESS_EVIDENCE 将反证明确关联，使其被服务端拒绝或降级，然后在 Grounded Contract 满足时 FINALIZE。只有两个或更多替代解释仍各自拥有当前事件支持，或缺少可区分它们的必要来源时，才 STOP_INCONCLUSIVE。",
  "调用工具前先检查 toolResults、knownInvestigationSlices 和 remainingToolCalls。已覆盖关键 release、impact、segment/feedback 证据且没有新的可判别 query shape 时，不得重复探索或为耗尽预算继续调用；应评估剩余证据并 FINALIZE 或明确 STOP_INCONCLUSIVE。",
  "ASK_HUMAN 必须包含 reasonCode(HUMAN_CONTEXT_REQUIRED/NO_APPLICABLE_TOOL)、question、rationale；STOP_INCONCLUSIVE 必须包含 reasonCode(INSUFFICIENT_EVIDENCE/NO_APPLICABLE_TOOL/MAX_TOOL_CALLS/MAX_ITERATIONS)、reason、rationale。",
  "预算只能以调查上下文中的 server budget 为准；只有 toolCalls=0 才能声明 MAX_TOOL_CALLS，只有当前为最后一次 iteration 才能声明 MAX_ITERATIONS。",
  "FINALIZE 必须包含 selectedHypothesisId、diagnosis、disposition(OBSERVE/FIX/ROLLBACK/ESCALATE)、rationale。diagnosis 只含 summary 和 claims；关键 claim 只含 type(ROOT_CAUSE/CAUSAL_STEP/AFFECTED_METRIC/AFFECTED_SEGMENT)、statement、evidenceIds。ROOT_CAUSE statement 必须原样采用 selected Hypothesis statement。关键 claim 必须引用当前 Run Evidence。",
  "LIMITATION 必须额外包含 limitationType(DATA_GAP/SCOPE_LIMITATION/UNRESOLVED_UNCERTAINTY/OBSERVABILITY_LIMITATION)，只能声明数据、范围、不确定性或可观测性边界，不能承载根因、机制、指标或分群事实。不得输出 confidence、groundingStatus、grounded 或 grounding score。历史事故只能辅助，不能单独支撑 ROOT_CAUSE。",
  ...(["V3", "V4", "V5", "V6", "V7", "V8"].includes(policyVersion) ? [
    "Harness v3 查询策略：runtimeGuidance.toolCapabilities 是服务端提供的只含 schema 名称和上下文字段引用的能力清单。它不包含观察值或答案，不能据此推断根因。只能调用 availability=AVAILABLE 且 availableQueryShapes 非空的工具；UNAVAILABLE_FOR_CURRENT_INVESTIGATION 表示当前调查没有该工具可返回的观测，禁止调用。",
    "构造 CALL_TOOL 时必须选择一项 availableQueryShapes，并保持其中 metricKey + dimension 的配对；requiredArguments 必须全部提供。argumentSources 给出参数的合法来源：availableQueryShapes[].metricKey 使用清单中的名称，release.id、release.version、riskEvent.* 必须从当前调查上下文复制。未列出的 filter 应省略，不得枚举或猜测。时间范围使用 riskEvent.firstBreachedAt 到 riskEvent.lastBreachedAt，query_metric 的 granularity_minutes 固定为 5。",
    "EMPTY 必须按 empty_reason 处理：UNSUPPORTED_QUERY 表示不要换写法重试；NO_MATCH 表示修正或放宽过滤；NO_DATA 表示合法范围内无数据；NO_INFORMATION_GAIN 表示该方向已不能区分假设。不要把任何 EMPTY 当作 Evidence。",
    "每次 CALL_TOOL 必须能补足 evidenceReadiness 中的缺口或明确区分至少一个竞争假设。若领先假设已经 SUPPORTED/CONFIRMED 且至少 MEDIUM，并且主要替代解释没有当前事件支持或已被反证，应优先 FINALIZE，不得为枚举所有工具继续探索。",
    "当 noInformationState.totalCalls 接近 maximumTotalCalls，或只剩 3 次 iteration / 2 次 tool call 时，停止低价值探索，使用现有证据 FINALIZE；确实无法区分时才 STOP_INCONCLUSIVE。",
  ] : []),
  ...(["V4", "V5", "V6"].includes(policyVersion) ? [
    "Harness v4 证据包协议：调查先收集证据，再进入 EVIDENCE_SYNTHESIS 综合判断阶段。综合判断只能引用当前 Run 已持久化且已评估的 Evidence，禁止新增 CALL_TOOL；必须比较至少两个仍有依据的竞争 Hypothesis，并明确根因、机制、受影响对象、时间关系和置信度。无法区分时使用 STOP_INCONCLUSIVE 并说明缺失项。",
    "每次 CALL_TOOL 必须声明 queryValue：DECISIVE、DISCRIMINATING、SUPPORTING 或 REDUNDANT，并在 rationale 中说明它区分的两个假设、SUCCESS 后行动以及 EMPTY 后行动。REDUNDANT 查询不得调用。",
    "STOP_INCONCLUSIVE 的 reasonCode 可为 INSUFFICIENT_EVIDENCE、CONFLICTING_EVIDENCE、UNSUPPORTED_QUERY_SPACE、BUDGET_EXHAUSTED、MODEL_UNCERTAINTY；reason 必须说明缺什么、由谁补充以及如何验证。",
    "满足最低证据组合且领先假设至少 MEDIUM 后，必须优先 FINALIZE；不得为了枚举维度或耗尽预算继续探索。最终判断输入必须只来自 evidencePacket，且按稳定顺序引用 Evidence。",
  ] : []),
  ...(["V7", "V8"].includes(policyVersion) ? [
    "Harness v7 collection phase：只负责竞争假设、Evidence Assessment 和只读工具选择。最终根因由独立 Synthesizer 基于持久化 Evidence Packet 决定。",
    "当 runtimeGuidance.stagedArchitecture 存在时，不得自行综合根因；证据充分或无法继续调查时可返回 FINALIZE/STOP_INCONCLUSIVE 作为阶段移交请求，其诊断文本不会被直接采纳。",
  ] : []),
  ...(policyVersion === "V8" ? [
    "Harness v8 collection policy：每个假设必须说明具体变化组件或外部依赖、失败机制、受影响指标或用户对象，并通过 supportIf/refuteIf 给出可观察的支持与证伪信号；禁止使用‘发布导致异常’一类不可区分的空泛假设。",
    "按信息增益选择工具：发布上下文 → 异常指标与基线 → 区分竞争假设的分群 → 用户反馈机制 → 历史线索。CALL_TOOL 必须通过 targetHypothesisIds 和 SUPPORT/REFUTE/DISCRIMINATE 明确它将如何改变假设排序。",
    "runtimeGuidance.stagedArchitecture.readiness 使用 READY_FOR_CAUSAL、READY_FOR_BOUNDED_HYPOTHESIS、READY_FOR_ABSTENTION、NEEDS_COLLECTION。只有 NEEDS_COLLECTION 才继续调用能补足明确缺口的工具；其余状态应移交 Synthesizer。",
    "Evidence Assessment 必须区分候选线索与因果支持：发布记录仅证明变更存在、范围和时间，若没有版本隔离、暴露/控制差异、机制信号或结果差异，只能标为 NEUTRAL，不能因为模块名看似相关就标 SUPPORTS。relation 必须与 explanation 一致；解释中写明反驳时必须使用 CONTRADICTS。",
    "当异常指标与互补业务结果不一致（例如事件率下降但完成结果稳定）时，必须优先比较埋点/口径异常与真实行为变化；稳定结果不能被解释为真实用户流失的支持证据。跨平台、版本、地区或人群同时变化时，必须保留外部依赖、流量结构或测量问题等替代假设，直到获得区分证据。",
    "移交综合前检查所有仍可行假设：每个替代假设必须有当前事件 CONTRADICTS Evidence，或继续调用可用的分群、反馈、技术信号、互补指标或历史查询进行区分。不得仅凭领先分数较高就忽略尚未检验的替代解释。",
  ] : []),
].join("\n");

export function parseInvestigationDecision(content: string, attempt = 0): InvestigationDecision {
  const parsed = extractObject(content);
  const detectedType = detectDecisionType(content, parsed);
  if (!parsed) {
    return validationError("INVALID_JSON", detectedType, "$", "Planner 没有返回可解析的 JSON object。", attempt);
  }
  if (!Object.hasOwn(parsed, "type")) {
    return validationError("MISSING_REQUIRED_FIELD", null, "type", "Planner decision 缺少 type。", attempt);
  }
  if (typeof parsed.type !== "string") {
    return validationError("INVALID_FIELD_TYPE", null, "type", "Planner decision type 必须是字符串。", attempt);
  }
  const type = parsed.type;
  if (!isDecisionType(type)) {
    return validationError("INVALID_DECISION_TYPE", null, "type", "Planner 没有返回有效 InvestigationDecision type。", attempt);
  }
  const rationale = requiredString(parsed.rationale, type, "rationale", "Planner rationale", attempt);
  if (type === "CREATE_HYPOTHESES") {
    if (!Array.isArray(parsed.hypotheses)) {
      return validationError("INVALID_FIELD_TYPE", type, "hypotheses", "Planner CREATE_HYPOTHESES 的 hypotheses 必须是数组。", attempt);
    }
    if (parsed.hypotheses.length < 1 || parsed.hypotheses.length > 3) {
      return validationError("INVALID_FIELD_VALUE", type, "hypotheses", "Planner CREATE_HYPOTHESES 必须包含 1–3 个假设。", attempt);
    }
    const hypotheses = parsed.hypotheses.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return validationError("INVALID_FIELD_TYPE", type, `hypotheses[${index}]`, "Planner 返回了无效 Hypothesis Draft。", attempt);
      }
      const draft = item as Record<string, unknown>;
      const statement = requiredString(draft.statement, type, `hypotheses[${index}].statement`,
        "Hypothesis statement", attempt);
      const supportIf = requiredString(draft.supportIf, type, `hypotheses[${index}].supportIf`,
        "Hypothesis supportIf", attempt);
      const refuteIf = requiredString(draft.refuteIf, type, `hypotheses[${index}].refuteIf`,
        "Hypothesis refuteIf", attempt);
      return { statement, supportIf, refuteIf };
    });
    return { type, hypotheses, rationale };
  }
  if (type === "ASSESS_EVIDENCE") {
    if (!Object.hasOwn(parsed, "assessments")) {
      return validationError("MISSING_REQUIRED_FIELD", type, "assessments", "Planner ASSESS_EVIDENCE 缺少 assessments。", attempt);
    }
    if (!Array.isArray(parsed.assessments)) {
      return validationError("INVALID_FIELD_TYPE", type, "assessments", "Planner ASSESS_EVIDENCE 的 assessments 必须是数组。", attempt);
    }
    if (parsed.assessments.length === 0) {
      return validationError("INVALID_FIELD_VALUE", type, "assessments", "Planner ASSESS_EVIDENCE 的 assessments 不得为空。", attempt);
    }
    const assessments = parsed.assessments.map((item, assessmentIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return validationError("INVALID_FIELD_TYPE", type, `assessments[${assessmentIndex}]`, "Planner 返回了无效 Evidence Assessment。", attempt);
      }
      const assessment = item as Record<string, unknown>;
      const evidenceId = requiredString(assessment.evidenceId, type,
        `assessments[${assessmentIndex}].evidenceId`, "Evidence Assessment evidenceId", attempt);
      if (!Array.isArray(assessment.relations)) {
        return validationError("INVALID_FIELD_TYPE", type, `assessments[${assessmentIndex}].relations`, "Evidence Assessment 的 relations 必须是数组。", attempt);
      }
      if (assessment.relations.length === 0) {
        return validationError("INVALID_FIELD_VALUE", type, `assessments[${assessmentIndex}].relations`, "Evidence Assessment 的 relations 不得为空。", attempt);
      }
      const relations = assessment.relations.map((entry, relationIndex) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return validationError("INVALID_FIELD_TYPE", type, `assessments[${assessmentIndex}].relations[${relationIndex}]`, "Planner 返回了无效 Evidence Relation。", attempt);
        }
        const relationEntry = entry as Record<string, unknown>;
        const targetHypothesisId = requiredString(relationEntry.targetHypothesisId, type,
          `assessments[${assessmentIndex}].relations[${relationIndex}].targetHypothesisId`,
          "Evidence Relation targetHypothesisId", attempt);
        const relation = requiredString(relationEntry.relation, type,
          `assessments[${assessmentIndex}].relations[${relationIndex}].relation`,
          "Evidence Relation relation", attempt);
        if (!["SUPPORTS", "CONTRADICTS", "NEUTRAL"].includes(relation)) {
          return validationError("INVALID_FIELD_VALUE", type, `assessments[${assessmentIndex}].relations[${relationIndex}].relation`, "Evidence Relation 的 relation 不合法。", attempt);
        }
        const explanation = requiredString(relationEntry.explanation, type,
          `assessments[${assessmentIndex}].relations[${relationIndex}].explanation`,
          "Evidence Relation explanation", attempt);
        return { targetHypothesisId, relation: relation as "SUPPORTS" | "CONTRADICTS" | "NEUTRAL", explanation };
      });
      return { evidenceId, relations };
    });
    return { type, assessments, rationale };
  }
  if (type === "CALL_TOOL") {
    const toolName = requiredString(parsed.toolName, type, "toolName", "Planner CALL_TOOL toolName", attempt);
    const args = parsed.arguments;
    const targetHypothesisIds = requiredStringArray(parsed.targetHypothesisIds, type,
      "targetHypothesisIds", "Planner CALL_TOOL targetHypothesisIds", attempt);
    const testIntent = requiredString(parsed.testIntent, type, "testIntent",
      "Planner CALL_TOOL testIntent", attempt);
    if (!modelToolDefinitions.some((item) => item.function.name === toolName)) {
      return validationError("INVALID_FIELD_VALUE", type, "toolName", "Planner 返回了未注册的 Tool。", attempt);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return validationError("INVALID_FIELD_TYPE", type, "arguments", "Planner CALL_TOOL 的 arguments 必须是 object。", attempt);
    }
    if (!["SUPPORT", "REFUTE", "DISCRIMINATE"].includes(testIntent)) {
      return validationError("INVALID_FIELD_VALUE", type, "testIntent", "Planner CALL_TOOL 的 testIntent 不合法。", attempt);
    }
    const queryValue = parsed.queryValue;
    if (queryValue !== undefined && !["DECISIVE", "DISCRIMINATING", "SUPPORTING", "REDUNDANT"].includes(String(queryValue))) {
      return validationError("INVALID_FIELD_VALUE", type, "queryValue", "Planner CALL_TOOL queryValue 不合法。", attempt);
    }
    return { type, toolName, arguments: args as Record<string, unknown>, targetHypothesisIds,
      testIntent: testIntent as "SUPPORT" | "REFUTE" | "DISCRIMINATE",
      ...(queryValue ? { queryValue: queryValue as "DECISIVE" | "DISCRIMINATING" | "SUPPORTING" | "REDUNDANT" } : {}),
      rationale };
  }
  if (type === "ASK_HUMAN") {
    const reasonCode = requiredString(parsed.reasonCode, type, "reasonCode",
      "Planner ASK_HUMAN reasonCode", attempt);
    if (!PLANNER_WAIT_REASON_CODES.includes(reasonCode as (typeof PLANNER_WAIT_REASON_CODES)[number])) {
      return validationError("INVALID_FIELD_VALUE", type, "reasonCode",
        "Planner ASK_HUMAN reasonCode 不合法。", attempt);
    }
    const question = requiredString(parsed.question, type, "question", "Planner ASK_HUMAN question", attempt);
    return { type, reasonCode: reasonCode as (typeof PLANNER_WAIT_REASON_CODES)[number], question, rationale };
  }
  if (type === "STOP_INCONCLUSIVE") {
    const reasonCode = requiredString(parsed.reasonCode, type, "reasonCode",
      "Planner STOP_INCONCLUSIVE reasonCode", attempt);
    if (!PLANNER_STOP_REASON_CODES.includes(reasonCode as (typeof PLANNER_STOP_REASON_CODES)[number])) {
      return validationError("INVALID_FIELD_VALUE", type, "reasonCode",
        "Planner STOP_INCONCLUSIVE reasonCode 不合法。", attempt);
    }
    const reason = requiredString(parsed.reason, type, "reason", "Planner STOP_INCONCLUSIVE reason", attempt);
    return { type, reasonCode: reasonCode as (typeof PLANNER_STOP_REASON_CODES)[number], reason, rationale };
  }
  requiredString(parsed.selectedHypothesisId, type, "selectedHypothesisId",
    "Planner FINALIZE selectedHypothesisId", attempt);
  requiredString(parsed.disposition, type, "disposition", "Planner FINALIZE disposition", attempt);
  if (!parsed.diagnosis || typeof parsed.diagnosis !== "object" || Array.isArray(parsed.diagnosis)) {
    return validationError("INVALID_FIELD_TYPE", type, "diagnosis",
      "Planner FINALIZE diagnosis 必须是 object。", attempt);
  }
  const diagnosis = parsed.diagnosis as Record<string, unknown>;
  requiredString(diagnosis.summary, type, "diagnosis.summary", "Diagnosis summary", attempt);
  if (!Array.isArray(diagnosis.claims)) {
    return validationError("INVALID_FIELD_TYPE", type, "diagnosis.claims",
      "Diagnosis claims 必须是数组。", attempt);
  }
  if (diagnosis.claims.length === 0) {
    return validationError("INVALID_FIELD_VALUE", type, "diagnosis.claims",
      "Diagnosis claims 不得为空。", attempt);
  }
  diagnosis.claims.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return validationError("INVALID_FIELD_TYPE", type, `diagnosis.claims[${index}]`,
        "Diagnosis claim 必须是 object。", attempt);
    }
    const claim = item as Record<string, unknown>;
    const claimType = requiredString(claim.type, type, `diagnosis.claims[${index}].type`,
      "Diagnosis claim type", attempt);
    requiredString(claim.statement, type, `diagnosis.claims[${index}].statement`,
      "Diagnosis claim statement", attempt);
    requiredStringArray(claim.evidenceIds, type, `diagnosis.claims[${index}].evidenceIds`,
      "Diagnosis claim evidenceIds", attempt, true);
    if (claimType === "LIMITATION") {
      requiredString(claim.limitationType, type, `diagnosis.claims[${index}].limitationType`,
        "Diagnosis claim limitationType", attempt);
    }
  });
  const finalization = parseModelFinalization(JSON.stringify({
    selectedHypothesisId: parsed.selectedHypothesisId,
    diagnosis: parsed.diagnosis,
    disposition: parsed.disposition,
  }));
  if (!finalization) {
    return validationError("INVALID_FIELD_VALUE", type, "diagnosis", "Planner FINALIZE Diagnosis 不符合 Grounded Contract。", attempt);
  }
  return { type, ...finalization, rationale };
}

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const fieldType = (value: unknown) => Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
const safeTopLevelKey = (key: string) =>
  !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
    || /authorization|api[-_]?key|secret|token|password|cookie|headers?/i.test(key)
    ? "[REDACTED]"
    : key;

const safeObjectKeys = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.keys(value as Record<string, unknown>).sort().slice(0, 50).map(safeTopLevelKey)
  : [];

const decisionShape = (
  value: Record<string, unknown>,
  decisionType: InvestigationDecision["type"],
): Record<string, unknown> => {
  if (decisionType === "ASSESS_EVIDENCE") {
    const assessments = value.assessments;
    const assessmentItems = Array.isArray(assessments)
      ? assessments.filter((item) => item && typeof item === "object" && !Array.isArray(item))
      : [];
    const relations = assessmentItems.flatMap((item) => {
      const candidate = (item as Record<string, unknown>).relations;
      return Array.isArray(candidate) ? candidate : [];
    });
    return {
      assessmentsFieldType: fieldType(assessments),
      assessmentsArrayLength: Array.isArray(assessments) ? assessments.length : null,
      assessmentObjectCount: assessmentItems.length,
      assessmentKeySets: assessmentItems.map(safeObjectKeys),
      relationsArrayLengths: assessmentItems.map((item) => {
        const candidate = (item as Record<string, unknown>).relations;
        return Array.isArray(candidate) ? candidate.length : null;
      }),
      relationObjectCount: relations.filter((item) =>
        item && typeof item === "object" && !Array.isArray(item)).length,
      relationKeySets: relations.map(safeObjectKeys),
    };
  }
  if (decisionType === "CREATE_HYPOTHESES") {
    const hypotheses = value.hypotheses;
    return {
      hypothesesFieldType: fieldType(hypotheses),
      hypothesesArrayLength: Array.isArray(hypotheses) ? hypotheses.length : null,
      hypothesisKeySets: Array.isArray(hypotheses) ? hypotheses.map(safeObjectKeys) : [],
    };
  }
  if (decisionType === "CALL_TOOL") {
    return {
      argumentsFieldType: fieldType(value.arguments),
      argumentKeys: safeObjectKeys(value.arguments),
      targetHypothesisIdsCount: Array.isArray(value.targetHypothesisIds)
        ? value.targetHypothesisIds.length
        : null,
    };
  }
  if (decisionType === "FINALIZE") {
    const diagnosis = value.diagnosis as Record<string, unknown> | undefined;
    return {
      diagnosisFieldType: fieldType(value.diagnosis),
      diagnosisKeys: safeObjectKeys(value.diagnosis),
      claimsArrayLength: Array.isArray(diagnosis?.claims) ? diagnosis.claims.length : null,
      claimKeySets: Array.isArray(diagnosis?.claims) ? diagnosis.claims.map(safeObjectKeys) : [],
    };
  }
  return {};
};

async function responseStructureObservation(
  content: string,
  decision: InvestigationDecision,
): Promise<PlannerResponseStructureObservation> {
  const raw = extractObject(content) ?? {};
  const normalized = decision as unknown as Record<string, unknown>;
  return {
    raw: {
      responseHash: await sha256(content),
      responseLength: content.length,
      topLevelKeys: safeObjectKeys(raw),
      decisionType: decision.type,
      shape: decisionShape(raw, decision.type),
    },
    normalized: {
      topLevelKeys: safeObjectKeys(normalized),
      decisionType: decision.type,
      shape: decisionShape(normalized, decision.type),
    },
  };
}

const usageFromResponse = (response: Awaited<ReturnType<typeof callModel>>) => response.usage ? {
  promptTokens: response.usage.prompt_tokens ?? null,
  completionTokens: response.usage.completion_tokens ?? null,
  totalTokens: response.usage.total_tokens ?? null,
} : null;

async function validationObservation(input: {
  outcome: PlannerDecisionValidationObservation["outcome"];
  config: ModelConfig;
  attemptIndex: number;
  content: string;
  error: PlannerDecisionValidationError | PlannerDecisionSemanticError;
  responseStructure: PlannerResponseStructureObservation | null;
  latencyMs: number;
  usage: PlannerDecisionValidationObservation["usage"];
}): Promise<PlannerDecisionValidationObservation> {
  const parsed = extractObject(input.content);
  const assessments = parsed?.assessments;
  const structure: PlannerDecisionValidationObservation["structure"] = {};
  if (input.error.decisionType === "ASSESS_EVIDENCE") {
    structure.assessmentsFieldPresent = Boolean(parsed && Object.hasOwn(parsed, "assessments"));
    structure.assessmentsFieldType = fieldType(assessments);
    structure.assessmentsArrayLength = Array.isArray(assessments) ? assessments.length : null;
  }
  return {
    outcome: input.outcome,
    validationKind: input.error.validationKind,
    provider: input.config.provider,
    model: input.config.model,
    attemptIndex: input.attemptIndex,
    decisionType: input.error.decisionType,
    topLevelKeys: parsed ? Object.keys(parsed).sort().slice(0, 50).map(safeTopLevelKey) : [],
    validationCode: input.error.code,
    validationPath: input.error.path,
    validationSubcode: input.error instanceof PlannerDecisionSemanticError
      ? input.error.validationSubcode
      : null,
    responseLength: input.content.length,
    responseHash: await sha256(input.content),
    latencyMs: input.latencyMs,
    usage: input.usage,
    structure,
    responseStructure: input.responseStructure,
    createdAt: new Date().toISOString(),
  };
}

export const allowedPlannerRepairDecisionTypes = (
  error: PlannerDecisionValidationError | PlannerDecisionSemanticError,
  context: {
    aggregate?: InvestigationAggregate;
    readiness?: string;
    remainingToolCalls?: number;
  } = {},
): InvestigationDecision["type"][] => {
  if (error instanceof PlannerDecisionSemanticError
    && error.code === "ACTIVE_HYPOTHESIS_LIMIT_EXCEEDED"
    && context.aggregate
    && getActiveHypotheses(context.aggregate).length > 0
    && context.readiness === "NEEDS_COLLECTION"
    && (context.remainingToolCalls ?? 0) > 0) {
    return ["CALL_TOOL", "STOP_INCONCLUSIVE"];
  }
  if (error instanceof PlannerDecisionSemanticError && error.grounding?.recoverable) {
    return [...GROUNDING_REPAIR_DECISION_TYPES];
  }
  return error.decisionType ? [error.decisionType] : [...DECISION_TYPES];
};

const emptyResultReason = (output: unknown, errorMessage: string | null) => {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const reason = (output as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.trim()) return reason;
  }
  return errorMessage;
};

export const buildGroundingEvidenceInventory = (aggregate: InvestigationAggregate) => {
  const pendingEvidenceIds = new Set(getPendingEvidence(aggregate).map((item) => item.id));
  const toolByResultId = new Map(aggregate.toolCalls.flatMap((item) =>
    item.result ? [[item.result.id, item] as const] : []));
  return {
    evidence: aggregate.evidence.map((item) => {
      const assessments = aggregate.hypothesisEvidenceLinks
        .filter((link) => link.evidenceId === item.id)
        .map((link) => ({ hypothesisId: link.hypothesisId, relation: link.relation }));
      return {
        id: item.id,
        category: item.category,
        source: item.source,
        tool: toolByResultId.get(item.toolResultId)?.name ?? null,
        assessmentStatus: pendingEvidenceIds.has(item.id) ? "PENDING" : "ASSESSED",
        assessments,
      };
    }),
    emptyToolResults: aggregate.toolCalls
      .filter((item) => item.result?.status === "EMPTY")
      .map((item) => ({
        toolCallId: item.id,
        tool: item.name,
        resultStatus: "EMPTY" as const,
        reason: emptyResultReason(item.result?.output, item.result?.errorMessage ?? null),
      })),
    rules: {
      toolCallDoesNotImplyEvidence: true,
      emptyToolResultsCannotGroundClaims: true,
    },
  };
};

export const buildPlannerRepairFeedback = (
  error: PlannerDecisionValidationError | PlannerDecisionSemanticError,
  aggregate?: InvestigationAggregate,
  context: { readiness?: string; remainingToolCalls?: number } = {},
) => {
  const allowedDecisionTypes = allowedPlannerRepairDecisionTypes(error, {
    aggregate,
    ...context,
  });
  const contracts = allowedDecisionTypes.map((type) =>
    `${type}: ${formatPlannerDecisionContract(type)}`).join("\n");
  const groundingInventory = aggregate
    && error instanceof PlannerDecisionSemanticError
    && error.grounding
    ? buildGroundingEvidenceInventory(aggregate)
    : null;
  const validationErrorPayload = {
    kind: error.validationKind,
    code: error.code,
    path: error.path,
    decisionType: error.decisionType,
    message: error.message,
    validationSubcode: error instanceof PlannerDecisionSemanticError
      ? error.validationSubcode
      : null,
    grounding: error instanceof PlannerDecisionSemanticError ? error.grounding : null,
  };
  const segmentRepairInstructions = error instanceof PlannerDecisionSemanticError
    && error.validationSubcode === "INVALID_SEGMENT_GROUNDING"
    ? [
        "AFFECTED_SEGMENT claim 必须引用当前 Run 中真实持久化的 SEGMENT_METRIC Evidence。",
        "EMPTY 的 segment tool result 不能用于 grounding。",
        "允许删除 unsupported AFFECTED_SEGMENT claim，或改写为当前 Evidence 真正支持的非 segment claim。",
        "也可以返回 CALL_TOOL 继续获取所需 Evidence；无法获取时返回 STOP_INCONCLUSIVE 安全停止。",
      ]
    : [];
  const activeHypothesisRepairInstructions = allowedDecisionTypes.includes("CALL_TOOL")
    && error instanceof PlannerDecisionSemanticError
    && error.code === "ACTIVE_HYPOTHESIS_LIMIT_EXCEEDED"
    ? [
        "当前 Run 已存在 active Hypotheses；不得继续 CREATE_HYPOTHESES，也不得修改已有 Hypothesis 状态。",
        "如果仍需调查，必须返回完整合法的 CALL_TOOL；如果没有合法 collection action，返回 STOP_INCONCLUSIVE。",
        "若 testIntent=DISCRIMINATE，targetHypothesisIds 必须引用至少两个 active Hypothesis。",
        "CALL_TOOL 仍必须通过现有 schema、semantic validation 和 duplicate guard。",
      ]
    : [];
  return [
    error.validationKind === "SCHEMA"
      ? "上一个 Planner response 未通过正式 schema validation。只修复 JSON contract，不改变无关业务判断。"
      : "上一个 Planner response 已通过 schema，但未通过服务端 context semantic validation。只修复被拒绝的结构化引用或决策条件，不改变无关业务判断。",
    `validationError=${JSON.stringify(validationErrorPayload)}`,
    groundingInventory ? `groundingInventory=${JSON.stringify(groundingInventory)}` : null,
    `allowedDecisionTypes=${JSON.stringify(allowedDecisionTypes)}`,
    allowedDecisionTypes.length === 1
      ? `必须保持 decision type 为 ${allowedDecisionTypes[0]}；重新输出一个完整合法的该类型 InvestigationDecision。`
      : `本次 grounding repair 只能选择 ${allowedDecisionTypes.join("、")}；不得输出其他 decision type。`,
    ...segmentRepairInstructions,
    ...activeHypothesisRepairInstructions,
    `正式 contract：\n${contracts}`,
    "必须只使用同一调查上下文中明确存在的 Evidence、Hypothesis 和工具；不得猜测或由服务端补全业务字段。仅按上述明确允许的动作删除 unsupported claim。仅输出修复后的完整 JSON。",
  ].filter((item): item is string => item !== null).join("\n");
};

export class LLMInvestigationPlanner implements InvestigationPlanner {
  readonly type = "LLM" as const;
  private readonly modelCallObservations: PlannerModelCallObservation[] = [];
  private readonly observations: PlannerDecisionValidationObservation[] = [];

  constructor(
    private readonly config: ModelConfig,
    private readonly options: {
      maxDecisionRepairAttempts?: number;
      policyVersion?: "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8";
    } = {},
  ) {}

  drainModelCallObservations() {
    return this.modelCallObservations.splice(0);
  }

  drainDecisionValidationObservations() {
    return this.observations.splice(0);
  }

  async plan(context: PlannerContext): Promise<InvestigationDecision> {
    const aggregate = context.aggregate;
    const compact = {
      run: { id: aggregate.run.id, question: aggregate.run.question, status: aggregate.run.status },
      riskEvent: aggregate.riskEvent,
      release: aggregate.release,
      toolResults: aggregate.toolCalls.filter((item) => item.proposedActionId === null).map((item) => ({
        tool: item.name, arguments: item.arguments, status: item.result?.status, output: item.result?.output,
      })),
      evidence: aggregate.evidence.map((item) => ({
        id: item.id, category: item.category, statement: item.statement, source: item.source,
      })),
      hypotheses: aggregate.hypotheses,
      evidenceRelations: aggregate.hypothesisEvidenceLinks.map((item) => ({
        evidenceId: item.evidenceId, targetHypothesisId: item.hypothesisId,
        relation: item.relation, explanation: item.explanation,
      })),
      pendingEvidenceIds: getPendingEvidence(aggregate).map((evidence) => evidence.id),
      knownInvestigationSlices: buildKnownInvestigationSlices(aggregate),
      evidenceReadiness: {
        categoriesPresent: [...new Set(aggregate.evidence.map((item) => item.category))].sort(),
        supportedHypotheses: aggregate.hypotheses.filter((item) =>
          ["SUPPORTED", "CONFIRMED"].includes(item.status)).map((item) => item.id),
        contradictedHypotheses: aggregate.hypotheses.filter((item) =>
          item.status === "REJECTED" || item.contradictionScore > 0).map((item) => item.id),
        hasCurrentIncidentSupport: aggregate.hypothesisEvidenceLinks.some((link) =>
          link.relation === "SUPPORTS" && aggregate.evidence.some((item) =>
            item.id === link.evidenceId && item.category !== "SIMILAR_INCIDENT")),
      },
      runtimeGuidance: context.runtimeGuidance ?? null,
      humanMessage: context.humanMessage,
      budget: { iterations: context.remainingIterations, toolCalls: context.remainingToolCalls },
    };
    const baseMessages: ModelMessage[] = [
      {
        role: "system",
        content: buildInitialPlannerSystemPrompt(this.options.policyVersion ?? "V2"),
      },
      { role: "user", content: `可用工具：${JSON.stringify(modelToolDefinitions)}\n调查上下文：${JSON.stringify(compact)}` },
    ];
    const requestedRepairs = this.options.maxDecisionRepairAttempts ?? 1;
    const maxRepairs = Math.min(2, Math.max(0, requestedRepairs));
    let messages = baseMessages;
    let repairError: PlannerDecisionValidationError | PlannerDecisionSemanticError | null = null;
    for (let attemptIndex = 0; attemptIndex <= maxRepairs; attemptIndex += 1) {
      if (!context.modelCallBudget) {
        throw new Error("MODEL_CALL_BUDGET_CONTROLLER_REQUIRED");
      }
      const reservationResult = await context.modelCallBudget.reserve({
        attemptIndex,
        provider: this.config.provider,
        model: this.config.model,
      });
      if (!reservationResult.reserved) {
        throw new ModelCallBudgetExhaustedError(
          reservationResult.modelCallCount,
          reservationResult.maxModelCalls,
        );
      }
      const reservation = reservationResult.reservation;
      const observationIndex = this.modelCallObservations.length;
      const started = performance.now();
      const response = await callModel({
        ...this.config,
        responseObserver: (observation) => {
          this.modelCallObservations.push({
            reservationId: reservation.id,
            reservationOrdinal: reservation.ordinal,
            provider: this.config.provider,
            model: observation.model,
            attemptIndex,
            latencyMs: observation.latencyMs,
            status: observation.status,
            usage: observation.usage,
            responseStructure: null,
            createdAt: new Date().toISOString(),
          });
          this.config.responseObserver?.({ ...observation, attemptIndex });
        },
      }, messages, {
        enableTools: false,
        enableThinking: !["V7", "V8"].includes(this.options.policyVersion ?? "")
          && !(attemptIndex > 0 && repairError?.code === "INVALID_JSON"),
        requireJsonObject: true,
        signal: context.signal,
      });
      const latencyMs = performance.now() - started;
      const content = response.choices?.[0]?.message?.content ?? "";
      const stagedReadiness = (context.runtimeGuidance?.stagedArchitecture as
        { readiness?: { status?: unknown } } | undefined)?.readiness?.status;
      try {
        const decision = parseInvestigationDecision(content, attemptIndex);
        if (repairError) {
          const allowedDecisionTypes = allowedPlannerRepairDecisionTypes(repairError, {
            aggregate,
            readiness: typeof stagedReadiness === "string" ? stagedReadiness : undefined,
            remainingToolCalls: context.remainingToolCalls,
          });
          if (!allowedDecisionTypes.includes(decision.type)) {
            return validationError(
              "INVALID_FIELD_VALUE",
              repairError.decisionType,
              "type",
              `Planner repair decision type 必须属于 ${allowedDecisionTypes.join("、")}。`,
              attemptIndex,
            );
          }
        }
        const modelCallObservation = this.modelCallObservations[observationIndex];
        if (modelCallObservation) {
          modelCallObservation.responseStructure = await responseStructureObservation(content, decision);
        }
        validatePlannerDecisionSemantics(decision, {
          aggregate,
          remainingIterations: context.remainingIterations,
          remainingToolCalls: context.remainingToolCalls,
          availableToolNames: modelToolDefinitions.map((item) => item.function.name),
          attempt: attemptIndex,
        });
        if (repairError) {
          this.observations.push(await validationObservation({
            outcome: "REPAIRED",
            config: this.config,
            attemptIndex,
            content,
            error: repairError,
            responseStructure: modelCallObservation?.responseStructure ?? null,
            latencyMs,
            usage: usageFromResponse(response),
          }));
        }
        return decision;
      } catch (error) {
        if (!(error instanceof PlannerDecisionValidationError)
          && !(error instanceof PlannerDecisionSemanticError)) throw error;
        const canRepair = attemptIndex < maxRepairs;
        const modelCallObservation = this.modelCallObservations[observationIndex];
        const observation = await validationObservation({
          outcome: canRepair ? "REPAIR_ATTEMPTED" : "REPAIR_FAILED",
          config: this.config,
          attemptIndex,
          content,
          error,
          responseStructure: modelCallObservation?.responseStructure ?? null,
          latencyMs,
          usage: usageFromResponse(response),
        });
        this.observations.push(observation);
        if (!canRepair) throw error;
        repairError = error;
        messages = [
          ...baseMessages,
          { role: "assistant", content },
          { role: "user", content: buildPlannerRepairFeedback(error, aggregate, {
            readiness: typeof stagedReadiness === "string" ? stagedReadiness : undefined,
            remainingToolCalls: context.remainingToolCalls,
          }) },
        ];
      }
    }
    throw new Error("Planner decision repair budget exhausted.");
  }
}
