# ReleaseGuard AI Evaluation Methodology

## Status and claim boundary

This methodology was frozen before any Agent improvement. Results may be appended, but scoring
rules must not be changed in response to failures without a versioned amendment and change log.
The executable 22-case dataset is an offline reconstruction: 16 cases are synthetic and six are
repository-native. It is **not** a dataset of 22 authentic enterprise incidents. The separate
42-record public postmortem corpus evaluates retrieval and must not be presented as the root-cause
benchmark.

## Dataset planes and leakage control

The metadata plane contains category, difficulty, provenance, and review notes. The execution
plane contains only incident input and de-labelled tool observations. The evaluation plane contains
Gold root cause, semantic rubric, evidence labels, and scoring. Gold and evidence roles are never
sent to the Planner. A postmortem summary that reveals the current case cause is prohibited from
runtime retrieval; public postmortems are clues only when they describe a different incident.

The frozen governed dataset is `INVESTIGATION-BENCHMARK-DEV` version `0.2.0`, SHA-256
`c07959702947f821eaf635b68ec2a2d162dee403c3c9ebc3fea2b4689c4fb073`. It is a Dev set, not an
unseen Holdout. Case-level tuning therefore limits external validity and must be disclosed.

## Compared systems

1. **Direct LLM:** one model call receives the same initial incident and all allowed static
   observations, with no dynamic tools or Agent loop.
2. **Current Agent:** source commit `aca76ff977e38df48390da10d622768c61e301b1`, production
   `LLMInvestigationPlanner`, shared `AgentLoop`, and fixture-backed read-only tools.
3. **Improved Agent:** the same model, dataset, temperature, budgets, and scorer after only
   case-agnostic changes justified by Current Agent failures.

A fixed-workflow baseline is optional. It must be reported as not run unless an executable provider
is implemented; no value may be inferred from deterministic harness validation.

## Scoring

Root cause receives 2 (fully correct), 1 (partially correct), 0 (incorrect or unsupported), or N/A
(objectively insufficient evidence with correct abstention). Reports include raw counts, strict
accuracy (score 2 only), lenient hit rate (score 1 or 2), and mean score. Deterministic schema,
state, citation existence, tool status, approval, latency, and usage checks take precedence over a
semantic judge.

Technical completion and business investigation completion are separate. Evidence scoring covers
citation validity and support, critical-evidence recall, unsupported claims, and explicit handling
of support and contradiction. Tool reporting uses observed success, invalid arguments, duplicates,
no-information results, recovery, count, and critical-tool recall; it does not invent an optimal
tool path.

Each principal system/case is run independently three times. Stability reports Pass@1, all-three
pass, conclusion consistency, and intervention-free execution in the offline harness only. Wilson
95% intervals accompany proportions. Duration, model calls, tokens, tool calls, timeout, retry, and
cost are measured; missing telemetry remains unavailable.

## Semantic review

The deterministic semantic rubric is used where decisive. Borderline outputs enter
`review_queue.csv`. If an LLM judge is later required, system names are hidden, outputs are shuffled,
the prompt and parameters are frozen, and raw judge input/output is retained. No result is called
human-reviewed unless a person actually records that review.

## Safety

Safety results are test-specific: unapproved write blocking, immutable approval snapshots, replay
protection, invalid arguments, prompt-injection resistance, and failure-state behavior. They are
never summarized as generic “100% safe.” No benchmark run performs a real GitHub write.
