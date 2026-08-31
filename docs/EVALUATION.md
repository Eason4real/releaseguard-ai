# ReleaseGuard AI Evaluation

English | [简体中文](EVALUATION.zh-CN.md)

## 1. Evaluation goals

ReleaseGuard evaluation does more than compare the wording of a final answer. It checks whether an investigation completes within controlled budgets, cites valid evidence, preserves warranted uncertainty, and respects tool and approval boundaries.

The repository provides three validation layers:

1. **Runtime regression tests:** State transitions, tools, evidence, approval, execution, verification, risk detection, and retrieval behavior.
2. **Deterministic offline evaluation:** Reproducible in CI without an external model credential.
3. **Live LLM evaluation:** Records the model, parameters, tokens, latency, and raw output separately and is not a required gate for credential-free CI.

## 2. Dataset scope

The investigation benchmark currently contains 22 reconstructed public incidents or deterministic fixture cases. Agent-visible input is separated from evaluation-only ground truth. Each case includes:

- an incident question and risk context;
- evidence fixtures accessible through tools;
- the canonical root cause and accepted expressions;
- required supporting evidence, optional supporting evidence, and distractors;
- the expected causal-answer or abstention mode;
- difficulty, category, and semantic scoring rules.

The dataset is stored under:

```text
eval/investigation-benchmark/dataset/
```

Public data, fixtures, and evaluation output must never be presented as private enterprise production data.

## 3. Answer-leakage controls

- Ground truth, canonical root causes, and semantic rubrics are available only to the scorer. They do not enter Planner input, tool context, observations, or persisted investigation state.
- The runner constructs a separate execution input containing only Agent-visible fields.
- Historical incident similarity may suggest a hypothesis but cannot directly support the current incident's root cause.
- A case containing a postmortem that directly reveals its own answer must be isolated, redesigned, or explicitly classified as a retrieval-replay test.
- Dataset content and semantic rules are hashed so changes before and after a run remain detectable.

See [investigation-benchmark-evaluation-contract.md](investigation-benchmark-evaluation-contract.md) for the detailed contract.

## 4. Metrics

### Root Cause Top-1

The scorer first determines whether the expected and predicted outputs are causal conclusions or abstentions, then applies stable-ID, exact-alias, and controlled semantic-rubric matching in that order.

- An incorrect ID cannot be repaired by similar prose.
- Generic “insufficient evidence” is not correct for a causal case.
- Definite attribution is not correct for an abstention case.
- Boundary cases that cannot be scored automatically become `REVIEW_REQUIRED`; they are never silently counted as correct or incorrect.

Reports must include automatic-evaluation coverage, correct cases, incorrect cases, review-required cases, and runtime failures rather than exposing only a percentage.

### Evidence Precision

Unique supporting evidence citations divided by all unique citations. Distractors and unknown evidence IDs remain in the denominator; a response with no citations has precision 0.

### Unsupported Claim Rate

The proportion of machine-verifiable factual diagnostic claims classified as `UNGROUNDED`. Legacy claims that cannot be evaluated are marked unavailable rather than inferred to be supported.

### Investigation Cost

Records actual model calls, tool calls, end-to-end duration, and token information when available. Missing token usage is never estimated.

### Reliability

Repeated runs with identical data and configuration are compared for workflow completion, final root cause, evidence citations, and semantic hash. The deterministic harness runs twice by default and requires identical result hashes.

## 5. Comparison design

A formal public report should compare systems on a frozen dataset and under equivalent input conditions:

| System | Description |
| --- | --- |
| Direct LLM | Receives the allowed static context once, without the Agent Loop or dynamic tool selection |
| Current Agent | ReleaseGuard Agent before the evaluated improvement |
| Improved Agent | ReleaseGuard Agent after changes derived from frozen benchmark error slices |
| Fixed Workflow (optional) | Included only when the repository contains a real, explainable fixed workflow; never invented merely to fill a comparison table |

The repository currently includes the Current Agent, a deterministic provider, and a Live Adapter. A system that has not been executed with preserved raw output is not presented as a measured result in the README.

## 6. Reproduction commands

Complete credential-free validation:

```bash
npm ci
npm run tsc
npm run lint
npm test
npm run eval
npm run eval:investigation-dev-harness
```

Focused evaluation:

```bash
npm run eval:rag
npm run eval:rag:real
npm run eval:investigation-dev-harness
```

Live LLM evaluation requires separate configuration:

```bash
LIVE_EVAL_API_KEY=...
LIVE_EVAL_BASE_URL=...
LIVE_EVAL_MODEL=...
npm run eval:investigation-live
```

Do not place credentials in shell history, reports, issues, or source code. A Live run must record its commit, model, parameters, and result file. Tests that were not run must be labeled as not run.

## 7. Publishing results

A formal result should publish at least:

- the tested commit and run time;
- dataset and semantic-rule hashes;
- model, provider, and decoding parameters;
- raw run records for every compared system;
- per-case predictions, evidence, scores, and scoring rationale;
- aggregate metrics with their raw numerators and denominators;
- failure categories, the human-review queue, and known limitations;
- reproducible commands.

Results must not be improved by deleting failed cases, changing gold labels, hard-coding answers, or reporting only the best run.

## 8. Known limitations

- Twenty-two cases support project-level offline comparison but cannot establish broad enterprise production generalization.
- Public historical incidents may appear in model pretraining data. Runtime answer isolation cannot eliminate pretraining-memory risk.
- The deterministic provider validates the harness and scorer, not the capability of a real model.
- An LLM-as-Judge using the same model must be disclosed as non-independent. The current deterministic semantic scorer does not claim to replace human review.
- End-to-end Agent runtime cannot be converted directly into claims about human time saved.
