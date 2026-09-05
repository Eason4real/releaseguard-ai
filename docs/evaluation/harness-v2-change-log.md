# ReleaseGuard Harness v2 experiment log

## Boundary

The frozen v1 artifacts under `evaluation/results/` are not overwritten or rescored. Harness v2 is
an experimental follow-up prompted by v1 operational instability. It is not a Holdout result and
does not claim that any score reached 80–90%.

An initial three-round launch on 2026-09-01 was rejected from the formal v2 denominator after its
manifests showed `transportRetry: 0` and `fixtureQueryHints: false`. Configuration validation had
dropped the experimental fields. All 66 outputs are retained under
`evaluation/results/v2/misconfigured-attempt-1/`; they are operational overhead, not v2 results.

## H2-001: bounded transient transport recovery

- **Observed v1 problem:** Improved Agent run 3 completed only the first two cases technically. The
  remaining 20 cases were preserved as `PROVIDER_FAILURE`; 19 failed in under one second with zero
  model/tool calls. This pattern is an execution/provider outage, not evidence that the Agent made
  twenty independent bad diagnoses.
- **Hypothesis:** a bounded retry with exponential backoff can recover brief 408/409/429/5xx and
  network transport failures without changing Planner reasoning, tools, evidence, or approval.
- **Implementation:** `lib/investigation/model.ts` accepts 0–2 transport retries and records every
  transport attempt. `scripts/run-investigation-benchmark-live.mjs` exposes explicit environment
  switches. The default remains zero, so v1 reproduction remains unchanged.
- **Failure honesty:** authentication, quota/payment, and other non-transient 4xx responses are not
  retried. Provider errors now distinguish authentication, quota, rate limiting, unavailability,
  timeout, malformed response, and generic failure where evidence permits.
- **Budget effect:** transport retries repeat the same reserved model request and do not consume an
  additional Planner model-call reservation. They can increase wall time and may create provider
  billing ambiguity if a response was produced but lost in transit.
- **Verification:** focused tests prove one 503 is recovered on attempt two, authentication is not
  retried, attempts are observable, credentials remain redacted, and the existing zero-retry live
  provider contract remains covered.
- **Measured status:** the separately versioned live v2 run completed 66/66 trials. The comparison
  summary reports 62/66 technical completions, while retaining four runtime failures. This is a Dev
  result on the same governed set, not a Holdout or production claim.

## H2-002: honest fixture query-shape discovery

- **Observed v1 problem:** `segment_metric` returned EMPTY 141/323 times for Current Agent and
  94/226 times for Improved Agent. Across all tools, EMPTY represented 197/323 and 133/226 calls.
- **Hypothesis:** after an unsupported fixture query, disclosing only the names of available metric
  keys and group-by dimensions lets the Planner choose a valid next query without weakening fixture
  matching or disclosing observation values.
- **Implementation:** the fixture executor can add `query_shape_hints` to an unmatched EMPTY result.
  Hints contain sorted metric/dimension names plus an explicit disclosure boundary. They contain no
  observation payload, evidence ID, source reference, case ID, or expected answer.
- **Isolation:** enabled only by `LIVE_EVAL_FIXTURE_QUERY_HINTS=true`; the default and v1 reproduction
  behavior remain unchanged. Selector matching itself remains strict and observations are consumed
  only by an exact compatible query.
- **Expected effect:** fewer no-information calls and lower latency/cost, with a possible increase in
  evidence recall and business completion. This is a hypothesis pending a separately versioned live
  run, not a measured improvement.
- **Side effect:** this evaluates a harness that can advertise query capabilities. A production
  connector must derive equivalent hints from real schema/catalog metadata before the result can be
  generalized beyond the offline fixture.

## H2-003: validated case-level resume

- **Observed v1 problem:** the interrupted Improved attempt retained a partial checkpoint but could
  not continue from it, increasing elapsed time and provider cost.
- **Implementation:** a run may resume only from an `INCOMPLETE` report whose dataset hash, source
  commit, model configuration, and completed case prefix exactly match the new invocation. Completed
  cases are retained byte-for-byte and only the remaining suffix executes.
- **Failure behavior:** complete reports, single-case mode, mismatched commits/configurations/hashes,
  reordered cases, gaps, and duplicates are rejected before any new case dispatch.
- **Activation:** set `LIVE_EVAL_RESUME_PARTIAL` to an explicit partial-report path. New checkpoints
  retain the original run ID and start timestamp.
- **Verification:** deterministic interruption after three cases resumes to exactly 22 unique cases,
  preserves the frozen prefix, and rejects a source-commit mismatch.
- **Series isolation:** `scripts/run-harness-v2-series.sh` uses stable per-run IDs and checkpoint
  directories under `evaluation/results/v2/`; it skips valid completed rounds and resumes only the
  unfinished suffix.

## Next candidates (not yet implemented)

Richer persisted failure causes, argument normalization derived from tool schemas, and stricter
no-information stopping remain separate candidates. They must not use Gold fields or case identifiers.

## Formal v2 execution record

- Three formal runs contain exactly 22 ordered cases each with dataset hash
  `c07959702947f821eaf635b68ec2a2d162dee403c3c9ebc3fea2b4689c4fb073`, source commit
  `aca76ff977e38df48390da10d622768c61e301b1`, `transportRetry: 2`, and
  `fixtureQueryHints: true`.
- A provider-quota interruption after the first three cases of run 2 was archived separately. The
  validated CASE-201..203 prefix was retained byte-for-byte and the remaining suffix resumed. Run 1
  was never rerun; no quota-failure trial entered the formal v2 result.
- Formal totals: technical 62/66 (93.9%), business 24/66 (36.4%), strict root-cause score 2 at
  19/66 (28.8%), lenient score 1-2 at 31/66 (47.0%), and mean critical-evidence recall 68.9%.
- Tool EMPTY results remain high at 179/329 (54.4%). This is the clearest remaining harness issue;
  query hints improved recovery but did not eliminate low-information exploration.
- The separately versioned blind judge completed 22/22 case requests and 66/66 anonymous output
  scores with zero judge errors and zero format repairs. It is same-model, non-independent review.
- Archived attempts remain under `evaluation/results/v2/misconfigured-attempt-1/` and
  `evaluation/results/v2/quota-exhausted-attempt-2/`; neither contributes to the formal denominator.
