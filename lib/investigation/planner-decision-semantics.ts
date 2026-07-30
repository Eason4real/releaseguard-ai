import type {
  InvestigationDecision,
  PlannerDecisionValidationCode,
} from "./planner";
import type { InvestigationAggregate, InvestigationStopReason } from "./types";
import {
  getActiveHypotheses,
  getPendingEvidence,
  MAX_ACTIVE_HYPOTHESES,
} from "./hypothesis-invariants";
import {
  GroundedDiagnosisValidationError,
  validateGroundedDiagnosis,
} from "./grounded-diagnosis";

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

export type PlannerDecisionSemanticContext = {
  remainingIterations: number;
  remainingToolCalls: number;
  aggregate?: InvestigationAggregate;
  availableToolNames?: readonly string[];
  attempt?: number;
};

export class PlannerDecisionSemanticError extends Error {
  readonly name = "PlannerDecisionSemanticError";
  readonly validationKind = "SEMANTIC" as const;

  constructor(
    readonly code: PlannerDecisionValidationCode,
    readonly decisionType: InvestigationDecision["type"],
    readonly path: string,
    message: string,
    readonly attempt = 0,
    readonly validationSubcode: string | null = null,
  ) {
    super(message);
  }
}

const semanticError = (
  decision: InvestigationDecision,
  context: PlannerDecisionSemanticContext,
  code: PlannerDecisionValidationCode,
  path: string,
  message: string,
  validationSubcode: string | null = null,
): never => {
  throw new PlannerDecisionSemanticError(
    code,
    decision.type,
    path,
    message,
    context.attempt ?? 0,
    validationSubcode,
  );
};

const assertBudget = (
  decision: InvestigationDecision,
  context: PlannerDecisionSemanticContext,
  value: number,
  name: string,
  minimum: number,
) => {
  if (!Number.isInteger(value) || value < minimum) {
    semanticError(
      decision,
      context,
      "INVALID_SERVER_BUDGET",
      `budget.${name}`,
      `${name} 必须是服务端提供的有效预算。`,
    );
  }
};

const validateCreateHypotheses = (
  decision: Extract<InvestigationDecision, { type: "CREATE_HYPOTHESES" }>,
  context: PlannerDecisionSemanticContext,
  aggregate: InvestigationAggregate,
) => {
  const active = getActiveHypotheses(aggregate);
  if (active.length + decision.hypotheses.length > MAX_ACTIVE_HYPOTHESES) {
    semanticError(decision, context, "ACTIVE_HYPOTHESIS_LIMIT_EXCEEDED", "hypotheses",
      `当前 Run 最多允许 ${MAX_ACTIVE_HYPOTHESES} 个未拒绝 Hypothesis。`);
  }
  const statements = new Set(active.map((item) => item.statement.trim().toLowerCase()));
  decision.hypotheses.forEach((draft, index) => {
    const statement = draft.statement.trim().toLowerCase();
    if (statements.has(statement)) {
      semanticError(decision, context, "DUPLICATE_HYPOTHESIS", `hypotheses[${index}].statement`,
        "Hypothesis statement 与当前 Run 中未拒绝的 Hypothesis 重复。");
    }
    statements.add(statement);
  });
};

