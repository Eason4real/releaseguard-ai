import type {
  AgentIterationTrigger,
  DiagnosisClaimType,
  DiagnosisLimitationType,
  DiagnosisDisposition,
  EvidenceRelation,
  InvestigationAggregate,
} from "./types";
import type { ModelCallReservationResult } from "./model-call-budget";

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
  runtimeGuidance?: Record<string, unknown>;
  signal?: AbortSignal;
  modelCallBudget?: {
    reserve(input: {
      attemptIndex: number;
      provider: string;
      model: string;
    }): Promise<ModelCallReservationResult>;
  };
};

export type PlannerDecisionValidationCode =
  | "INVALID_JSON"
  | "INVALID_DECISION_TYPE"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FIELD_TYPE"
  | "INVALID_FIELD_VALUE"
  | "INVALID_SERVER_BUDGET"
  | "STOP_REASON_BUDGET_MISMATCH"
  | "ACTIVE_HYPOTHESIS_LIMIT_EXCEEDED"
  | "DUPLICATE_HYPOTHESIS"
  | "ASSESSMENT_CONTEXT_REQUIRED"
  | "ASSESSMENT_EVIDENCE_NOT_PENDING"
  | "ASSESSMENT_EVIDENCE_DUPLICATE"
  | "ASSESSMENT_EVIDENCE_COVERAGE_MISMATCH"
  | "ASSESSMENT_HYPOTHESIS_NOT_ACTIVE"
  | "ASSESSMENT_HYPOTHESIS_DUPLICATE"
  | "ASSESSMENT_HYPOTHESIS_COVERAGE_MISMATCH"
  | "ASSESSMENT_RELATION_IMMUTABLE"
  | "PENDING_EVIDENCE_REQUIRES_ASSESSMENT"
  | "CALL_TOOL_UNAVAILABLE"
  | "CALL_TOOL_TARGET_DUPLICATE"
  | "CALL_TOOL_TARGET_NOT_FOUND"
  | "CALL_TOOL_TARGET_NOT_ACTIVE"
  | "CALL_TOOL_DISCRIMINATION_REQUIRES_MULTIPLE_TARGETS"
  | "FINALIZE_SELECTED_HYPOTHESIS_NOT_FOUND"
  | "FINALIZE_SELECTED_HYPOTHESIS_NOT_ACTIVE"
  | "FINALIZE_HYPOTHESIS_NOT_READY"
  | "FINALIZE_EVIDENCE_NOT_FOUND"
  | "FINALIZE_GROUNDED_CONTRACT_MISMATCH";

export const GROUNDING_REPAIR_DECISION_TYPES = [
  "FINALIZE",
  "CALL_TOOL",
  "STOP_INCONCLUSIVE",
] as const;

export type GroundingRepairDecisionType =
  (typeof GROUNDING_REPAIR_DECISION_TYPES)[number];

export type PlannerGroundingRepairMetadata = {
  validationPath: string;
  validationSubcode: string;
  rejectedClaimType: DiagnosisClaimType | null;
  requiredEvidenceCategories: string[];
  missingEvidenceCategories: string[];
  recoverable: boolean;
};

export type PlannerDecisionValidationObservation = {
  outcome: "REPAIR_ATTEMPTED" | "REPAIRED" | "REPAIR_FAILED";
  validationKind: "SCHEMA" | "SEMANTIC";
  provider: string;
  model: string;
  attemptIndex: number;
  decisionType: InvestigationDecision["type"] | null;
  topLevelKeys: string[];
  validationCode: PlannerDecisionValidationCode;
  validationPath: string;
  validationSubcode: string | null;
  responseLength: number;
  responseHash: string;
  latencyMs: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  structure: Record<string, string | number | boolean | null>;
  responseStructure: PlannerResponseStructureObservation | null;
  createdAt: string;
};

export type PlannerModelCallObservation = {
  reservationId: string;
  reservationOrdinal: number;
  provider: string;
  model: string;
  attemptIndex: number;
  latencyMs: number;
  status: "SUCCESS" | "ERROR" | "TIMEOUT" | "CANCELLED";
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  responseStructure: PlannerResponseStructureObservation | null;
  createdAt: string;
};

export type PlannerResponseStructureObservation = {
  raw: {
    responseHash: string;
    responseLength: number;
    topLevelKeys: string[];
    decisionType: InvestigationDecision["type"];
    shape: Record<string, unknown>;
  };
  normalized: {
    topLevelKeys: string[];
    decisionType: InvestigationDecision["type"];
    shape: Record<string, unknown>;
  };
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
      queryValue?: "DECISIVE" | "DISCRIMINATING" | "SUPPORTING" | "REDUNDANT";
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
