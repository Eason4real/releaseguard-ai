import type { DiagnosisDraft } from "./model";
import type {
  AgentIterationTrigger,
  EvidenceRelation,
  InvestigationAggregate,
} from "./types";

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
      diagnosis: DiagnosisDraft;
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
