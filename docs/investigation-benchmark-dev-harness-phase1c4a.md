# Investigation Benchmark Dev Harness: Phase 1C.4A

## Scope and claim boundary

This phase validates the governed 22-case Dev dataset end to end with a fixture-compatible,
deterministic, no-model provider. Every result is labeled **Deterministic Harness Validation**. The
numbers validate execution, normalization, scoring, aggregation, failure handling, and
repeatability; they are not Agent accuracy, LLM performance, or a production benchmark result.

The implementation does not create a live provider, a Holdout dataset, a new production tool, or a
second production Agent runtime. `HARNESS_PROVIDER` is an evaluation adapter with no network or
model access. It creates an isolated in-memory evaluation store and analytics fixture per case, then
uses the production `startInvestigation`, shared `runAgentLoop`, and existing `get_release` and
`query_metric` tool execution. Its deliberately case-agnostic planner and stopping policy are
unsuitable for capability claims.

## End-to-end architecture

The runner performs this sequence:

`GOVERNED_DEV loader -> governance/hash validation -> stable case selection -> execution boundary -> de-labelled fixture tool observations -> isolated HARNESS_PROVIDER -> shared AgentLoop/read-only tools -> final InvestigationAggregate -> existing normalizer -> existing Phase 1A scorer -> harness aggregate/report`

The runner supports the full enabled Dev split and one explicit `CASE-NNN` for debugging. Full runs
sort by case ID. A provider factory creates a fresh provider for every case, so mutable execution
state, counters, previous diagnoses, and observations cannot cross case boundaries.

## Three-plane enforcement

The metadata plane stays in the runner and report: case ID, title, category, difficulty, split,
template family, provenance, governance review, dataset version, and dataset hash. The evaluation
plane stays in the governed fixture and scorer: canonical root cause, aliases, evidence labels, and
evidence graph.

The Agent-compatible request has this exact top-level whitelist:

- `agentInput`: incident ID/question, `RiskEvent`, optional `Release`, and opaque data-source refs;
- `enabledTools`: the five existing read-only investigation tools; and
- `observations`: opaque evidence ID/source ref, tool name, current-or-historical scope, tool status,
  and ordinary tool output.

Observation `role`, Ground Truth, answer aliases, required/supporting/distractor labels, case ID,
execution key, dataset identity, benchmark category/difficulty, template family, provenance, split,
and review attestations are omitted. The runner adds case identity to the provider result only after
execution so that the existing normalizer can verify result/case alignment. Ground Truth is first
read by `scoreInvestigationCase` after normalization.

Provider visibility and Agent visibility remain distinct. The harness assembles de-labelled fixture
observations, but the provider cannot select an answer by case ID because its request has no case ID
or execution key. The default provider executes every supplied observation and applies one generic
inconclusive policy. It contains no case-specific branch and does not derive an answer from Ground
Truth or metadata.

## Report contracts

The Run Manifest records run identity, dataset ID/version/hash, evaluation contract version, source
commit, `HARNESS_PROVIDER`, deterministic/no-live-model mode, enabled tools, timestamps, and
total/completed/failed counts. It is separate from the Dataset Manifest and is excluded from the
dataset hash.

Each case records metadata for reporting; execution status, terminal state, model/tool counts and
optional error; normalized root cause, citations and claims when execution completed; and the
unchanged Phase 1A root-cause, evidence, grounding, and cost scores.

The aggregate records total/completed/failed counts, root-cause top-1 accuracy, mean Evidence
Precision, mean Unsupported Claim Rate over evaluable cases, grounding denominators, median and
total model/tool calls, plus category and difficulty breakdowns. All formal selected cases remain
in the root-cause denominator. A throw, invalid result, or normalization failure creates a failed
case with an incorrect empty prediction; it cannot become a correct insufficient-evidence result.
An explicit `INCONCLUSIVE` diagnosis can be correct only when its prediction matches that case's
Ground Truth under the existing Phase 1A scorer.

The semantic report hash includes stable identity, per-case normalized results and scores,
aggregate, and breakdowns. It excludes run ID, timestamps, duration, and machine metadata.
