# Investigation Benchmark Live Adapter: Phase 1C.4B.0b

## Scope

This phase adds provider wiring only. It does not run a Live preflight or baseline, change the
22-case governed Dev dataset, alter Ground Truth, tune the Agent, change the Planner prompt, add a
tool, change tool semantics, modify budgets, change the scorer, or introduce transport retries.

The adapter supports two execution providers:

- `HARNESS_PROVIDER`: the frozen deterministic Phase 1C.4A validation mode.
- `LIVE_LLM_PROVIDER`: an explicit live mode using `LLMInvestigationPlanner` and `ModelConfig`.

DeepSeek and other OpenAI-compatible services remain ModelConfig choices. The Harness provider is
not named after a model vendor.

## Shared runtime

Both modes follow the same controlled execution boundary:

`governed case -> sanitized HarnessAgentRequest -> provider -> startInvestigation -> shared AgentLoop -> fixture-backed read-only tool execution -> InvestigationAggregate -> normalizer -> Phase 1A scorer`

The only Agent implementation difference is the injected Planner:

- deterministic mode injects `HarnessRuntimePlanner`;
- live mode injects the production `LLMInvestigationPlanner`, which calls the existing `callModel`.

The production defaults remain unchanged. `callModel` uses global `fetch` unless a test-only
transport is explicitly injected. Tool execution uses `executeNamedTool` unless the Harness
explicitly injects its de-labelled fixture observation executor. The AgentLoop, tool-call argument
validation, evidence lifecycle, stopping rules, and finalization contract are shared.

The fixture executor exposes an observation only after a valid structured `CALL_TOOL` decision.
It does not put all fixture observations into the initial prompt. It receives no case ID, Dataset
identity, category, difficulty, Ground Truth, evidence role, required/supporting/distractor label,
or scorer metadata. Runtime evidence IDs are mapped back to opaque benchmark evidence IDs only
after Agent execution, before normalization and scoring.

## Structured tool execution

Current production architecture is preserved:

`LLM structured Planner decision -> AgentLoop validation -> read-only tool execution -> ToolResult -> Evidence -> next Planner context`

This is structured Agent tool execution. It is not provider-native `tools` / `tool_choice`
function calling; `LLMInvestigationPlanner` continues to call `callModel` with tools disabled at the
HTTP provider layer.

## Live configuration and manifest

Live mode accepts only `deepseek` and `openai-compatible`, with explicit non-empty base URL, API
key, and exact model ID. Missing or invalid configuration fails before case execution; there is no
deterministic fallback.

The API key exists only in the private runtime ModelConfig. It is not included in the Run Manifest,
report, trace, error code, semantic hash, or console representation. The manifest records only
`credentialPresent: true`, the sanitized chat-completions endpoint, exact model ID, provider, and
the existing execution constants:

- temperature `0.1`, provider-default top-p, and 5,000 max output tokens;
- 20 model calls, 10 tool calls, and 16 AgentLoop iterations;
- 75,000 ms default request timeout and one schema repair;
- zero transport retries and concurrency one.

`modelCallCount` comes from the persisted InvestigationRun counter. Token usage comes from current
provider response observations and stays `UNAVAILABLE` when the provider does not return reliable
usage; the adapter does not estimate tokens.

Provider failures are reduced to safe infrastructure codes for authentication, rate limiting,
timeout, malformed response, or other provider failure. Provider response bodies are not copied to
benchmark reports.

## Invocation safety

The existing deterministic command is unchanged. Live execution has a separate entry point and
requires the explicit `--provider=live` opt-in. It is not referenced by `npm test`, `npm run eval`,
or `npm run build`. Configuration is read only after that opt-in check.

Phase 1C.4B.0b tests use the `NON_BENCHMARK` / `PREFLIGHT_TEST_ONLY` Dataset identity and CASE-901.
They inject a local stub transport and never execute CASE-201 through CASE-222 with a model.
