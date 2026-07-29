import {
  callModel,
  parseModelFinalization,
  type ModelConfig,
  type ModelMessage,
} from "./model";
import { modelToolDefinitions } from "./tools";
import {
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
import { getPendingEvidence } from "./hypothesis-invariants";
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

export const buildInitialPlannerSystemPrompt = () => [
  "你是 ReleaseGuard 的调查 Planner。你只决定下一步，不执行工具、不改变服务端状态。不要输出思维链，只给产品经理可审计的简短 rationale。必须仅输出 JSON。type 只能是 CREATE_HYPOTHESES、ASSESS_EVIDENCE、CALL_TOOL、ASK_HUMAN、FINALIZE、STOP_INCONCLUSIVE。",
  "没有假设时先用 CREATE_HYPOTHESES 创建 1–3 个竞争假设，每项只含 statement、supportIf、refuteIf。",
  "存在 pendingEvidenceIds 时必须先用一个 ASSESS_EVIDENCE 批量处理全部 pending Evidence；每条 Evidence 的 relations 必须逐一覆盖所有未 REJECTED Hypothesis。",
  `ASSESS_EVIDENCE 正式 contract：${formatPlannerDecisionContract("ASSESS_EVIDENCE")}`,
  "evidenceRelations 中已有的 pair 是不可改写的审计记录，重新补齐矩阵时必须原样重复其 relation。",
  "CALL_TOOL 必须包含 toolName、arguments、targetHypothesisIds、testIntent(SUPPORT/REFUTE/DISCRIMINATE)、rationale。你不能设置 Hypothesis status、confidence、supportScore 或 contradictionScore。",
  "ASK_HUMAN 必须包含 reasonCode(HUMAN_CONTEXT_REQUIRED/NO_APPLICABLE_TOOL)、question、rationale；STOP_INCONCLUSIVE 必须包含 reasonCode(INSUFFICIENT_EVIDENCE/NO_APPLICABLE_TOOL/MAX_TOOL_CALLS/MAX_ITERATIONS)、reason、rationale。",
  "预算只能以调查上下文中的 server budget 为准；只有 toolCalls=0 才能声明 MAX_TOOL_CALLS，只有当前为最后一次 iteration 才能声明 MAX_ITERATIONS。",
  "FINALIZE 必须包含 selectedHypothesisId、diagnosis、disposition(OBSERVE/FIX/ROLLBACK/ESCALATE)、rationale。diagnosis 只含 summary 和 claims；关键 claim 只含 type(ROOT_CAUSE/CAUSAL_STEP/AFFECTED_METRIC/AFFECTED_SEGMENT)、statement、evidenceIds。ROOT_CAUSE statement 必须原样采用 selected Hypothesis statement。关键 claim 必须引用当前 Run Evidence。",
  "LIMITATION 必须额外包含 limitationType(DATA_GAP/SCOPE_LIMITATION/UNRESOLVED_UNCERTAINTY/OBSERVABILITY_LIMITATION)，只能声明数据、范围、不确定性或可观测性边界，不能承载根因、机制、指标或分群事实。不得输出 confidence、groundingStatus、grounded 或 grounding score。历史事故只能辅助，不能单独支撑 ROOT_CAUSE。",
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
    return { type, toolName, arguments: args as Record<string, unknown>, targetHypothesisIds,
      testIntent: testIntent as "SUPPORT" | "REFUTE" | "DISCRIMINATE",
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
    responseLength: input.content.length,
    responseHash: await sha256(input.content),
    latencyMs: input.latencyMs,
    usage: input.usage,
    structure,
    responseStructure: input.responseStructure,
    createdAt: new Date().toISOString(),
  };
}

export const buildPlannerRepairFeedback = (
  error: PlannerDecisionValidationError | PlannerDecisionSemanticError,
) => {
  const contract = error.decisionType
    ? formatPlannerDecisionContract(error.decisionType)
    : DECISION_TYPES.map(formatPlannerDecisionContract).join("\n");
  return [
    error.validationKind === "SCHEMA"
      ? "上一个 Planner response 未通过正式 schema validation。只修复 JSON contract，不改变无关业务判断。"
      : "上一个 Planner response 已通过 schema，但未通过服务端 context semantic validation。只修复被拒绝的结构化引用或决策条件，不改变无关业务判断。",
    `validationError=${JSON.stringify({ kind: error.validationKind, code: error.code,
      path: error.path, decisionType: error.decisionType })}`,
    error.decisionType
      ? `必须保持 decision type 为 ${error.decisionType}；重新输出一个完整合法的该类型 InvestigationDecision。`
      : "保持原本意图的 decision type；Server 不会替你选择或补全业务 decision。",
    `正式 contract：${contract}`,
    "必须只使用同一调查上下文中明确存在的 Evidence、Hypothesis 和工具；不得猜测、删除或由服务端补全业务字段。仅输出修复后的完整 JSON。",
  ].join("\n");
};

export class LLMInvestigationPlanner implements InvestigationPlanner {
  readonly type = "LLM" as const;
  private readonly modelCallObservations: PlannerModelCallObservation[] = [];
  private readonly observations: PlannerDecisionValidationObservation[] = [];

  constructor(
    private readonly config: ModelConfig,
    private readonly options: { maxDecisionRepairAttempts?: number } = {},
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
      humanMessage: context.humanMessage,
      budget: { iterations: context.remainingIterations, toolCalls: context.remainingToolCalls },
    };
    const baseMessages: ModelMessage[] = [
      {
        role: "system",
        content: buildInitialPlannerSystemPrompt(),
      },
      { role: "user", content: `可用工具：${JSON.stringify(modelToolDefinitions)}\n调查上下文：${JSON.stringify(compact)}` },
    ];
    const maxRepairs = (this.options.maxDecisionRepairAttempts ?? 1) <= 0 ? 0 : 1;
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
      }, messages, { enableTools: false, signal: context.signal });
      const latencyMs = performance.now() - started;
      const content = response.choices?.[0]?.message?.content ?? "";
      try {
        const decision = parseInvestigationDecision(content, attemptIndex);
        if (repairError?.decisionType && decision.type !== repairError.decisionType) {
          return validationError("INVALID_FIELD_VALUE", repairError.decisionType, "type",
            `Planner repair 必须保持 decision type 为 ${repairError.decisionType}。`, attemptIndex);
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
          { role: "user", content: buildPlannerRepairFeedback(error) },
        ];
      }
    }
    throw new Error("Planner decision repair budget exhausted.");
  }
}
