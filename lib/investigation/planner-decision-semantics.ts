import type { InvestigationDecision } from "./planner";
import type { InvestigationStopReason } from "./types";

export type PlannerDecisionSemantics = {
  reasonCode: string | null;
  stopReason: InvestigationStopReason | null;
  publicSummary: string | null;
  budget: {
    remainingIterations: number;
    remainingToolCalls: number;
    iterationBudgetExhausted: boolean;
    toolBudgetExhausted: boolean;
  };
};

export class PlannerDecisionSemanticError extends Error {
  readonly name = "PlannerDecisionSemanticError";

  constructor(
    readonly code: "INVALID_SERVER_BUDGET" | "STOP_REASON_BUDGET_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

const assertBudget = (value: number, name: string, minimum: number) => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new PlannerDecisionSemanticError(
      "INVALID_SERVER_BUDGET",
      `${name} 必须是服务端提供的有效预算。`,
    );
  }
};

export function validatePlannerDecisionSemantics(
  decision: InvestigationDecision,
  budget: { remainingIterations: number; remainingToolCalls: number },
): PlannerDecisionSemantics {
  assertBudget(budget.remainingIterations, "remainingIterations", 1);
  assertBudget(budget.remainingToolCalls, "remainingToolCalls", 0);
  const facts = {
    ...budget,
    iterationBudgetExhausted: budget.remainingIterations === 1,
    toolBudgetExhausted: budget.remainingToolCalls === 0,
  };

  if (decision.type === "ASK_HUMAN") {
    const publicSummary = decision.reasonCode === "NO_APPLICABLE_TOOL"
      ? "当前服务端工具无法取得继续调查所需信号，等待人工补充。"
      : "继续调查需要当前工具无法取得的人工上下文。";
    return { reasonCode: decision.reasonCode, stopReason: null, publicSummary, budget: facts };
  }

  if (decision.type === "STOP_INCONCLUSIVE") {
    if (decision.reasonCode === "MAX_TOOL_CALLS" && !facts.toolBudgetExhausted) {
      throw new PlannerDecisionSemanticError(
        "STOP_REASON_BUDGET_MISMATCH",
        "Planner 声明工具预算耗尽，但服务端仍有剩余工具调用。",
      );
    }
    if (decision.reasonCode === "MAX_ITERATIONS" && !facts.iterationBudgetExhausted) {
      throw new PlannerDecisionSemanticError(
        "STOP_REASON_BUDGET_MISMATCH",
        "Planner 声明迭代预算耗尽，但服务端仍有剩余迭代。",
      );
    }
    const stopReason: InvestigationStopReason = decision.reasonCode === "MAX_TOOL_CALLS"
      ? "MAX_TOOL_CALLS"
      : decision.reasonCode === "MAX_ITERATIONS"
        ? "MAX_ITERATIONS"
        : decision.reasonCode === "NO_APPLICABLE_TOOL"
          ? "NO_APPLICABLE_TOOL"
          : "INSUFFICIENT_EVIDENCE";
    const summaries: Record<typeof decision.reasonCode, string> = {
      INSUFFICIENT_EVIDENCE: "服务端确认当前证据不足，调查以 INCONCLUSIVE 结束。",
      NO_APPLICABLE_TOOL: "服务端确认没有可用于补充必要信号的调查工具。",
      MAX_TOOL_CALLS: "服务端确认本次调查工具预算已精确耗尽。",
      MAX_ITERATIONS: "服务端确认本次调查迭代预算已精确耗尽。",
    };
    return {
      reasonCode: decision.reasonCode,
      stopReason,
      publicSummary: summaries[decision.reasonCode],
      budget: facts,
    };
  }

  if (decision.type === "FINALIZE") {
    return {
      reasonCode: "SUFFICIENT_EVIDENCE",
      stopReason: "SUFFICIENT_EVIDENCE",
      publicSummary: "服务端 Grounded Contract 校验通过，使用当前证据完成结构化结论。",
      budget: facts,
    };
  }

  return { reasonCode: null, stopReason: null, publicSummary: null, budget: facts };
}
