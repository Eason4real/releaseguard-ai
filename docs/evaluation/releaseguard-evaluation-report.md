# ReleaseGuard AI — Reproducible Agent Evaluation

> Evaluation version 0.2.0 · 22 governed offline cases · three independent runs per system  
> Status: results are generated from `evaluation/results/summary.json`; no unexecuted value is
> presented as measured. This report deliberately distinguishes synthetic Dev evidence from public
> postmortems and enterprise production data.

## 1. Executive summary

This evaluation compares a one-shot Direct LLM baseline, the frozen Current Agent, and a narrowly
Improved Agent under the same DeepSeek model, dataset, temperature, model/tool budgets, timeout,
retry, and single-threaded execution. The evaluation found material reliability and efficiency
problems in the Current Agent before changes: repeated malformed structured decisions, long
no-information investigation tails, and unstable terminal outcomes. The implementation changes are
case-agnostic: DeepSeek JSON-object response mode, one additional bounded schema repair inside the
unchanged total model budget, and explicit convergence instructions.

The canonical measured comparison is in [`evaluation/results/summary.json`](../../evaluation/results/summary.json).
The public `/benchmark` page reads the generated build copy of that same artifact. Percentages in
the final summary must always be read with their raw numerator/denominator and Wilson interval.

## 2. Project and evaluation objective

ReleaseGuard AI investigates whether a product release caused a product metric problem, links
read-only observations to competing hypotheses, produces an evidence-grounded diagnosis, and gates
external writes behind exact human approval. This evaluation tests the offline investigation
runtime, not production analytics integration, enterprise user adoption, or business ROI.

## 3. Capability boundary

The executable benchmark uses fixture-backed `get_release`, `query_metric`, `segment_metric`,
`search_user_feedback`, and `search_similar_incidents`. It does not connect to a real production
warehouse. No run performs a GitHub write. Successful approval/action execution elsewhere in the
product stops at `WAITING_VERIFICATION`; automated post-fix proof is outside v17.

## 4. Dataset source and distribution

The frozen governed Dev dataset contains 22 offline reconstructed cases. Audit showed that it is
**not** 22 independently sourced public incidents: 16 are synthetic and six are repository-native.
The separate 42-record public postmortem corpus is used for retrieval evaluation and is not reused
as current-incident Gold because its summaries can contain final root causes. Dataset version and
Hash are recorded in the generated summary and `evaluation/dataset/SHA256SUMS`.

## 5. Answer-leakage control

Execution receives only the initial anomaly and a strict projection of allowed observations. Gold,
acceptable aliases, evidence roles, category, difficulty, provenance notes, and scorer metadata are
evaluation-plane only. Runtime retrieval cannot receive the current case postmortem. The dataset is
a visible Dev set rather than an unseen Holdout, which limits claims even though the implementation
contains no case ID, incident name, or Gold-specific branching.

## 6. Test environment and version

- Source commit before changes: `aca76ff977e38df48390da10d622768c61e301b1`.
- Initial dirty state: user-owned untracked `portfolio/`; it was preserved and excluded from work.
- Runtime: WSL 2 / Ubuntu 24.04, Node.js 22+, concurrency 1.
- Provider/model: DeepSeek OpenAI-compatible Chat Completions, `deepseek-v4-flash`.
- Temperature 0.1; 5,000 max output tokens; 75-second request timeout; zero transport retries.
- Agent budgets: 20 total model calls, 10 tool calls, 16 iterations.

## 7. Baselines

**Direct LLM** receives the same initial anomaly and all allowed static observations in one call,
without dynamic tools. **Current Agent** is the frozen pre-change Planner and shared AgentLoop.
**Improved Agent** changes only structured-output reliability and convergence behavior. A Fixed
Workflow baseline was not implemented: the existing deterministic harness validates pipeline
repeatability but does not constitute a comparable LLM investigation and presenting it as accuracy
would be misleading.

## 8. Metric definitions and scoring

Scoring was frozen before Agent changes in `evaluation/config/scoring.json`. Technical completion,
business completion, root-cause score (2/1/0/N/A), citation validity, critical-evidence recall,
unsupported claims, observed tool behavior, three-run stability, latency, tokens, and estimated
cost are separate metrics. Root-cause boundary cases use a blind same-model LLM judge. System names
are hidden and output order is deterministically randomized, but because the judge is not an
independent model it must not be described as human-reviewed or independent adjudication.

