import {
  callModel,
  parseModelFinalization,
  type ModelConfig,
} from "./model";
import { modelToolDefinitions } from "./tools";
import type {
  InvestigationDecision,
  InvestigationPlanner,
  PlannerContext,
} from "./planner";
import { getPendingEvidence } from "./hypothesis-invariants";

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

export class LLMInvestigationPlanner implements InvestigationPlanner {
  readonly type = "LLM" as const;

  constructor(private readonly config: ModelConfig) {}

  async plan(context: PlannerContext): Promise<InvestigationDecision> {
    const aggregate = context.aggregate;
    const compact = {
      run: {
        id: aggregate.run.id,
        question: aggregate.run.question,
        status: aggregate.run.status,
      },
      riskEvent: aggregate.riskEvent,
      release: aggregate.release,
      toolResults: aggregate.toolCalls
        .filter((item) => item.proposedActionId === null)
        .map((item) => ({
          tool: item.name,
          arguments: item.arguments,
          status: item.result?.status,
          output: item.result?.output,
        })),
      evidence: aggregate.evidence.map((item) => ({
        id: item.id,
        category: item.category,
        statement: item.statement,
        source: item.source,
      })),
      hypotheses: aggregate.hypotheses,
      evidenceRelations: aggregate.hypothesisEvidenceLinks.map((item) => ({
        evidenceId: item.evidenceId,
        targetHypothesisId: item.hypothesisId,
        relation: item.relation,
        explanation: item.explanation,
      })),
      pendingEvidenceIds: getPendingEvidence(aggregate).map((evidence) => evidence.id),
      humanMessage: context.humanMessage,
      budget: {
        iterations: context.remainingIterations,
        toolCalls: context.remainingToolCalls,
      },
    };
    const response = await callModel(
      this.config,
      [
        {
          role: "system",
          content:
            "你是 ReleaseGuard 的调查 Planner。你只决定下一步，不执行工具、不改变服务端状态。不要输出思维链，只给产品经理可审计的简短 rationale。必须仅输出 JSON。type 只能是 CREATE_HYPOTHESES、ASSESS_EVIDENCE、CALL_TOOL、ASK_HUMAN、FINALIZE、STOP_INCONCLUSIVE。没有假设时先用 CREATE_HYPOTHESES 创建 1–3 个竞争假设，每项只含 statement、supportIf、refuteIf。存在 pendingEvidenceIds 时必须先用一个 ASSESS_EVIDENCE 批量处理全部 pending Evidence；每条 Evidence 的 relations 必须逐一覆盖所有未 REJECTED Hypothesis，包含 targetHypothesisId、relation(SUPPORTS/CONTRADICTS/NEUTRAL)、explanation。evidenceRelations 中已有的 pair 是不可改写的审计记录，重新补齐矩阵时必须原样重复其 relation。CALL_TOOL 必须包含 toolName、arguments、targetHypothesisIds、testIntent(SUPPORT/REFUTE/DISCRIMINATE)、rationale。你不能设置 Hypothesis status、confidence、supportScore 或 contradictionScore。ASK_HUMAN 包含 question、rationale；STOP_INCONCLUSIVE 包含 reason、rationale。FINALIZE 必须包含 selectedHypothesisId、diagnosis、disposition(OBSERVE/FIX/ROLLBACK/ESCALATE)、rationale。diagnosis 只含 summary 和 claims；关键 claim 只含 type(ROOT_CAUSE/CAUSAL_STEP/AFFECTED_METRIC/AFFECTED_SEGMENT)、statement、evidenceIds。ROOT_CAUSE statement 必须原样采用 selected Hypothesis statement。关键 claim 必须引用当前 Run Evidence。LIMITATION 必须额外包含 limitationType(DATA_GAP/SCOPE_LIMITATION/UNRESOLVED_UNCERTAINTY/OBSERVABILITY_LIMITATION)，只能声明数据、范围、不确定性或可观测性边界，不能承载根因、机制、指标或分群事实。不得输出 confidence、groundingStatus、grounded 或 grounding score。历史事故只能辅助，不能单独支撑 ROOT_CAUSE。",
        },
        {
          role: "user",
          content: `可用工具：${JSON.stringify(modelToolDefinitions)}\n调查上下文：${JSON.stringify(compact)}`,
        },
      ],
      { enableTools: false },
    );
    const content = response.choices?.[0]?.message?.content ?? "";
    const parsed = extractObject(content);
    const type = String(parsed?.type ?? "");
    const rationale = String(parsed?.rationale ?? "").trim().slice(0, 2_000);
    if (type === "CREATE_HYPOTHESES") {
      if (!Array.isArray(parsed?.hypotheses) || parsed.hypotheses.length < 1 || parsed.hypotheses.length > 3) {
        throw new Error("Planner CREATE_HYPOTHESES 必须包含 1–3 个假设。");
      }
      const hypotheses = parsed.hypotheses.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("Planner 返回了无效 Hypothesis Draft。");
        }
        const draft = item as Record<string, unknown>;
        const statement = String(draft.statement ?? "").trim();
        const supportIf = String(draft.supportIf ?? "").trim();
        const refuteIf = String(draft.refuteIf ?? "").trim();
        if (!statement || !supportIf || !refuteIf) {
          throw new Error("Hypothesis Draft 缺少 statement、supportIf 或 refuteIf。");
        }
        return { statement, supportIf, refuteIf };
      });
      return {
        type,
        hypotheses,
        rationale: rationale || "建立可由当前工具区分的竞争假设。",
      };
    }
    if (type === "ASSESS_EVIDENCE") {
      if (!Array.isArray(parsed?.assessments) || parsed.assessments.length === 0) {
        throw new Error("Planner ASSESS_EVIDENCE 缺少 assessments。");
      }
      const assessments = parsed.assessments.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("Planner 返回了无效 Evidence Assessment。");
        }
        const assessment = item as Record<string, unknown>;
        const evidenceId = String(assessment.evidenceId ?? "").trim();
        if (!evidenceId || !Array.isArray(assessment.relations) || assessment.relations.length === 0) {
          throw new Error("Evidence Assessment 缺少 evidenceId 或 relations。");
        }
        const relations = assessment.relations.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("Planner 返回了无效 Evidence Relation。");
          }
          const relationEntry = entry as Record<string, unknown>;
          const targetHypothesisId = String(relationEntry.targetHypothesisId ?? "").trim();
          const relation = String(relationEntry.relation ?? "");
          const explanation = String(relationEntry.explanation ?? "").trim();
          if (
            !targetHypothesisId
            || !["SUPPORTS", "CONTRADICTS", "NEUTRAL"].includes(relation)
            || !explanation
          ) throw new Error("Evidence Relation 字段不符合 Planner Contract。");
          return {
            targetHypothesisId,
            relation: relation as "SUPPORTS" | "CONTRADICTS" | "NEUTRAL",
            explanation,
          };
        });
        return { evidenceId, relations };
      });
      return {
        type,
        assessments,
        rationale: rationale || "显式评价新 Evidence 对全部竞争假设的影响。",
      };
    }
    if (type === "CALL_TOOL") {
      const toolName = String(parsed?.toolName ?? "");
      const args = parsed?.arguments;
      const targetHypothesisIds = Array.isArray(parsed?.targetHypothesisIds)
        ? parsed.targetHypothesisIds.map(String).filter(Boolean)
        : [];
      const testIntent = String(parsed?.testIntent ?? "");
      if (
        !modelToolDefinitions.some((item) => item.function.name === toolName)
        || !args
        || typeof args !== "object"
        || Array.isArray(args)
        || targetHypothesisIds.length === 0
        || !["SUPPORT", "REFUTE", "DISCRIMINATE"].includes(testIntent)
      ) throw new Error("Planner 返回了无效 Tool Decision。");
      return {
        type,
        toolName,
        arguments: args as Record<string, unknown>,
        targetHypothesisIds,
        testIntent: testIntent as "SUPPORT" | "REFUTE" | "DISCRIMINATE",
        rationale: rationale || `调用 ${toolName} 补充证据。`,
      };
    }
    if (type === "ASK_HUMAN") {
      const question = String(parsed?.question ?? "").trim();
      if (!question) throw new Error("Planner ASK_HUMAN 缺少问题。");
      return { type, question, rationale: rationale || "需要产品经理补充上下文。" };
    }
    if (type === "STOP_INCONCLUSIVE") {
      return {
        type,
        reason: String(parsed?.reason ?? "当前证据不足"),
        rationale: rationale || "现有证据不足以形成可靠结论。",
      };
    }
    if (type === "FINALIZE") {
      const finalization = parseModelFinalization(JSON.stringify({
        selectedHypothesisId: parsed?.selectedHypothesisId,
        diagnosis: parsed?.diagnosis,
        disposition: parsed?.disposition,
      }));
      if (!finalization) throw new Error("Planner FINALIZE Diagnosis 不符合 Grounded Contract。");
      return {
        type,
        ...finalization,
        rationale: rationale || "已有足够交叉证据形成 grounded conclusion。",
      };
    }
    throw new Error("Planner 没有返回有效 InvestigationDecision。");
  }
}
