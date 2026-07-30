# Investigation Benchmark Runner: Phase 1B

## Scope

Phase 1B adds a deterministic library pipeline around the Phase 1A contract:

`InvestigationBenchmarkCase -> sanitized execution input -> BenchmarkResultProvider -> Normalizer -> Phase 1A scorer -> aggregate metrics`

The only provider implemented here is a synthetic fixture adapter used by tests. It has no
network access and does not invoke the production Agent, a model, GitHub, a database, or a
deployment target.

## Runner architecture

`runInvestigationBenchmark` owns orchestration only. For each case it first constructs a detached
`BenchmarkExecutionRequest`, asks the provider for one raw result, passes that result to
`normalizeInvestigationResult`, sends the normalized result and original case to
`scoreInvestigationCase`, and finally calls `aggregateInvestigationMetrics`. Root-cause judgment,
evidence precision, grounding evaluation, and cost calculation remain in the Phase 1A scorer.

The runner accepts a `BenchmarkResultProvider` with `run(executionInput)`. The provider can be
replaced by a future Agent execution adapter without changing the runner or scorer. No live
provider is implemented in Phase 1B.

## Anti-leakage boundary

The benchmark has three explicitly separated planes:

- The Metadata Plane contains case ID, title, benchmark category, and difficulty for harness
  orchestration and reporting. An opaque numeric `executionKey` is available to the provider only
  for fixture lookup and is not part of the Agent payload.
- The Agent Execution Plane contains only incident ID/question, RiskEvent, Release, and opaque
  data-source references. A future live provider may pass only this `agentInput` to the Agent.
- The Evaluation Plane contains Ground Truth and the scorer. It remains inside the runner after
  provider execution.

`deriveBenchmarkExecutionRequest` creates both the plumbing envelope and Agent payload field by
field. It does not cast or spread the full benchmark case. Provider visibility and Agent visibility
are deliberately different: providers see `{ executionKey, agentInput }`, while an Agent may see
only `agentInput`. Category, difficulty, title, case ID, Ground Truth, canonical root cause,
aliases, expected answers, and evidence classifications do not exist in the Agent payload.

Synthetic case, source, and evidence identifiers use numeric opaque forms such as `CASE-001`,
`SRC-001`, and `EV-001`. Execution derivation rejects semantic identifiers or fixture paths. Nested
incident values are copied so provider-side mutation cannot change the benchmark case. This
boundary is required before holdout datasets or live evaluation can be considered trustworthy.

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
