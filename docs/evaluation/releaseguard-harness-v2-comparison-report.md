# ReleaseGuard AI Harness v2 Comparison Report

> This is an experimental comparison on the same governed Dev set, not a Holdout, production-accuracy, or human-review claim.

## Result

| Metric | Improved Agent v1 | Harness v2 | Delta |
| --- | ---: | ---: | ---: |
| Technical completion | 43/66 (65.1%) | 62/66 (93.9%) | +28.8 pp |
| Business completion | 12/66 (18.2%) | 24/66 (36.4%) | +18.2 pp |
| Strict root cause (2) | 9/66 (13.6%) | 19/66 (28.8%) | +15.2 pp |
| Lenient root cause (1-2) | 20/66 (30.3%) | 31/66 (47.0%) | +16.7 pp |
| Mean critical evidence recall | 38.9% | 68.9% | +30.0 pp |
| EMPTY tool calls | 133/226 (58.9%) | 179/329 (54.4%) | -4.4 pp |

## Execution and stability

- Formal v2 coverage: 66/66 trials across 22 cases and three runs; technical failures: 4.
- Blind judge: 22/22 case requests, 66/66 scored outputs, 0 repairs, 0 errors.
- Pass@1 technical: 19/22 (86.4%); all-three technical: 19/22 (86.4%); terminal consistency: 11/22 (50.0%); root-score consistency: 13/22 (59.1%).
- Tool success: 329/329 (100.0%); EMPTY: 179/329 (54.4%); calls: 329.
- Latency P50/P95 over 62 observable trials: 184.6s / 326.9s.
- Tokens observed: 2603923 input / 1431315 output; peak cost estimate: $3.0351.
- Errors: PROVIDER_MALFORMED_RESPONSE=3, PARTIAL token usage requires some, but not all, token counts.=1.

## Interpretation

v2 materially recovered technical completion and improved business completion, strict/lenient root-cause scores, and critical-evidence recall. Strict accuracy remains below 30%, so no 80-90% claim is supported. Remaining problems include excessive INCONCLUSIVE outcomes, EMPTY queries, and tail schema failures.

## Provenance and exclusions

- Dataset hash: `c07959702947f821eaf635b68ec2a2d162dee403c3c9ebc3fea2b4689c4fb073`; source commit: `aca76ff977e38df48390da10d622768c61e301b1`.
- The misconfigured first attempt and quota-exhausted attempt are retained in separate directories and excluded from the formal denominator.
- Gold was available only to scoring and blind judging, never to Agent execution.
- No failures were deleted, no case-ID-specific behavior was added, and approval/write boundaries remain unchanged.

## Side effects and limitations

- Transport retry can increase wall time and billing ambiguity for lost responses.
- Fixture query-shape hints disclose metric and dimension names; production parity requires schema metadata.
- Resume logic adds checkpoint provenance and operational complexity.
- Approval, AgentLoop, evidence grounding, and external-write boundaries were not relaxed.
- Harness v2 is a Dev experiment on the same governed cases, not a Holdout or production accuracy claim.
- The v2 blind judge uses the same model family and is not independent human review.
- Failed trials can have incomplete duration and token telemetry; cost and latency denominators are disclosed.
