import type { DiagnosisDraft } from "./model";
import type {
  AgentIterationTrigger,
  Hypothesis,
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
      type: "CALL_TOOL";
      toolName: string;
      arguments: Record<string, unknown>;
      rationale: string;
      hypothesisDrafts?: Array<Pick<Hypothesis, "statement">>;
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
