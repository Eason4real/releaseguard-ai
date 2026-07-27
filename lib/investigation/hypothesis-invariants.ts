import type { InvestigationAggregate } from "./types";

export const MAX_ACTIVE_HYPOTHESES = 3;

export const getActiveHypotheses = (aggregate: InvestigationAggregate) =>
  aggregate.hypotheses.filter((item) => item.status !== "REJECTED");

export const getPendingEvidence = (aggregate: InvestigationAggregate) => {
  const active = getActiveHypotheses(aggregate);
  if (active.length === 0) return [];
  const linkedPairs = new Set(
    aggregate.hypothesisEvidenceLinks.map((item) =>
      `${item.evidenceId}\u0000${item.hypothesisId}`),
  );
  return aggregate.evidence.filter((evidence) =>
    active.some((hypothesis) =>
      !linkedPairs.has(`${evidence.id}\u0000${hypothesis.id}`)),
  );
};

export const assertActiveHypothesisInvariant = (aggregate: InvestigationAggregate) => {
  const count = getActiveHypotheses(aggregate).length;
  if (count > MAX_ACTIVE_HYPOTHESES) {
    throw new Error(
      `ACTIVE_HYPOTHESIS_LEGACY_INVARIANT: Run 中存在 ${count} 个未拒绝 Hypothesis，最多允许 ${MAX_ACTIVE_HYPOTHESES} 个。`,
    );
  }
  return count;
};
