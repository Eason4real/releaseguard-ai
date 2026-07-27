# ReleaseGuard AI Project Context

This file is the standing project context for Codex and other coding agents working in this repository. Read it before changing code. Also read the relevant source and tests for the area being changed. The repository is the source of truth for current behavior; documents under `docs/` describe product and architecture intent and may include future work.

## Product Goal

ReleaseGuard AI is an AI Release Intelligence Agent for product managers, product owners, and release owners. It helps teams determine whether a release caused a product problem, identify affected metrics and user segments, connect symptoms to release changes and user feedback, test competing hypotheses with evidence, recommend a controlled response, and place external write actions behind explicit human approval.

The product focuses on product release risk: product metrics, user feedback, release context, limited technical signals, and PM decisions. It is not a general-purpose SRE agent, infrastructure debugger, or autonomous remediation system.

## Version And Provenance

- Current migrated product version: **v17**.
- Project identity: **ReleaseGuard AI / risk-command-center**.
- Source branch at packaging time: `main`.
- Original deployed v17 HEAD recorded by the migration package: `75cbe4140aa0ff5e079df17fead96167836129db`.
- The migration archive intentionally excluded the original `.git` database.
- Any commit created after importing this archive is a new local migration commit. Do not claim that it is identical to the original v17 HEAD.
- The v17 archive was produced from the deployed Git tree and excludes dependencies, build outputs, runtime state, TypeScript caches, local databases, and real environment values.

## Completed Capabilities

### Phase 1: Investigation Runtime

- Persistent, auditable `InvestigationRun` lifecycle.
- Structured `ToolCall`, `ToolResult`, `Evidence`, `Diagnosis`, and `ProposedAction` records.
- Server-owned run state and recovery after page refresh.
- Deterministic Android 7.3.0 investigation fixture.
- OpenAI-compatible live model configuration, including DeepSeek and Kimi-compatible endpoints.

### Phase 1.5: Approval And Action Hardening

- Persistent approval tied to one run and one specific proposed action.
- Server-side approval validation and frozen action arguments.
- GitHub Issue creation represented and audited as a runtime tool call.
- Replay/deduplication protection and audit events.
- Explicit reject and `CLOSED_NO_ACTION` behavior.
- Successful approved action transitions the run to `WAITING_VERIFICATION`.

### Phase 2: Risk Detection And Analytics

- Metric buckets and deterministic Android 7.3.0 analytics fixture.
- Deterministic anomaly detection using dynamic baselines, minimum sample sizes, and consecutive-window rules.
- Persistent `RiskEvent` linked to a `Release` and an `InvestigationRun`.
- Formal `get_release`, `query_metric`, and `segment_metric` tool contracts.
- Investigation launch from a detected `RiskEvent`.

### Phase 3: Agent Loop, Chat, And Hybrid RAG

- A shared `InvestigationPlanner` contract implemented by `LLMInvestigationPlanner` and `DeterministicInvestigationPlanner`.
- One service-side `AgentLoop` for both planner types.
- Persistent iterations, public trace events, hypotheses, evidence links, confidence calculation, messages, diagnosis revisions, and approval snapshots.
- Continue Investigation flow from `WAITING_APPROVAL`, including withdrawal of the pending snapshot and return to `RUNNING`.
- Human-Agent chat integrated with the same investigation runtime.
- Feedback and historical incident retrieval with chunking, metadata, embeddings, lexical/vector search, and hybrid fusion.
- Workers AI and Vectorize production path, plus an explicit deterministic local/CI fallback.
- Deterministic Agent Runtime regression coverage and RAG evaluation.
- Production-bundle guard for deterministic planner construction.

## Core Architecture

- `app/`: product UI and server API routes for investigations, messages, approvals, GitHub connection, and GitHub Issue actions.
- `lib/investigation/`: investigation state, runtime, shared planner contract, LLM and deterministic planners, AgentLoop, tools, confidence, chat, revisions, approval/action runtime, repositories, and stores.
- `lib/analytics/`: releases, metric data, RiskEvent persistence, and analytics access.
- `lib/risk-detection/`: deterministic baseline and anomaly detection policy.
- `lib/retrieval/`: feedback and incident retrieval contracts, tokenization, embeddings, lexical/vector/hybrid retrieval, and fallback runtime.
- `lib/fixtures/`: deterministic Android 7.3.0 fixture data.
- `db/`: D1/Drizzle schema and database adapters.
- `drizzle/`: ordered SQL migrations. Preserve migration order and never rewrite an applied migration casually.
- `worker/`: Cloudflare Worker entry point and runtime binding integration.
- `scripts/`: locked install, verified build, artifact validation, runtime tests, and evaluation entry points.
- `tests/`: production bundle, rendered HTML, investigation, analytics, risk detection, and retrieval regression tests.
- `eval/`: deterministic RAG evaluation implementation and fixtures.

