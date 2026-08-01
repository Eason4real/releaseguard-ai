# Investigation Benchmark Observability

## Scope

`benchmark-observability-v3` persists public, structured runtime facts in each benchmark case
report. It is a Benchmark Harness projection over the existing `InvestigationAggregate`; it does
not change the Planner, AgentLoop, tools, model configuration, budgets, retries, or concurrency.
It never performs an additional model or tool call.

## Runtime Facts

The report records ordered Planner actions and iteration outcomes, sanitized tool calls and
result metadata, persisted Evidence, Evidence/Hypothesis relations, the final competing
Hypothesis snapshot, accepted Diagnosis and FINALIZE records, the runtime stop reason, terminal
state, and runtime-owned model/tool call counts. Runtime-generated opaque IDs are replaced with
stable report-local ordinals. Fixture evidence references remain opaque `EV-nnn` identifiers.

`plannerValidationEvents` projects the runtime's ordered schema and semantic validation audit
events. Each event contains its iteration, attempt, repair outcome, decision type, stable
validation code/path/subcode, response hash, and sanitized response structure. It never contains
the response text or Planner prompt. Grounded Diagnosis rejection subcodes identify the existing
production contract rule without changing the top-level
`FINALIZE_GROUNDED_CONTRACT_MISMATCH` result or any validation condition.

When the existing AgentLoop terminates on `DUPLICATE_TOOL_CALL`, the benchmark runtime records the
already-returned candidate tool call, SHA-256 fingerprints of the candidate and matched historical
signature, and the stable report-local ID of that historical call. This observer reuses the
runtime's canonical signature function and does not alter duplicate detection or termination.

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
Truth, call counts, or the final outcome. A validation event whose validator has no more specific
structured rule records `validationSubcode: null`; it does not synthesize one from an error
message.

## Identity

Each case has a SHA-256 `telemetryIdentity` over the canonical telemetry projection, excluding
runtime UUIDs, timestamps, and durations. Equal deterministic executions therefore produce the
same identity. Telemetry is intentionally excluded from the existing semantic hash, which remains
the identity of execution/evaluation behavior. It does not change the governed Dataset canonical
hash or the `phase1a-v2` evaluation contract version.

The live CLI emits case START/END progress to stderr so the JSON report on stdout remains intact.
Progress contains only case ID, terminal state, call counts, and elapsed duration.

The investigation benchmark report uses `investigation-live-benchmark-report-v1`. It classifies
planner schema exhaustion as `PLANNER_SCHEMA_ERROR`, semantic decision exhaustion as
`INVALID_PLANNER_DECISION`, and other execution failures as `RUNTIME_ERROR`, while retaining the
more specific provider error code. `plannerDecisionRepairRate` is the sole canonical repair-rate
field in this report contract; `decisionRepairRate` belongs to the separate Phase 4 live-eval
contract and is not an alias here. A `STOP_INCONCLUSIVE` decision retains its reason code, public
reason, public rationale, case ID, terminal state, and validation/repair events.

Formal live runs atomically checkpoint an explicitly `INCOMPLETE` JSON report after every case in
the ignored `reports/investigation-benchmark/` directory. A successful run creates a unique final
JSON report and Markdown summary without overwriting an existing artifact, then removes its partial
checkpoint. File names include benchmark type, provider, dataset version, UTC start time, source
commit, and run ID. Credentials, full model responses, prompts, and sensitive environment values
remain excluded by the existing telemetry projection.
