# Investigation Benchmark Evaluation Contract

## Scope

`phase1a-v2` defines provider-independent, deterministic scoring for the Investigation Benchmark.
It does not modify the Production Agent, Prompt, provider, tools, or UI, and it does not use an
LLM judge. Benchmark data and semantic rubrics remain under `eval/` and are never included in the
Agent execution payload.

## Contracts

`InvestigationBenchmarkCase` identifies a case, category, difficulty, incident question,
optional production-shaped `RiskEvent` and `Release`, fixture references, and machine-readable
ground truth. Fixture references map benchmark evidence IDs to data made available to a future
runner without changing production `Evidence` IDs or persistence.

`InvestigationGroundTruth` contains one stable root-cause ID and label, accepted textual aliases,
required evidence IDs, all supporting evidence IDs, distractor IDs, and an evaluation-only
root-cause rubric. Every required evidence ID must also be supporting, and supporting and
distractor sets must not overlap. Root-cause IDs, Ground Truth, and rubrics never enter Planner
input, tool context, observations, or persisted investigation state.

`NormalizedInvestigationResult` is the provider boundary. A future runner or adapter produces it
from a completed investigation, never from UI copy. It contains the top-1 diagnosis, final cited
evidence IDs, structured diagnosis claims, actual model/tool counts, and optional measured token
usage and duration. Token fields remain nullable and carry completeness; they are never estimated.

Claims reuse production `DiagnosisClaimType` and `DiagnosisGroundingStatus`. A normalizer may emit
`GROUNDED` only for a server-validated current diagnosis with persisted claim-to-evidence links.
`LEGACY_UNVERIFIED` must remain unevaluable. Provider output alone is not authoritative grounding.

## Metrics

### Root Cause Top-1 Accuracy

The rubric independently defines `expectedAnswerMode` and derives `predictedAnswerMode` as
`CAUSAL` or `ABSTAIN`. An abstention can be correct only when Ground Truth is `ABSTAIN`; generic
insufficient-evidence text is incorrect on a causal case. For an abstention case, definite causal
attribution is incorrect even when the claim is evidence-linked or marked `GROUNDED`.

Matching proceeds in this order after answer-mode, uncertainty, and forbidden-assertion checks:

1. `ID`: an available stable ID exactly equals the canonical ID. A wrong ID cannot be rescued by
   text. Production Live predictions intentionally do not receive Ground Truth IDs.
2. `ALIAS`: the entire prediction exactly matches the canonical text or an approved alias after
   Unicode NFKC normalization, case folding, and removal of whitespace, punctuation, and symbols.
3. `SEMANTIC_RUBRIC` or `ABSTENTION`: every reviewed required concept group is satisfied and the
   uncertainty, forbidden-concept, and specificity policies pass.
4. `NONE`: a proven mode conflict or forbidden assertion is incorrect. If no contradiction is
   proven but a reviewed concept cannot be established, the status is `REVIEW_REQUIRED` and
   correctness is `null`.

Concept groups are controlled semantic propositions, not arbitrary per-case keyword lists. Each
group permits one or more registered concepts, and the deterministic recognizer maps multiple
accepted phrasings to those concepts. Rubrics may define required, optional, and forbidden
concepts. `ALLOW_MORE_SPECIFIC_IF_CONSISTENT` accepts added detail only when it does not introduce
a forbidden or contradictory cause. Cases without a reviewed semantic rubric are not granted an
automatic semantic match; non-exact predictions require review.

Every result preserves an audit trace: expected and predicted answer modes, matched concepts,
missing required groups, forbidden assertions, uncertainty and specificity outcomes, final
decision, and decision reason. Grounding is reported separately and never overrides root-cause
semantics.

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

Root-cause aggregates report `automaticallyEvaluatedCases`, `correctCases`, `incorrectCases`,
`reviewRequiredCases`, `runtimeFailedCases`, `autoEvaluationCoverage`, and
`autoEvaluableAccuracy`. Review-required and runtime-failed cases are not silently counted as
incorrect. `rootCauseTop1Accuracy` is retained as a compatibility alias for
`autoEvaluableAccuracy`. A later blind adjudication must produce a separate adjudicated accuracy;
it must not overwrite the automatic result.

`EVALUATED` means all four Phase 1A metric families were evaluable for the case.
`PARTIALLY_EVALUATED` means grounding was unavailable; it is not a quality pass/fail threshold.
Offline rescore reads the frozen report's saved `normalizedPrediction` only. It does not rerun or
renormalize model output, and writes a distinct report with source-report SHA-256, old semantic
hash, v2 Dataset identity, full scoring traces, and a new semantic hash. The source report is never
overwritten.