## 9. Overall comparison

The authoritative table is generated in `evaluation/results/summary.json` after the three Improved
Agent runs and blind review. It includes, for every system, raw counts and Wilson 95% intervals for:

- technical and business completion;
- strict 2-point accuracy and lenient 1-or-2 hit rate;
- mean root-cause score and N/A count;
- evidence, tool, stability, latency, token, and cost measures.

No partial run is admitted to the 66-trial denominator. Interrupted attempts are retained as
separate raw artifacts and disclosed as operational overhead.

<!-- GENERATED_OVERALL_START -->
| System | Technical completion | Business completion | Strict score 2 | Lenient score 1–2 | Mean score | N/A |
| --- | --- | --- | --- | --- | ---: | ---: |
| Direct LLM | 65/66 (98.5%; Wilson 95% CI 91.9%–99.7%) | 64/66 (97.0%; Wilson 95% CI 89.6%–99.2%) | 48/66 (72.7%; Wilson 95% CI 61.0%–82.0%) | 54/66 (81.8%; Wilson 95% CI 70.9%–89.3%) | 1.5455 / 2 | 0 |
| Current Agent | 53/66 (80.3%; Wilson 95% CI 69.2%–88.1%) | 15/66 (22.7%; Wilson 95% CI 14.3%–34.2%) | 16/66 (24.2%; Wilson 95% CI 15.5%–35.8%) | 22/66 (33.3%; Wilson 95% CI 23.2%–45.3%) | 0.5758 / 2 | 0 |
| Improved Agent | 43/66 (65.1%; Wilson 95% CI 53.1%–75.5%) | 12/66 (18.2%; Wilson 95% CI 10.7%–29.1%) | 9/66 (13.6%; Wilson 95% CI 7.3%–23.9%) | 20/66 (30.3%; Wilson 95% CI 20.5%–42.2%) | 0.4394 / 2 | 0 |

Judge: NON_INDEPENDENT_SAME_MODEL; status COMPLETE; 0/22 case-level judge requests failed and 198 trial outputs received scores. 23 trial outputs are listed for human review. These are not human-reviewed scores.
<!-- GENERATED_OVERALL_END -->

## 10. Incident-type and difficulty slices

`summary.json.slices` contains the executed trial count, technical completion, strict score count,
and mean score for each incident type and difficulty. These slices are diagnostic only: many cells
contain a small number of cases, so they are not evidence of general domain performance.

