# Investigation Benchmark Runner: Phase 1B

## Scope

Phase 1B adds a deterministic library pipeline around the Phase 1A contract:

`InvestigationBenchmarkCase -> BenchmarkResultProvider -> Normalizer -> Phase 1A scorer -> aggregate metrics`

The only provider implemented here is a synthetic fixture adapter used by tests. It has no
network access and does not invoke the production Agent, a model, GitHub, a database, or a
deployment target.

## Runner architecture

`runInvestigationBenchmark` owns orchestration only. For each case it asks the provider for one
raw result, passes that result to `normalizeInvestigationResult`, sends the normalized result to
`scoreInvestigationCase`, and finally calls `aggregateInvestigationMetrics`. Root-cause judgment,
evidence precision, grounding evaluation, and cost calculation remain in the Phase 1A scorer.

The runner accepts a `BenchmarkResultProvider` with `run(case)`. The provider can be replaced by a
future Agent execution adapter without changing the runner or scorer. No live provider is
implemented in Phase 1B.

## Normalizer boundary

The normalizer is a pure, deterministic mapping from `BenchmarkRawInvestigationResult` to
`NormalizedInvestigationResult`:

- It copies a supplied root-cause ID or keeps it `null`; it never infers a canonical ID from text.
- It copies top-level cited evidence and appends claim-level citations. Duplicates and unknown IDs
  remain present for the scorer to report; no citation is filtered for precision.
- It prefers explicit claim citations, otherwise resolves persisted claim/evidence links by
  `claimId`. It never infers linkage from claim wording.
- Explicit `GROUNDED`, `UNGROUNDED`, and `LIMITATION` statuses are preserved. A factual claim
  marked `GROUNDED` without structured linkage becomes `LEGACY_UNVERIFIED`; missing status is also
  legacy/unavailable. The scorer therefore remains the only component deciding the metric.
- `modelCallCount` and `toolCallCount` are required actual counts. Missing values throw a clear
  error rather than becoming zero. Token usage and duration are copied only when supplied.

## What this proves

The three synthetic cases prove that a controlled raw investigation output can pass through a
repeatable provider boundary, normalizer, scorer, and aggregate calculation. They cover a fully
grounded correct result, noisy/wrong output, and a legacy/partial-telemetry result.

## What this does not prove

Phase 1B does not execute the Agent, measure a model, validate a production incident, or produce a
real benchmark accuracy. Synthetic fixture results are test evidence for the pipeline only and
must not be reported as real Agent performance. Live models, real GitHub, external APIs, database
behavior, deployment, and Phase 1C dataset work remain out of scope.