Cloudflare D1 is the durable source of truth in hosted execution. Workers AI supplies BGE-M3 embeddings and Vectorize supplies persistent vector search when both bindings are available. Local development and CI use the configured D1 simulation and deterministic retrieval fallback. The fallback mode must be reported honestly; never present it as hosted vector retrieval.

## Runtime Boundaries

### Planner

- A Planner answers: given the current persisted aggregate and public context, what should happen next?
- It may return only a structured `CALL_TOOL`, `ASK_HUMAN`, `FINALIZE`, or `STOP_INCONCLUSIVE` decision through the shared contract.
- LLM and deterministic planners must remain interchangeable behind that contract and must use the same AgentLoop.
- A Planner does not own persistence, permissions, approval, tool execution, budgets, duplicate detection, or run-state transitions.
- Do not persist or expose hidden chain-of-thought. Persist only public rationale, hypotheses, selected actions, observations, and evidence links.

### AgentLoop

- The AgentLoop owns iteration and tool-call budgets, allowed tool execution, canonical duplicate detection, stopping behavior, public trace creation, persistence coordination, and structured finalization.
- It must preserve partial evidence when a planner or tool fails.
- `INCONCLUSIVE` is reserved for insufficient evidence, insufficient tools, or exhausted investigation budget. Approval rejection is not inconclusive.
- Avoid unbounded loops. Preserve maximum-iteration, maximum-tool-call, no-new-evidence, and duplicate-call safeguards.

### Tools And Results

- Tools are atomic capabilities. The registered tool set and the tools visible for a particular investigation are separate concepts.
- Read-only investigation tools may run autonomously. External write tools require approval.
- The runtime validates tool availability and arguments. Do not let model output bypass server-side validation.
- Tool calls use canonical signatures based on tool name and normalized arguments. Exact duplicates must not trigger duplicate external work.
- A `ToolResult` is the raw or normalized machine/API/database response and must distinguish `SUCCESS`, `EMPTY`, and `ERROR`. Tool failure does not automatically mean investigation failure.

### Evidence

- `Evidence` is an auditable interpretation derived from a `ToolResult`; it is not the raw result itself.
- Every evidence item must retain source, provenance, strength, collection time, and the tool-result relationship.
- Never invent evidence or silently treat a historical similarity as proof.
- Aggregate large datasets in SQL/tool implementations and give the planner only relevant summaries, breakdowns, and representative samples.

### Hypotheses And Confidence

- Investigations should maintain competing hypotheses and actively collect both supporting and contradicting evidence.
- Link evidence with `SUPPORTS`, `CONTRADICTS`, or `NEUTRAL`; do not infer confidence from supportive evidence alone.
- Confidence is runtime-derived and expressed as `HIGH`, `MEDIUM`, or `LOW`. Do not introduce fake percentage precision unless backed by a defined scoring model.
- Human-added hypotheses use the same persisted model and audit trail as agent hypotheses.

### Approval And Actions

- Approval applies to one exact proposed tool call, not to an incident or broad class of actions.
- The server must validate run, action, approval, tool call, state, target, and immutable snapshot before execution.
- Approved execution must use frozen, reviewed arguments rather than mutable client or planner input.
- Preserve replay protection, idempotency markers, revisions, supersession/withdrawal state, and audit events.
- Reject closes the run without action. Continue Investigation withdraws the pending approval snapshot and resumes the same run.
- The only implemented v17 write action is `CREATE_GITHUB_ISSUE`. Do not introduce silent writes or execute an action before approval.
- A successful action enters `WAITING_VERIFICATION`; it does not prove that the incident is resolved.

### RAG And Retrieval

- RAG is historical incident memory and feedback retrieval used to form or prioritize hypotheses.
- D1 remains the source of truth for documents, chunks, metadata, and provenance.
- Hosted retrieval uses Workers AI embeddings and Vectorize; hybrid ranking combines lexical, vector, and metadata signals using reciprocal-rank fusion.
- Local/CI retrieval is deterministic and must identify itself as fallback mode.
- Retrieval must honor time and product metadata filters and should retrieve progressively: aggregate/themes first, then focused samples or incident detail.
- Similar incidents are clues, not evidence of the current root cause. Preserve adversarial near-match coverage and do not add a reranker without an explicit new phase decision.

## Design Principles That Must Not Regress

