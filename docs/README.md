# ReleaseGuard AI Documentation

English | [简体中文](README.zh-CN.md)

These documents serve product, engineering, evaluation, and security readers. Start from the document that matches your goal rather than reading in filename order.

## Quick navigation

| Goal | Recommended document |
| --- | --- |
| Understand the product problem, users, and boundaries | [PRODUCT_SPEC.md](PRODUCT_SPEC.md) |
| Understand the Agent Loop, Planner, tools, evidence, and approval model | [AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md) |
| Reproduce the current evaluation and understand its metrics | [EVALUATION.md](EVALUATION.md) |
| Understand data, fixtures, and the longer-term evaluation direction | [DATA_AND_EVAL.md](DATA_AND_EVAL.md) |
| Review future product priorities | [../ROADMAP.md](../ROADMAP.md) |
| Report or assess a security issue | [../SECURITY.md](../SECURITY.md) |

## Benchmark references

- [Dataset specification](investigation-benchmark-dataset-spec.md)
- [Evaluation contract](investigation-benchmark-evaluation-contract.md)
- [Runner design](investigation-benchmark-runner-phase1b.md)
- [Development harness](investigation-benchmark-dev-harness-phase1c4a.md)
- [Live adapter](investigation-benchmark-live-adapter-phase1c4b0b.md)
- [Live preflight](investigation-benchmark-live-preflight-phase1c4b0c1.md)
- [Observability](investigation-benchmark-observability.md)

Files with phase identifiers are implementation decision records, not product capability lists. Current behavior is defined by the repository, automated tests, and main README.

## Public corpus

- [Real public corpus V1](real-public-corpus-v1.md)
- [Public incident corpus design](real-world-corpus.md)

Public incidents and semi-synthetic fixtures support offline evaluation and retrieval validation. They are not private enterprise production data.

## Documentation rules

- Do not describe future work as implemented behavior.
- Do not describe deterministic fallback retrieval as hosted semantic retrieval.
- Do not describe public replay as Live Agent execution.
- Do not publish hidden chain-of-thought, credentials, private logs, or customer data.
- Similar historical incidents may inform hypotheses but cannot prove the current root cause.
