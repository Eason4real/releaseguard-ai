# Risk Agent Phase 3 — Final Requirements

This file records the approved Phase 3 target for the existing v15 repository.
It supersedes earlier Phase 3 drafts where they conflict.

## Product boundary

- Keep Phase 1, Phase 1.5 and Phase 2 behavior compatible.
- The deterministic statistics system creates `RiskEvent`; the LLM never decides
  whether an anomaly exists and cannot mutate a `RiskEvent`.
- `LLMInvestigationPlanner` and `DeterministicInvestigationPlanner` share one
  service-side `AgentLoop`.
- Persist iterations, public investigation trace, hypotheses, evidence links,
  messages, diagnosis revisions and immutable approval snapshots.
- Do not persist or expose hidden model chain-of-thought.
- Approval Reject closes the run without action; it is not `INCONCLUSIVE`.
- `INCONCLUSIVE` is reserved for insufficient evidence, insufficient tools or
  investigation budget exhaustion.
- A PM who finds the investigation incomplete uses Continue Investigation,
  which withdraws the pending snapshot and returns the Run to `RUNNING`.

## Retrieval and RAG

- `search_user_feedback` must query a multi-record feedback corpus with lexical
  relevance, time filters and product metadata.
- The incident knowledge base contains 15–20 documents, semantic chunks and
  deliberately misleading near matches.
- Production supports Workers AI `@cf/baai/bge-m3` embeddings and Cloudflare
  Vectorize.
- D1 remains the source of truth for documents, chunks, metadata and provenance.
- Retrieval fuses BM25 lexical ranking, vector ranking and metadata using RRF.
- Local and CI use a deterministic fallback and must identify that mode.
- Phase 3 does not include a reranker.

## Quality gates

- Deterministic Agent Eval is the CI gate.
- RAG Eval compares lexical, vector and hybrid Recall@1, Recall@3 and MRR.
- Live LLM Eval is reported separately and is non-blocking.
- `lint`, `test`, `tsc`, `build` and `eval` must pass without regressing the
  existing Approval/GitHub action path.

## Explicit exclusions

No Multi-Agent, Slack, Jira, MCP, Skills, LangChain migration, automatic repair,
rollback, re-verification, enterprise authentication, multi-tenancy, Astronomy
Shop or large-scale UI rewrite.
