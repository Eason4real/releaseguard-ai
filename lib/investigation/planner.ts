import type {
  AgentIterationTrigger,
  DiagnosisClaimType,
  DiagnosisLimitationType,
  DiagnosisDisposition,
  EvidenceRelation,
  InvestigationAggregate,
} from "./types";

export type DiagnosisClaimDraft =
  | {
      type: Exclude<DiagnosisClaimType, "LIMITATION">;
      statement: string;
      evidenceIds: string[];
    }
  | {
      type: "LIMITATION";
      limitationType: DiagnosisLimitationType;
      statement: string;
      evidenceIds: string[];
    };

export type GroundedDiagnosisDraft = {
  summary: string;
  claims: DiagnosisClaimDraft[];
};

export type PlannerContext = {
  aggregate: InvestigationAggregate;
  trigger: AgentIterationTrigger;
  humanMessage: string | null;
  remainingIterations: number;
  remainingToolCalls: number;
};

export type PlannerDecisionValidationCode =
  | "INVALID_JSON"
  | "INVALID_DECISION_TYPE"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FIELD_TYPE"
  | "INVALID_FIELD_VALUE";

export type PlannerDecisionValidationObservation = {
  outcome: "REPAIR_ATTEMPTED" | "REPAIRED" | "REPAIR_FAILED";
  provider: string;
  model: string;
  attemptIndex: number;
  decisionType: InvestigationDecision["type"] | null;
  topLevelKeys: string[];
  validationCode: PlannerDecisionValidationCode;
  validationPath: string;
  responseLength: number;
  responseHash: string;
  latencyMs: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  structure: Record<string, string | number | boolean | null>;
  createdAt: string;
};

export type PlannerModelCallObservation = {
  provider: string;
  model: string;
  attemptIndex: number;
  latencyMs: number;
  status: "SUCCESS" | "ERROR";
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  createdAt: string;
};

export const PLANNER_WAIT_REASON_CODES = [
  "HUMAN_CONTEXT_REQUIRED",
  "NO_APPLICABLE_TOOL",
] as const;
export type PlannerWaitReasonCode = (typeof PLANNER_WAIT_REASON_CODES)[number];

export const PLANNER_STOP_REASON_CODES = [
  "INSUFFICIENT_EVIDENCE",
  "NO_APPLICABLE_TOOL",
  "MAX_TOOL_CALLS",
  "MAX_ITERATIONS",
] as const;
export type PlannerStopReasonCode = (typeof PLANNER_STOP_REASON_CODES)[number];

export type InvestigationDecision =
  | {
      type: "CREATE_HYPOTHESES";
      hypotheses: Array<{
        statement: string;
        supportIf: string;
        refuteIf: string;
      }>;
      rationale: string;
    }
  | {
      type: "ASSESS_EVIDENCE";
      assessments: Array<{
        evidenceId: string;
        relations: Array<{
          targetHypothesisId: string;
          relation: EvidenceRelation;
          explanation: string;
        }>;
      }>;
      rationale: string;
    }
  | {
      type: "CALL_TOOL";
      toolName: string;
      arguments: Record<string, unknown>;
      targetHypothesisIds: string[];
      testIntent: "SUPPORT" | "REFUTE" | "DISCRIMINATE";
      rationale: string;
    }
  | {
      type: "ASK_HUMAN";
      reasonCode: PlannerWaitReasonCode;
      question: string;
      rationale: string;
    }
  | {
      type: "FINALIZE";
      selectedHypothesisId: string;
      diagnosis: GroundedDiagnosisDraft;
      disposition: DiagnosisDisposition;
      rationale: string;
    }
  | {
      type: "STOP_INCONCLUSIVE";
      reasonCode: PlannerStopReasonCode;
      reason: string;
      rationale: string;
    };

export interface InvestigationPlanner {
  readonly type: "LLM" | "DETERMINISTIC";
  plan(context: PlannerContext): Promise<InvestigationDecision>;
  drainModelCallObservations?(): PlannerModelCallObservation[];
  drainDecisionValidationObservations?(): PlannerDecisionValidationObservation[];
}
