import type { InvestigationRunStatus } from "./types";

const allowedTransitions: Record<InvestigationRunStatus, InvestigationRunStatus[]> = {
  PENDING: ["RUNNING", "FAILED"],
  RUNNING: ["WAITING_HUMAN_INPUT", "WAITING_APPROVAL", "WAITING_VERIFICATION", "INCONCLUSIVE", "FAILED"],
  WAITING_HUMAN_INPUT: ["RUNNING", "INCONCLUSIVE", "FAILED"],
  WAITING_APPROVAL: ["RUNNING", "ACTION_EXECUTING", "CLOSED_NO_ACTION", "FAILED"],
  ACTION_EXECUTING: ["WAITING_ACTION_COMPLETION", "FAILED"],
  WAITING_ACTION_COMPLETION: ["WAITING_VERIFICATION"],
  WAITING_VERIFICATION: ["VERIFYING"],
  VERIFYING: ["RESOLVED", "PARTIALLY_RESOLVED", "NOT_RECOVERED", "VERIFICATION_INCONCLUSIVE", "FAILED"],
  RESOLVED: [],
  PARTIALLY_RESOLVED: ["WAITING_VERIFICATION", "RUNNING"],
  NOT_RECOVERED: ["WAITING_VERIFICATION", "RUNNING"],
  VERIFICATION_INCONCLUSIVE: ["WAITING_VERIFICATION", "RUNNING"],
  CLOSED_NO_ACTION: [],
  INCONCLUSIVE: [],
  FAILED: [],
};

export function canTransitionRun(
  from: InvestigationRunStatus,
  to: InvestigationRunStatus,
) {
  return allowedTransitions[from].includes(to);
}

export function assertRunTransition(
  from: InvestigationRunStatus,
  to: InvestigationRunStatus,
) {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Invalid InvestigationRun transition: ${from} -> ${to}`);
  }
}

export function assertGenericRunTransition(
  from: InvestigationRunStatus,
  to: InvestigationRunStatus,
) {
  if (from === "WAITING_ACTION_COMPLETION" && to === "WAITING_VERIFICATION") {
    throw new Error(
      "Protected InvestigationRun transition requires commitActionCompletion: "
      + `${from} -> ${to}`,
    );
  }
  assertRunTransition(from, to);
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createToolSignature(
  name: string,
  args: Record<string, unknown>,
) {
  return `${name}:${canonicalize(args)}`;
}