- Deterministic statistics decide whether an anomaly exists; the LLM investigates why. The LLM cannot create or mutate a `RiskEvent` as an analytical judgment.
- Keep one Investigation Agent with structured state and atomic tools. Do not introduce Multi-Agent orchestration without a reviewed architectural need.
- Server-owned state, permissions, approval, and action execution are authoritative. Never trust client state or LLM output for security boundaries.
- Keep investigation artifacts durable, recoverable, revisioned where required, and auditable across refreshes and retries.
- Preserve the distinction among ToolResult, Evidence, Hypothesis, Diagnosis, ProposedAction, Approval, and ApprovalSnapshot.
- Do not store private chain-of-thought. Store concise public rationale and trace information only.
- Prefer evidence-backed uncertainty over hallucinated certainty. Missing or conflicting data may legitimately produce `INCONCLUSIVE`.
- Treat historical retrieval as hypothesis support, never current-incident proof.
- Maintain least privilege: investigation tools are read-only; external writes are narrow, explicit, validated, and approved.
- Preserve Phase 1, 1.5, and 2 behavior when extending Phase 3.
- Keep deterministic fixtures and evaluations reproducible. Do not present synthetic or public-reference data as private production data.
- Do not point local development at production D1 or reuse hosted resources without explicit authorization.
- Make the smallest coherent change. Audit current code and tests before implementing a broader product specification or refactor.

## Known V17 Limitations

- Android 7.3.0 analytics and investigation data are deterministic fixtures, not a live production analytics integration.
- Automated post-fix re-verification is not implemented; successful action execution stops at `WAITING_VERIFICATION`.
- Hosted semantic retrieval requires both Workers AI and Vectorize. The deterministic fallback is for development and CI, not production-quality semantic ranking.
- GitHub Issue creation requires a user-provided repository and credential and performs a real external write only after validated approval.
- There is no Astronomy Shop runtime, Slack, Jira, MCP, Skills runtime, Multi-Agent execution, general external ingestion pipeline, automatic repair, rollback, enterprise authentication, or multi-tenancy.
- Phase 3 has no reranker.
- The UI is an incremental product demonstration, not a complete multi-tenant administration console.

Do not describe a limitation as implemented merely because it appears as a future target in `docs/`.

## Local Development Environment

- Node.js `>=22.13.0` and npm are required.
- Install dependencies with `npm ci`; keep `package-lock.json` authoritative.
- The repository helpers target Linux and require Bash, `flock`, `curl`, and GNU `timeout`.
- On Windows, use WSL 2 or another compatible Linux environment. Prefer running the repository from the WSL Linux filesystem rather than `/mnt/c` for filesystem performance and reliable file watching.
- Create local configuration from `.env.example` only when needed. Never commit `.env`, API keys, GitHub tokens, hosted values, local databases, Wrangler state, dependencies, or generated build output.
- The deterministic fixture and CI evaluation do not require an LLM credential.

Local setup and development server:

```bash
npm ci
cp .env.example .env
npm run dev
```

Production output is generated under `dist/` and must remain untracked.

## Validation Commands

Primary checks:

```bash
npm run tsc
npm run lint
npm test
npm run eval
```

Verified production build:

```bash
npm run build
```

Narrower checks when appropriate:

```bash
npm run eval:rag
npm run eval:live
npm run validate:artifact
```

`npm test` already runs the verified production build, validates the production bundle, runs runtime and Phase 1/1.5/2 regression coverage, and checks rendered HTML. Deterministic Agent Eval is the CI gate. RAG Eval measures lexical, vector, and hybrid Recall@1, Recall@3, and MRR. Live LLM Eval is optional, credential-dependent, and non-blocking.

## Minimum Acceptance For Every Code Change

1. Read this file, the relevant implementation, and the nearest tests before editing. For broad product work, also read `docs/PRODUCT_SPEC.md`, `docs/AGENT_ARCHITECTURE.md`, `docs/DATA_AND_EVAL.md`, and `docs/PHASE3_REQUIREMENTS.md`.
2. Keep the change scoped. Do not combine unrelated refactors, generated metadata churn, dependency updates, or database migrations.
3. Add or update focused regression tests for changed behavior, especially state transitions, persistence, approval/action validation, tool contracts, retrieval ranking, and fallback behavior.
4. Run the closest focused tests during development.
5. Before handoff, run at minimum `npm run tsc`, `npm run lint`, and `npm test`. Run `npm run eval` for changes to Planner, AgentLoop, tools, evidence/hypothesis logic, confidence, diagnosis, chat, risk detection, retrieval/RAG, or evaluation behavior.
6. Run `npm run build` when production packaging, Worker bindings, routes, frontend integration, or bundle behavior changes. Note that `npm test` already includes the verified build, but an explicit build may still be useful for isolated diagnosis.
7. Confirm approval and GitHub action regressions remain covered whenever runtime state, actions, persistence, or API routes change.
8. Confirm `git status` contains only intentional source/test/documentation changes and no `.env`, credentials, `node_modules`, `dist`, `.next`, Wrangler state, local databases, or caches.
9. Report exactly which commands were run and whether they passed. If an environment or credential prevents a required check, state that explicitly; do not imply it passed.
10. Do not deploy, configure a remote, push, modify production data, or perform a real external write unless the user explicitly authorizes that action.