const validateAssessment = (
  decision: Extract<InvestigationDecision, { type: "ASSESS_EVIDENCE" }>,
  context: PlannerDecisionSemanticContext,
  aggregate: InvestigationAggregate,
) => {
  const active = getActiveHypotheses(aggregate);
  const pending = getPendingEvidence(aggregate);
  if (active.length === 0 || pending.length === 0) {
    semanticError(decision, context, "ASSESSMENT_CONTEXT_REQUIRED", "assessments",
      "ASSESS_EVIDENCE 需要当前 Run 同时存在 active Hypothesis 和 pending Evidence。");
  }
  const pendingIds = new Set(pending.map((item) => item.id));
  const activeIds = new Set(active.map((item) => item.id));
  const existingPairs = new Map(aggregate.hypothesisEvidenceLinks.map((item) => [
    `${item.evidenceId}\u0000${item.hypothesisId}`,
    item.relation,
  ]));
  const assessedEvidenceIds = new Set<string>();
  decision.assessments.forEach((assessment, assessmentIndex) => {
    if (!pendingIds.has(assessment.evidenceId)) {
      semanticError(decision, context, "ASSESSMENT_EVIDENCE_NOT_PENDING",
        `assessments[${assessmentIndex}].evidenceId`,
        "Evidence 不属于当前 Run 的 pending Evidence 集合。");
    }
    if (assessedEvidenceIds.has(assessment.evidenceId)) {
      semanticError(decision, context, "ASSESSMENT_EVIDENCE_DUPLICATE",
        `assessments[${assessmentIndex}].evidenceId`, "ASSESS_EVIDENCE 不得重复 Evidence。");
    }
    assessedEvidenceIds.add(assessment.evidenceId);
    const relatedHypothesisIds = new Set<string>();
    assessment.relations.forEach((relation, relationIndex) => {
      const path = `assessments[${assessmentIndex}].relations[${relationIndex}]`;
      if (!activeIds.has(relation.targetHypothesisId)) {
        semanticError(decision, context, "ASSESSMENT_HYPOTHESIS_NOT_ACTIVE",
          `${path}.targetHypothesisId`,
          "Evidence relation 必须引用当前 Run 的 active Hypothesis。");
      }
      if (relatedHypothesisIds.has(relation.targetHypothesisId)) {
        semanticError(decision, context, "ASSESSMENT_HYPOTHESIS_DUPLICATE",
          `${path}.targetHypothesisId`, "ASSESS_EVIDENCE 不得重复 Evidence/Hypothesis pair。");
      }
      relatedHypothesisIds.add(relation.targetHypothesisId);
      const existing = existingPairs.get(`${assessment.evidenceId}\u0000${relation.targetHypothesisId}`);
      if (existing && existing !== relation.relation) {
        semanticError(decision, context, "ASSESSMENT_RELATION_IMMUTABLE", `${path}.relation`,
          "ASSESS_EVIDENCE 不得改写已经持久化的 Evidence/Hypothesis relation。");
      }
    });
    if (relatedHypothesisIds.size !== activeIds.size
      || [...activeIds].some((id) => !relatedHypothesisIds.has(id))) {
      semanticError(decision, context, "ASSESSMENT_HYPOTHESIS_COVERAGE_MISMATCH",
        `assessments[${assessmentIndex}].relations`,
        "每条 pending Evidence 必须评价所有 Active Hypothesis。");
    }
  });
  if (assessedEvidenceIds.size !== pendingIds.size
    || [...pendingIds].some((id) => !assessedEvidenceIds.has(id))) {
    semanticError(decision, context, "ASSESSMENT_EVIDENCE_COVERAGE_MISMATCH", "assessments",
      "一次 ASSESS_EVIDENCE 必须覆盖全部 pending Evidence。");
  }
};

const validateToolCall = (
  decision: Extract<InvestigationDecision, { type: "CALL_TOOL" }>,
  context: PlannerDecisionSemanticContext,
  aggregate: InvestigationAggregate,
) => {
  if (getPendingEvidence(aggregate).length > 0) {
    semanticError(decision, context, "PENDING_EVIDENCE_REQUIRES_ASSESSMENT", "type",
      "PENDING_EVIDENCE_ASSESSMENT: 当前 Run 存在 pending Evidence，必须先返回 ASSESS_EVIDENCE。");
  }
  if (context.availableToolNames && !context.availableToolNames.includes(decision.toolName)) {
    semanticError(decision, context, "CALL_TOOL_UNAVAILABLE", "toolName",
      "CALL_TOOL 必须选择当前 Planner context 中明确提供的工具。");
  }
  const allById = new Map(aggregate.hypotheses.map((item) => [item.id, item]));
  const activeIds = new Set(getActiveHypotheses(aggregate).map((item) => item.id));
  const targetIds = new Set<string>();
  decision.targetHypothesisIds.forEach((id, index) => {
    const path = `targetHypothesisIds[${index}]`;
    if (targetIds.has(id)) {
      semanticError(decision, context, "CALL_TOOL_TARGET_DUPLICATE", path,
        "CALL_TOOL 不得重复引用同一 Hypothesis。");
    }
    targetIds.add(id);
    if (!allById.has(id)) {
      semanticError(decision, context, "CALL_TOOL_TARGET_NOT_FOUND", path,
        "CALL_TOOL targetHypothesisIds 必须引用当前 Run 中存在的 Hypothesis。");
    }
    if (!activeIds.has(id)) {
      semanticError(decision, context, "CALL_TOOL_TARGET_NOT_ACTIVE", path,
        "CALL_TOOL targetHypothesisIds 不得引用已 REJECTED 的 Hypothesis。");
    }
  });
  if (decision.testIntent === "DISCRIMINATE" && targetIds.size < 2) {
    semanticError(decision, context, "CALL_TOOL_DISCRIMINATION_REQUIRES_MULTIPLE_TARGETS",
      "targetHypothesisIds", "DISCRIMINATE 必须引用至少两个 active Hypothesis。");
  }
};

