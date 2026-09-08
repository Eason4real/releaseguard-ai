import { callModel, type ModelConfig, type ModelMessage } from "./model";
import { ModelCallBudgetExhaustedError } from "./model-call-budget";
import {
  parseInvestigationDecision,
  PlannerDecisionValidationError,
} from "./llm-planner";
import {
  PlannerDecisionSemanticError,
  validatePlannerDecisionSemantics,
} from "./planner-decision-semantics";
import type { InvestigationDecision, PlannerModelCallObservation } from "./planner";
import type { InvestigationSynthesizer } from "./staged-planner";

const synthesisSystemPrompt = [
  "你是 ReleaseGuard 的独立 Evidence Synthesizer，不是工具 Planner。",
  "你只能读取用户提供的、已持久化且已评估的 Evidence Packet；不得调用工具、创建 Evidence、补写观察值或使用探索 transcript。",
  "比较竞争 Hypothesis 的支持与反证。证据足够时输出 FINALIZE；无法可靠区分时输出 STOP_INCONCLUSIVE。",
  "FINALIZE JSON 形状：{\"type\":\"FINALIZE\",\"selectedHypothesisId\":\"现有 hypothesis id\",\"diagnosis\":{\"summary\":\"简短总结\",\"claims\":[{\"type\":\"ROOT_CAUSE|CAUSAL_STEP|AFFECTED_METRIC|AFFECTED_SEGMENT\",\"statement\":\"事实陈述\",\"evidenceIds\":[\"Packet evidence id\"]},{\"type\":\"LIMITATION\",\"limitationType\":\"DATA_GAP|SCOPE_LIMITATION|UNRESOLVED_UNCERTAINTY|OBSERVABILITY_LIMITATION\",\"statement\":\"单一边界声明\",\"evidenceIds\":[]}]},\"disposition\":\"OBSERVE|FIX|ROLLBACK|ESCALATE\",\"rationale\":\"简短理由\"}。",
  "STOP_INCONCLUSIVE JSON 形状：{\"type\":\"STOP_INCONCLUSIVE\",\"reasonCode\":\"INSUFFICIENT_EVIDENCE|NO_APPLICABLE_TOOL|MAX_TOOL_CALLS|MAX_ITERATIONS\",\"reason\":\"缺失或冲突项\",\"rationale\":\"简短理由\"}。",
  "不要返回 Markdown、代码围栏、空 rationale、额外字段或自然语言；只返回上述单个 JSON object。",
  "FINALIZE 的 ROOT_CAUSE statement 必须逐字采用 selected Hypothesis statement；每个关键 Claim 只能引用 Packet 中存在的 Evidence id。",
  "历史相似事故不能单独支撑 ROOT_CAUSE。不得输出私有思维链、百分比置信度、groundingStatus 或评分。",
  "只输出一个 JSON object，type 只能是 FINALIZE 或 STOP_INCONCLUSIVE。",
  "若 readiness.status=READY_FOR_CAUSAL，输出 FINALIZE，并始终包含 type、selectedHypothesisId、diagnosis、disposition、rationale 五个顶层字段。",
  "若 readiness.status=READY_FOR_BOUNDED_HYPOTHESIS 或 READY_FOR_ABSTENTION，输出 STOP_INCONCLUSIVE，不得伪装为确定根因。",
  "只有引用了 SEGMENT_METRIC Evidence 才能输出 AFFECTED_SEGMENT；只有引用了 PRODUCT_METRIC 或 SEGMENT_METRIC Evidence 才能输出 AFFECTED_METRIC。无法满足时省略相应 Claim。",
].join("\n");

const repairFeedback = (error: unknown) => {
  if (!error || typeof error !== "object") return "UNKNOWN_VALIDATION_ERROR";
  const value = error as { code?: unknown; path?: unknown; message?: unknown };
  return JSON.stringify({
    code: String(value.code ?? "UNKNOWN_VALIDATION_ERROR").slice(0, 100),
    path: String(value.path ?? "unknown").slice(0, 200),
    message: String(value.message ?? "输出未通过服务端校验").slice(0, 500),
  });
};

type SynthesisAttemptObservation = {
  attemptIndex: number;
  publicResponse: string;
  outcome: "ACCEPTED" | "REPAIR_ATTEMPTED" | "REPAIR_FAILED";
  validationCode: string | null;
  validationPath: string | null;
};

const validationDetails = (error: unknown) => error && typeof error === "object"
  ? {
      validationCode: String((error as { validationSubcode?: unknown }).validationSubcode ??
        (error as { code?: unknown }).code ?? "UNKNOWN_VALIDATION_ERROR"),
      validationPath: String((error as { path?: unknown }).path ?? "unknown"),
    }
  : { validationCode: "UNKNOWN_VALIDATION_ERROR", validationPath: "unknown" };

const groundingRepairHint = (error: unknown, context: Parameters<InvestigationSynthesizer["synthesize"]>[0]) => {
  const details = validationDetails(error);
  const requiredCategory = details.validationCode === "INVALID_SEGMENT_GROUNDING"
    ? "SEGMENT_METRIC"
    : details.validationCode === "INVALID_METRIC_GROUNDING"
      ? "PRODUCT_METRIC or SEGMENT_METRIC"
      : null;
  if (!requiredCategory) return "";
  const categories = new Set(requiredCategory.split(" or "));
  const ids = context.evidencePacket.evidence
    .filter((item) => categories.has(item.category))
    .map((item) => item.id);
  return ` 该 Claim 只能引用 ${requiredCategory} Evidence；Packet 内可用 id：${ids.join(",") || "none"}。`;
};