<!-- GENERATED_SLICES_START -->
### Incident type
| Slice | System | Trials | Strict score 2 | Technical completion | Mean score |
| --- | --- | ---: | --- | --- | ---: |
| configuration | Direct LLM | 12 | 8/12 (66.7%; Wilson 95% CI 39.1%–86.2%) | 11/12 (91.7%; Wilson 95% CI 64.6%–98.5%) | 1.3333 |
| configuration | Current Agent | 12 | 2/12 (16.7%; Wilson 95% CI 4.7%–44.8%) | 7/12 (58.3%; Wilson 95% CI 31.9%–80.7%) | 0.3333 |
| configuration | Improved Agent | 12 | 1/12 (8.3%; Wilson 95% CI 1.5%–35.4%) | 8/12 (66.7%; Wilson 95% CI 39.1%–86.2%) | 0.3333 |
| insufficient_evidence | Direct LLM | 12 | 12/12 (100.0%; Wilson 95% CI 75.8%–100.0%) | 12/12 (100.0%; Wilson 95% CI 75.8%–100.0%) | 2 |
| insufficient_evidence | Current Agent | 12 | 9/12 (75.0%; Wilson 95% CI 46.8%–91.1%) | 12/12 (100.0%; Wilson 95% CI 75.8%–100.0%) | 1.5833 |
| insufficient_evidence | Improved Agent | 12 | 4/12 (33.3%; Wilson 95% CI 13.8%–60.9%) | 8/12 (66.7%; Wilson 95% CI 39.1%–86.2%) | 0.8333 |
| release_regression | Direct LLM | 15 | 6/15 (40.0%; Wilson 95% CI 19.8%–64.3%) | 15/15 (100.0%; Wilson 95% CI 79.6%–100.0%) | 1.1333 |
| release_regression | Current Agent | 15 | 0/15 (0.0%; Wilson 95% CI 0.0%–20.4%) | 12/15 (80.0%; Wilson 95% CI 54.8%–93.0%) | 0.1333 |
| release_regression | Improved Agent | 15 | 1/15 (6.7%; Wilson 95% CI 1.2%–29.8%) | 10/15 (66.7%; Wilson 95% CI 41.7%–84.8%) | 0.4 |
| unknown | Direct LLM | 9 | 9/9 (100.0%; Wilson 95% CI 70.1%–100.0%) | 9/9 (100.0%; Wilson 95% CI 70.1%–100.0%) | 2 |
| unknown | Current Agent | 9 | 0/9 (0.0%; Wilson 95% CI 0.0%–29.9%) | 8/9 (88.9%; Wilson 95% CI 56.5%–98.0%) | 0.1111 |
| unknown | Improved Agent | 9 | 1/9 (11.1%; Wilson 95% CI 2.0%–43.5%) | 6/9 (66.7%; Wilson 95% CI 35.4%–87.9%) | 0.3333 |
| upstream_dependency | Direct LLM | 9 | 7/9 (77.8%; Wilson 95% CI 45.3%–93.7%) | 9/9 (100.0%; Wilson 95% CI 70.1%–100.0%) | 1.6667 |
| upstream_dependency | Current Agent | 9 | 4/9 (44.4%; Wilson 95% CI 18.9%–73.3%) | 6/9 (66.7%; Wilson 95% CI 35.4%–87.9%) | 0.8889 |
| upstream_dependency | Improved Agent | 9 | 1/9 (11.1%; Wilson 95% CI 2.0%–43.5%) | 6/9 (66.7%; Wilson 95% CI 35.4%–87.9%) | 0.3333 |
| user_feedback | Direct LLM | 9 | 6/9 (66.7%; Wilson 95% CI 35.4%–87.9%) | 9/9 (100.0%; Wilson 95% CI 70.1%–100.0%) | 1.3333 |
| user_feedback | Current Agent | 9 | 1/9 (11.1%; Wilson 95% CI 2.0%–43.5%) | 8/9 (88.9%; Wilson 95% CI 56.5%–98.0%) | 0.4444 |
| user_feedback | Improved Agent | 9 | 1/9 (11.1%; Wilson 95% CI 2.0%–43.5%) | 5/9 (55.6%; Wilson 95% CI 26.7%–81.1%) | 0.3333 |

### Difficulty
| Slice | System | Trials | Strict score 2 | Technical completion | Mean score |
| --- | --- | ---: | --- | --- | ---: |
| EASY | Direct LLM | 18 | 8/18 (44.4%; Wilson 95% CI 24.6%–66.3%) | 18/18 (100.0%; Wilson 95% CI 82.4%–100.0%) | 0.8889 |
| EASY | Current Agent | 18 | 0/18 (0.0%; Wilson 95% CI 0.0%–17.6%) | 14/18 (77.8%; Wilson 95% CI 54.8%–91.0%) | 0.0556 |
| EASY | Improved Agent | 18 | 0/18 (0.0%; Wilson 95% CI 0.0%–17.6%) | 12/18 (66.7%; Wilson 95% CI 43.8%–83.7%) | 0.1667 |
| HARD | Direct LLM | 15 | 15/15 (100.0%; Wilson 95% CI 79.6%–100.0%) | 15/15 (100.0%; Wilson 95% CI 79.6%–100.0%) | 2 |
| HARD | Current Agent | 15 | 4/15 (26.7%; Wilson 95% CI 10.9%–51.9%) | 13/15 (86.7%; Wilson 95% CI 62.1%–96.3%) | 0.7333 |
| HARD | Improved Agent | 15 | 2/15 (13.3%; Wilson 95% CI 3.7%–37.9%) | 9/15 (60.0%; Wilson 95% CI 35.8%–80.2%) | 0.5333 |
| MEDIUM | Direct LLM | 33 | 25/33 (75.8%; Wilson 95% CI 59.0%–87.2%) | 32/33 (97.0%; Wilson 95% CI 84.7%–99.5%) | 1.697 |
| MEDIUM | Current Agent | 33 | 12/33 (36.4%; Wilson 95% CI 22.2%–53.4%) | 26/33 (78.8%; Wilson 95% CI 62.3%–89.3%) | 0.7879 |
| MEDIUM | Improved Agent | 33 | 7/33 (21.2%; Wilson 95% CI 10.7%–37.8%) | 22/33 (66.7%; Wilson 95% CI 49.6%–80.3%) | 0.5455 |
<!-- GENERATED_SLICES_END -->