const validateFinalize = (
  decision: Extract<InvestigationDecision, { type: "FINALIZE" }>,
  context: PlannerDecisionSemanticContext,
  aggregate: InvestigationAggregate,
) => {
  if (getPendingEvidence(aggregate).length > 0) {
    semanticError(decision, context, "PENDING_EVIDENCE_REQUIRES_ASSESSMENT", "type",
      "PENDING_EVIDENCE_ASSESSMENT: 当前 Run 存在 pending Evidence，必须先返回 ASSESS_EVIDENCE。");
  }
  if (getActiveHypotheses(aggregate).length === 0) {
    semanticError(decision, context, "FINALIZE_SELECTED_HYPOTHESIS_NOT_ACTIVE",
      "selectedHypothesisId",
      "NO_ACTIVE_HYPOTHESIS: 所有 Hypothesis 均已 REJECTED，不能 FINALIZE。");
  }
  const selected = aggregate.hypotheses.find((item) => item.id === decision.selectedHypothesisId)
    ?? semanticError(decision, context, "FINALIZE_SELECTED_HYPOTHESIS_NOT_FOUND",
      "selectedHypothesisId", "FINALIZE 必须选择当前 Run 中存在的 Hypothesis。");
  if (selected.status === "REJECTED") {
    semanticError(decision, context, "FINALIZE_SELECTED_HYPOTHESIS_NOT_ACTIVE",
      "selectedHypothesisId", "REJECTED_HYPOTHESIS: FINALIZE 不得选择已 REJECTED 的 Hypothesis。");
  }
  if (!["SUPPORTED", "CONFIRMED"].includes(selected.status)
    || !["MEDIUM", "HIGH"].includes(selected.confidence)) {
    semanticError(decision, context, "FINALIZE_HYPOTHESIS_NOT_READY", "selectedHypothesisId",
      "HYPOTHESIS_NOT_FINALIZABLE: FINALIZE 只能选择服务端评定为 SUPPORTED/CONFIRMED 且至少 MEDIUM 的 Hypothesis。");
  }
  const evidenceIds = new Set(aggregate.evidence.map((item) => item.id));
  decision.diagnosis.claims.forEach((claim, claimIndex) => {
    claim.evidenceIds.forEach((id, evidenceIndex) => {
      if (!evidenceIds.has(id)) {
        semanticError(decision, context, "FINALIZE_EVIDENCE_NOT_FOUND",
          `diagnosis.claims[${claimIndex}].evidenceIds[${evidenceIndex}]`,
          "CROSS_RUN_EVIDENCE: Diagnosis claim 只能引用当前 Run 中存在的 Evidence。");
      }
    });
  });
  try {
    validateGroundedDiagnosis(aggregate, {
      selectedHypothesisId: decision.selectedHypothesisId,
      diagnosis: decision.diagnosis,
      disposition: decision.disposition,
    }, { validateLimitationText: false });
  } catch (error) {
    semanticError(decision, context, "FINALIZE_GROUNDED_CONTRACT_MISMATCH", "diagnosis",
      error instanceof Error ? error.message : "FINALIZE 未通过服务端 Grounded Contract。",
      error instanceof GroundedDiagnosisValidationError ? error.validationSubcode : null);
  }
};

export function validatePlannerDecisionSemantics(
  decision: InvestigationDecision,
  context: PlannerDecisionSemanticContext,
): PlannerDecisionSemantics {
  assertBudget(decision, context, context.remainingIterations, "remainingIterations", 1);
  assertBudget(decision, context, context.remainingToolCalls, "remainingToolCalls", 0);
  const facts = {
    remainingIterations: context.remainingIterations,
    remainingToolCalls: context.remainingToolCalls,
    iterationBudgetExhausted: context.remainingIterations === 1,
    toolBudgetExhausted: context.remainingToolCalls === 0,
  };

  if (context.aggregate) {
    if (decision.type === "CREATE_HYPOTHESES") {
      validateCreateHypotheses(decision, context, context.aggregate);
    } else if (decision.type === "ASSESS_EVIDENCE") {
      validateAssessment(decision, context, context.aggregate);
    } else if (decision.type === "CALL_TOOL") {
      validateToolCall(decision, context, context.aggregate);
    } else if (decision.type === "FINALIZE") {
      validateFinalize(decision, context, context.aggregate);
    }
  }

  if (decision.type === "ASK_HUMAN") {
    const publicSummary = decision.reasonCode === "NO_APPLICABLE_TOOL"
      ? "当前服务端工具无法取得继续调查所需信号，等待人工补充。"
      : "继续调查需要当前工具无法取得的人工上下文。";
    return { reasonCode: decision.reasonCode, stopReason: null, publicSummary, budget: facts };
  }

  if (decision.type === "STOP_INCONCLUSIVE") {
    if (decision.reasonCode === "MAX_TOOL_CALLS" && !facts.toolBudgetExhausted) {
      semanticError(decision, context, "STOP_REASON_BUDGET_MISMATCH", "reasonCode",
        "Planner 声明工具预算耗尽，但服务端仍有剩余工具调用。");
    }
    if (decision.reasonCode === "MAX_ITERATIONS" && !facts.iterationBudgetExhausted) {
      semanticError(decision, context, "STOP_REASON_BUDGET_MISMATCH", "reasonCode",
        "Planner 声明迭代预算耗尽，但服务端仍有剩余迭代。");
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
    return { reasonCode: decision.reasonCode, stopReason,
      publicSummary: summaries[decision.reasonCode], budget: facts };
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
