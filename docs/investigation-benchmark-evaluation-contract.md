# Investigation Benchmark Evaluation Contract

## Scope

Phase 1A defines provider-independent data contracts and deterministic scoring for a future
end-to-end Investigation Benchmark. It does not add a benchmark runner, production fixtures,
an LLM judge, or UI. Benchmark data remains under `eval/` and is not imported by production
runtime code.

## Contracts

`InvestigationBenchmarkCase` identifies a case, category, difficulty, incident question,
optional production-shaped `RiskEvent` and `Release`, fixture references, and machine-readable
ground truth. Fixture references map benchmark evidence IDs to data made available to a future
runner without changing production `Evidence` IDs or persistence.

`InvestigationGroundTruth` contains one stable root-cause ID and label, accepted textual aliases,
required evidence IDs, all supporting evidence IDs, and distractor IDs. Every required evidence
ID must also be supporting, and supporting and distractor sets must not overlap.

`NormalizedInvestigationResult` is the provider boundary. A future runner or adapter produces it
from a completed investigation, never from UI copy. It contains the top-1 diagnosis, final cited
evidence IDs, structured diagnosis claims, actual model/tool counts, and optional measured token
usage and duration. Token fields remain nullable and carry completeness; they are never estimated.

Claims reuse production `DiagnosisClaimType` and `DiagnosisGroundingStatus`. A normalizer may emit
`GROUNDED` only for a server-validated current diagnosis with persisted claim-to-evidence links.
`LEGACY_UNVERIFIED` must remain unevaluable. Provider output alone is not authoritative grounding.

## Metrics

### Root Cause Top-1 Accuracy

When `predictedRootCauseId` is present, it must exactly equal `canonicalRootCauseId`. Text cannot
override a wrong stable ID. Without a predicted ID, the scorer compares the prediction with the
canonical label and aliases after Unicode NFKC normalization, case folding, and removal of
whitespace, punctuation, and symbols. No LLM judge is used.

Aggregate accuracy is correct cases divided by total cases. It is `null` for an empty result set.

### Evidence Precision

Evidence Precision is the number of unique cited IDs present in `supportingEvidenceIds`, divided
by all unique cited IDs. Duplicate citations count once and are reported separately. Distractor
and unknown IDs remain in the denominator; unknown IDs are also reported. Zero citations produce
precision `0`, with relevant and cited counts both `0`.

The metric intentionally does not measure required-evidence recall in Phase 1A.

### Unsupported Claim Rate

LIMITATION claims are excluded because they state evaluation boundaries rather than incident
facts. For all other final diagnosis claims, the rate is `UNGROUNDED` claims divided by evaluated
claims. It is evaluable only when at least one factual claim exists and every factual claim is
machine-verifiable: no claim is `LEGACY_UNVERIFIED`, and every `GROUNDED` claim has at least one
claim-to-evidence citation. Otherwise the rate is `null` with status `NOT_EVALUABLE`; the scorer
does not infer support from claim text.

The current grounded diagnosis path can calculate this metric because server validation creates
structured claims and persisted claim-to-evidence links. Legacy diagnoses remain unavailable.

### Investigation Cost

Per-case cost records non-negative integer `modelCallCount` and `toolCallCount`. Measured duration
is optional. Token usage is optional and preserves `COMPLETE`, `PARTIAL`, or `UNAVAILABLE`
telemetry. Aggregate token totals and mean total tokens are emitted only when every case has
complete input, output, and total token counts. No missing token count is inferred from another
field.

## Aggregation And Status

Mean Evidence Precision includes every case, including zero-citation cases. Mean Unsupported Claim
Rate includes only evaluable cases and is `null` when none are evaluable. Model and tool costs use
the conventional sorted median (the mean of the two middle values for an even count).

`EVALUATED` means all four Phase 1A metric families were evaluable for the case.
`PARTIALLY_EVALUATED` means grounding was unavailable; it is not a quality pass/fail threshold.
Future Top-K, recall, latency, currency cost, human review, and optional LLM judging can add fields
without changing these metric definitions.