const addMissingPublicRationale = (content: string) => {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [trimmed, fenced].filter((item): item is string => Boolean(item))) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && (parsed.rationale === undefined || parsed.rationale === null
          || (typeof parsed.rationale === "string" && !parsed.rationale.trim()))) {
        return JSON.stringify({
          ...parsed,
          rationale: "基于持久化 Evidence Packet 执行独立综合，并由服务端校验结论与引用。",
        });
      }
    } catch { /* Preserve the raw response for normal validation and repair. */ }
  }
  return content;
};

export class LLMInvestigationSynthesizer implements InvestigationSynthesizer {
  readonly type = "LLM" as const;
  private readonly modelCallObservations: PlannerModelCallObservation[] = [];
  private readonly attemptObservations: SynthesisAttemptObservation[] = [];

  constructor(
    private readonly config: ModelConfig,
    private readonly maxRepairAttempts = 1,
  ) {}

  drainModelCallObservations() {
    return this.modelCallObservations.splice(0);
  }

  drainAttemptObservations() {
    return this.attemptObservations.splice(0);
  }

  async synthesize(context: Parameters<InvestigationSynthesizer["synthesize"]>[0]) {
    let messages: ModelMessage[] = [
      { role: "system", content: synthesisSystemPrompt },
      { role: "user", content: `Evidence Packet：${JSON.stringify(context.evidencePacket)}` },
    ];
    let lastError: unknown = null;
    const repairs = Math.min(2, Math.max(0, this.maxRepairAttempts));
    for (let attemptIndex = 0; attemptIndex <= repairs; attemptIndex += 1) {
      if (!context.modelCallBudget) throw new Error("MODEL_CALL_BUDGET_CONTROLLER_REQUIRED");
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
        enableThinking: false,
        requireJsonObject: true,
        signal: context.signal,
      });
      const content = response.choices?.[0]?.message?.content ?? "";
      try {
        const decision = parseInvestigationDecision(addMissingPublicRationale(content), attemptIndex);
        if (decision.type !== "FINALIZE" && decision.type !== "STOP_INCONCLUSIVE") {
          throw new PlannerDecisionValidationError(
            "INVALID_DECISION_TYPE",
            decision.type,
            "type",
            "Synthesizer 只能返回 FINALIZE 或 STOP_INCONCLUSIVE。",
            attemptIndex,
          );
        }
        const packetReadiness = context.evidencePacket.schemaVersion === "releaseguard-evidence-packet-v2"
          ? context.evidencePacket.readiness.status
          : null;
        if (packetReadiness && packetReadiness !== "READY_FOR_CAUSAL"
          && decision.type === "FINALIZE") {
          throw new PlannerDecisionSemanticError(
            "INVALID_FIELD_VALUE",
            decision.type,
            "type",
            "Evidence readiness 不允许在未达到 causal 条件时输出 FINALIZE。",
            attemptIndex,
            "READINESS_TERMINAL_MISMATCH",
          );
        }
        validatePlannerDecisionSemantics(decision, {
          aggregate: context.aggregate,
          remainingIterations: context.remainingIterations,
          remainingToolCalls: context.remainingToolCalls,
          availableToolNames: [],
          attempt: attemptIndex,
        });
        this.attemptObservations.push({
          attemptIndex,
          publicResponse: content.slice(0, 20_000),
          outcome: "ACCEPTED",
          validationCode: null,
          validationPath: null,
        });
        return decision as Extract<InvestigationDecision, {
          type: "FINALIZE" | "STOP_INCONCLUSIVE";
        }>;
      } catch (error) {
        lastError = error;
        const details = validationDetails(error);
        this.attemptObservations.push({
          attemptIndex,
          publicResponse: content.slice(0, 20_000),
          outcome: attemptIndex >= repairs ? "REPAIR_FAILED" : "REPAIR_ATTEMPTED",
          ...details,
        });
        if (attemptIndex >= repairs) break;
        messages = [
          ...messages,
          { role: "assistant", content },
          {
            role: "user",
            content: `上一个输出未通过服务端 schema/grounding 校验：${repairFeedback(error)}。${groundingRepairHint(error, context)}保持相同 Evidence Packet，只修复该错误，返回一个完整的 FINALIZE 或 STOP_INCONCLUSIVE JSON object；不要增加事实或引用；不要输出解释、Markdown 或代码围栏。`,
          },
        ];
        const observation = this.modelCallObservations[observationIndex];
        if (observation) observation.responseStructure = null;
      }
    }
    if (lastError instanceof PlannerDecisionValidationError
      || lastError instanceof PlannerDecisionSemanticError
      || (lastError && typeof lastError === "object"
        && /Planner|JSON|rationale|字段|缺失|未通过|Hypothesis|Evidence|Diagnosis/i.test(
          `${String((lastError as { name?: unknown }).name ?? "")} ${String((lastError as { message?: unknown }).message ?? "")}`,
        ))) {
      return {
        type: "STOP_INCONCLUSIVE" as const,
        reasonCode: "INSUFFICIENT_EVIDENCE" as const,
        reason: "Evidence Synthesizer 的结构化响应在有界修复后仍未通过校验；需要人工复核或重试综合阶段。",
        rationale: "为避免未经验证的根因结论，服务端安全停止并保留已收集 Evidence。",
      };
    }
    throw lastError ?? new Error("SYNTHESIZER_FAILED");
  }
}
