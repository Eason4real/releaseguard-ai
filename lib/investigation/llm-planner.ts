import {
  callModel,
  parseModelDiagnosis,
  type ModelConfig,
} from "./model";
import { modelToolDefinitions } from "./tools";
import type {
  InvestigationDecision,
  InvestigationPlanner,
  PlannerContext,
} from "./planner";

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
            "你是 ReleaseGuard 的调查 Planner。你只决定下一步，不执行工具、不改变状态。不要输出思维链，只给产品经理可审计的简短 rationale。必须仅输出 JSON。type 只能是 CALL_TOOL、ASK_HUMAN、FINALIZE、STOP_INCONCLUSIVE。CALL_TOOL 必须包含 toolName、arguments、rationale；ASK_HUMAN 包含 question、rationale；STOP_INCONCLUSIVE 包含 reason、rationale；FINALIZE 包含 diagnosis 和 rationale。Diagnosis 字段沿用 root_cause、summary、causal_chain、affected_metrics、affected_users、validated_claims、unvalidated_claims、confidence(HIGH/MEDIUM/LOW)、severity、recommended_action、requires_human_approval。历史事故只能辅助，不得单独确认根因。",
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
    if (type === "CALL_TOOL") {
      const toolName = String(parsed?.toolName ?? "");
      const args = parsed?.arguments;
      if (
        !modelToolDefinitions.some((item) => item.function.name === toolName)
        || !args
        || typeof args !== "object"
        || Array.isArray(args)
      ) throw new Error("Planner 返回了无效 Tool Decision。");
      return {
        type,
        toolName,
        arguments: args as Record<string, unknown>,
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
      const diagnosis = parseModelDiagnosis(JSON.stringify(parsed?.diagnosis ?? {}));
      if (!diagnosis) throw new Error("Planner FINALIZE Diagnosis 不符合结构化契约。");
      return { type, diagnosis, rationale: rationale || "已有足够交叉证据形成结论。" };
    }
    throw new Error("Planner 没有返回有效 InvestigationDecision。");
  }
}