## 11. Stability, latency, cost, and safety

Stability is measured as first-run technical Pass@1, all-three technical completion, terminal-state
consistency, root-score consistency, and offline intervention-free execution. “Intervention-free”
means the harness did not require a human to edit state or input mid-run; it is not an enterprise
unattended-operation claim. Cost uses published peak and off-peak token rates with all inputs
conservatively treated as cache misses; it is an estimate, not an invoice.

Safety conclusions are test-specific. The regression suite covers exact approval binding,
unapproved completion rejection, frozen arguments, replay/idempotency, cross-run evidence rejection,
RAG-only root-cause rejection, invalid Planner/tool decisions, atomic failure behavior, and failure
state preservation. No dedicated hostile prompt-injection test was found in the audited suite, so
this report does **not** claim a measured prompt-injection bypass rate.

<!-- GENERATED_PERFORMANCE_START -->
| System | Pass@1 technical | All 3 technical | Terminal consistency | Root-score consistency | P50 | P95 | Model calls | Tool calls | Peak cost estimate |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Direct LLM | 21/22 (95.5%; Wilson 95% CI 78.2%–99.2%) | 21/22 (95.5%; Wilson 95% CI 78.2%–99.2%) | 21/22 (95.5%; Wilson 95% CI 78.2%–99.2%) | 18/22 (81.8%; Wilson 95% CI 61.5%–92.7%) | 7.8 s | 15.5 s | 66 | 0 | $0.1105 |
| Current Agent | 18/22 (81.8%; Wilson 95% CI 61.5%–92.7%) | 11/22 (50.0%; Wilson 95% CI 30.7%–69.3%) | 6/22 (27.3%; Wilson 95% CI 13.2%–48.1%) | 13/22 (59.1%; Wilson 95% CI 38.7%–76.7%) | 131.2 s | 317.1 s | 627 | 323 | $2.1050 |
| Improved Agent | 19/22 (86.4%; Wilson 95% CI 66.7%–95.3%) | 2/22 (9.1%; Wilson 95% CI 2.5%–27.8%) | 1/22 (4.5%; Wilson 95% CI 0.8%–21.8%) | 7/22 (31.8%; Wilson 95% CI 16.4%–52.7%) | 153.7 s | 422.6 s | 477 | 226 | $1.9751 |

- **Direct LLM errors:** `Expected ',' or '}' after property value in JSON at position 1118 (line 1 column 1119)` 1. Tokens: 54,618 input / 65,534 output.
- **Current Agent errors:** `PLANNER_SCHEMA_ERROR` 9, `RUNTIME_ERROR` 4. Tokens: 1,869,788 input / 971,457 output.
- **Improved Agent errors:** `PLANNER_SCHEMA_ERROR` 1, `RUNTIME_ERROR` 22. Tokens: 1,700,755 input / 929,373 output.
<!-- GENERATED_PERFORMANCE_END -->

## 12. Typical successful case

`summary.json.typicalTrace` selects an actual Improved Agent trial with a blind 2-point root-cause
score, retaining public rationale, tool result status, and evidence IDs. The first judge attempt
failed with HTTP 402 `Insufficient Balance`; after replenishment, the separately executed retry
scored all 198 anonymous outputs. The failed attempt remains archived for audit.

## 13. Typical failed case

Current Agent runs showed both technical malformed-response failures and technically successful but
business-incomplete investigations. CASE-215, for example, consumed long trajectories in different
runs before alternating between inconclusive and finalized states. The raw report files preserve
the exact trajectory; this case is not removed or replaced by a favorable rerun.

## 14. Error distribution

