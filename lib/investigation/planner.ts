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
      reason: string;
      rationale: string;
    };

export interface InvestigationPlanner {
  readonly type: "LLM" | "DETERMINISTIC";
  plan(context: PlannerContext): Promise<InvestigationDecision>;
}
