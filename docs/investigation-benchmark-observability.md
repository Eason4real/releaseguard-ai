# Investigation Benchmark Observability

## Scope

`benchmark-observability-v1` persists public, structured runtime facts in each benchmark case
report. It is a Benchmark Harness projection over the existing `InvestigationAggregate`; it does
not change the Planner, AgentLoop, tools, model configuration, budgets, retries, or concurrency.
It never performs an additional model or tool call.

## Runtime Facts

The report records ordered Planner actions and iteration outcomes, sanitized tool calls and
result metadata, persisted Evidence, Evidence/Hypothesis relations, the final competing
Hypothesis snapshot, accepted Diagnosis and FINALIZE records, the runtime stop reason, terminal
state, and runtime-owned model/tool call counts. Runtime-generated opaque IDs are replaced with
stable report-local ordinals. Fixture evidence references remain opaque `EV-nnn` identifiers.

Tool result bodies are not copied into telemetry. Observation metadata contains only value type,
sorted top-level field names, and array length. Tool arguments are recursively JSON-normalized;
credential-like fields and evaluation-only fields are removed, while configured sensitive values
are redacted from retained strings. The live provider
also supplies its credential as an explicit redaction value before telemetry is serialized.

The report does not contain Ground Truth, canonical root-cause IDs, semantic rubrics, expected
evidence classifications, credentials, full prompts, hidden reasoning, or evaluator decisions.
Scoring remains a separate Evaluation Plane result under `scoring`.

## Explicit Unavailability

The eval-only `LiveEvalStore` journals Hypothesis state immediately before and after its existing
persistence methods and records accepted or rejected finalization commits. This captures runtime
facts while they exist without changing production persistence or execution. If a provider cannot
supply that journal, telemetry sets `hypothesisTransitions` to `null` and lists the missing history
in `unavailableFields`.

The runtime still does not retain a rejected Diagnosis proposal body in all validation paths.
Those fields remain explicitly unavailable. The harness does not infer them from scores, Ground
Truth, call counts, or the final outcome.

## Identity

Each case has a SHA-256 `telemetryIdentity` over the canonical telemetry projection, excluding
runtime UUIDs, timestamps, and durations. Equal deterministic executions therefore produce the
same identity. Telemetry is intentionally excluded from the existing semantic hash, which remains
the identity of execution/evaluation behavior. It does not change the governed Dataset canonical
hash or the `phase1a-v2` evaluation contract version.

The live CLI emits case START/END progress to stderr so the JSON report on stdout remains intact.
Progress contains only case ID, terminal state, call counts, and elapsed duration.