Current Agent had nine `PLANNER_SCHEMA_ERROR` failures and four generic runtime failures. Improved
Agent run 3 then encountered provider account exhaustion: after two completed cases, the remaining
20 cases failed, including 19 near-immediate zero-call failures. The first judge attempt also
reported HTTP 402 `Insufficient Balance` for all 22 requests; it was archived, then the complete
judge-only retry succeeded after replenishment. Agent run 3 failures remain in the formal
denominator and must not be attributed to Agent reasoning quality. Separately, tool `EMPTY` means no
information gain, not a transport failure.

## 15. Product changes

1. **DeepSeek JSON-object mode.** Structured Planner calls request
   `response_format: {"type":"json_object"}` for DeepSeek. This targets invalid/empty JSON while
   leaving generic OpenAI-compatible behavior unchanged.
2. **Second bounded repair.** Production and live evaluation allow at most two schema repair
   attempts, still inside the unchanged 20-call server budget. This improves recoverability but may
   add latency/tokens when the provider repeatedly violates the contract.
3. **Convergence policy.** Planner instructions require unsupported speculative alternatives to be
   rejected or downgraded after relevant current-event sources are queried and require stopping
   no-information exploration. This targets wasted calls without changing tool or iteration limits.

Focused regression coverage verifies JSON-object mode and the exhausted-repair path. The full
runtime suite passed after these changes.

## 16. Before/after comparison

The comparison must be read from `summary.json.systems` after generation. Improvements and
regressions are reported together: schema failure count, technical/business completion, strict and
lenient root-cause scores, no-information calls, model/tool calls, P50/P95, tokens, cost, and
stability. A lower latency with lower diagnosis quality is not classified as an unqualified win.

<!-- GENERATED_DELTA_START -->
| Metric | Current Agent | Improved Agent | Delta |
| --- | ---: | ---: | ---: |
| Technical completion | 53/66 (80.3%; Wilson 95% CI 69.2%–88.1%) | 43/66 (65.1%; Wilson 95% CI 53.1%–75.5%) | -15.2 percentage points |
| Business completion | 15/66 (22.7%; Wilson 95% CI 14.3%–34.2%) | 12/66 (18.2%; Wilson 95% CI 10.7%–29.1%) | -4.6 percentage points |
| Strict root-cause accuracy | 16/66 (24.2%; Wilson 95% CI 15.5%–35.8%) | 9/66 (13.6%; Wilson 95% CI 7.3%–23.9%) | -10.6 percentage points |
| Mean root-cause score | 0.5758 | 0.4394 | -0.14 |
| P50 latency | 131.2 s | 153.7 s | 22.5 s |
| P95 latency | 317.1 s | 422.6 s | 105.5 s |
| Peak estimated cost | $2.1050 | $1.9751 | $-0.1299 |
<!-- GENERATED_DELTA_END -->

## 17. Known limitations

- 22 governed Dev cases are small, visible during development, and not an unseen Holdout.
- Six repository-native and sixteen synthetic cases cannot represent enterprise incident diversity.
- Same-model blind judging is non-independent; queued items require real human review.
- Fixture tools do not measure production connector reliability or data quality.
- Published-token cost estimates can differ from billed usage and exclude engineering labor.
- The extra interrupted Improved Agent attempt is operational overhead, not a formal trial.
- DeepSeek balance exhaustion materially corrupted Improved Agent run 3. The later judge-only retry
  succeeded, so semantic scores are complete, but they score the frozen failed trials as failures and
  cannot remove the provider-outage confound from the Improved comparison.

## 18. Reproduction

See [`docs/evaluation/reproduce.md`](reproduce.md). It freezes and verifies dataset Hashes, runs the
Direct and Agent systems, saves checkpoints, performs blind semantic review, generates summary and
review queue artifacts, and runs project validation. Credentials remain outside the repository.

## 19. Conclusion and next steps

This work turns an existing Dev benchmark into an auditable comparison without relabeling synthetic
fixtures as public incidents or treating deterministic pipeline success as Agent accuracy. The next
credible step is an independently curated Holdout with real public-source citations, independent or
human semantic adjudication, and an explicit adversarial prompt-injection suite. Production claims
should wait for authorized live data integrations and prospective evaluation.
