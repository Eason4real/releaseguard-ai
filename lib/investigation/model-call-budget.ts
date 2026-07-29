export const DEFAULT_MAX_MODEL_CALLS = 20;
export const MODEL_CALL_HARD_LIMIT = 20;

export class ModelCallBudgetConfigurationError extends Error {
  readonly name = "ModelCallBudgetConfigurationError";
  readonly code = "INVALID_MODEL_CALL_LIMIT";

  constructor(message: string) {
    super(message);
  }
}

export function resolveMaxModelCalls(requested?: number) {
  if (requested === undefined) return DEFAULT_MAX_MODEL_CALLS;
  if (!Number.isInteger(requested) || requested < 1 || requested > MODEL_CALL_HARD_LIMIT) {
    throw new ModelCallBudgetConfigurationError(
      `maxModelCalls 必须是 1-${MODEL_CALL_HARD_LIMIT} 之间的整数。`,
    );
  }
  return requested;
}

export type ModelCallReservation = {
  id: string;
  ordinal: number;
  maxModelCalls: number;
  reservedAt: string;
};

export type ModelCallReservationResult =
  | { reserved: true; reservation: ModelCallReservation }
  | { reserved: false; modelCallCount: number; maxModelCalls: number };

export class ModelCallBudgetExhaustedError extends Error {
  readonly name = "ModelCallBudgetExhaustedError";
  readonly code = "MODEL_CALL_BUDGET_EXHAUSTED";

  constructor(
    readonly modelCallCount: number,
    readonly maxModelCalls: number,
  ) {
    super(`服务端模型调用预算已耗尽（${modelCallCount}/${maxModelCalls}）。`);
  }
}
