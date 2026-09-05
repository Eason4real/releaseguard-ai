# ReleaseGuard Harness v3 Change Log

> Status: implementation and Dev evaluation in progress. Targets below are not achieved-result claims.

| Problem | Hypothesis | Change | Validation | Expected side effect |
| --- | --- | --- | --- | --- |
| Alias and formatting mismatches produce EMPTY | Schema-based normalization will recover equivalent query shapes | Normalize tool aliases, filters, dimensions and ISO timestamps before execution | TypeScript and deterministic harness regressions | Stored arguments become canonical in v3 |
| EMPTY is not actionable | A reason taxonomy will prevent blind retries | Return `NO_DATA`, `UNSUPPORTED_QUERY`, `NO_MATCH`, or `NO_INFORMATION_GAIN` in v3 only | Fixture mismatch and budget tests | Adds v3-only result metadata |
| Planner guesses unsupported shapes | Schema-only capability guidance will reduce low-value calls | Expose tool, metric, dimension and scope-field names without values or answer metadata | Leakage regression | Production parity requires a real schema catalog |
| Partial evidence does not converge | Readiness state will encourage grounded finalization | Provide evidence categories, supported/rejected hypotheses and current-event support state | Planner prompt and grounding regressions | Prompt context grows slightly |
| Repeated no-information exploration consumes budget | A cumulative budget will bound waste | Stop after four no-information calls while preserving evidence | AgentLoop deterministic regression | Some difficult investigations may stop earlier |
| Dirty working tree is not identified by Git HEAD | Content identity will make resume compatibility explicit | Include a source content SHA-256 in the model manifest | Resume identity tests and series script checks | Any source change invalidates resume |

The v3 path does not expose Gold, case IDs, benchmark Evidence IDs, observation values or expected answers to the Agent. It does not remove failures, relax grounding, alter approval scope or permit external writes.
