# Investigation Benchmark Live Preflight (Phase 1C.4B.0c1)

## Purpose

The Live preflight is an isolated Agent pipeline check. It is not a benchmark run and does not
measure diagnosis quality. Its frozen identity is:

- case ID: `CASE-901`
- execution purpose: `PREFLIGHT_ONLY`
- benchmark eligible: `false`

The fixture contains only Agent-visible incident input and fixture-backed read-only observations.
It has no Dataset entry, split, category, difficulty, Ground Truth, expected answer, or score.

## Isolation

`loadLivePreflightFixture()` and `loadInvestigationBenchmarkDevDataset()` are separate loaders.
The preflight runner checks that `CASE-901` is absent from the governed Dev manifest before it
creates a provider. The governed Dev runner continues to load only the formal 22-case Dataset.

The preflight report contains runtime identity, sanitized provider configuration, terminal state,
model/tool counts, optional provider token usage, schema repair count, structured Planner actions,
and the read-only tool trajectory. It does not run the normalizer, scorer, benchmark aggregate, or
category/difficulty breakdown.

## Execution Path

The preflight reuses the production-compatible adapter path:

`CASE-901 fixture -> LIVE_LLM_PROVIDER -> LLMInvestigationPlanner -> shared AgentLoop -> fixture-backed tools`

The CLI requires both explicit flags and all four existing Live environment variables. There is no
deterministic fallback. `--preflight` cannot be combined with any `--case` argument, including
`CASE-901`; this prevents a preflight invocation from selecting a governed Dev case.

After separately configuring `LIVE_EVAL_PROVIDER`, `LIVE_EVAL_BASE_URL`, `LIVE_EVAL_API_KEY`, and
`LIVE_EVAL_MODEL` in the same WSL shell, the one-case real preflight command is:

```bash
npm run eval:investigation-live -- --provider=live --preflight
```

The command is intentionally absent from the default `test`, `eval`, and `build` scripts.
