# ReleaseGuard AI — v17 Migration Guide

## Package identity

- Project: ReleaseGuard AI / risk-command-center
- Version: v17
- Git commit: `75cbe4140aa0ff5e079df17fead96167836129db`
- Source branch: `main`
- Original project root: `/workspace/sites/risk-command-center`
- Production site: `https://risk-command-center.easonchaocool.chatgpt.site`

This archive was generated from the exact Git tree deployed as v17. It excludes
the Git database, dependency directories, build outputs, local runtime state,
TypeScript build cache, and real environment files. See `git-info.txt` for the
source-control provenance.

## Requirements

- Node.js `>=22.13.0`
- npm
- Linux or WSL with Bash, `flock`, `curl`, and GNU `timeout`

The repository's install and build helpers target Linux. On Windows, run the
project in WSL or another compatible Linux environment.

## Local setup and start

```bash
npm ci
cp .env.example .env
npm run dev
```

Set only the credentials you intend to use. Do not commit `.env`.

The interface can run the deterministic fixture without an LLM credential.
OpenAI-compatible live investigation can be configured from the product UI, or
DeepSeek can be configured through the optional hosted environment variable
listed below.

## Type checking, linting, tests, and evaluation

```bash
npm run tsc
npm run lint
npm test
npm run eval
```

Useful narrower commands:

```bash
npm run eval:rag
npm run eval:live
npm run validate:artifact
```

`npm test` performs the production build, validates the production bundle,
runs Investigation Runtime and Phase 1/1.5/2 regression coverage, and checks
rendered HTML.

## Production build

```bash
npm run build
```

The verified deployable output is generated under `dist/`. That directory is
not included in this archive because it is reproducible.

## Deployment

This project is configured for OpenAI Sites on Cloudflare through
`.openai/hosting.json`. In Codex App, open this directory as the project and use
the Sites lifecycle to edit/checkpoint the existing site. A checkpoint runs the
locked production build, validates the artifact, commits and saves the source
version, and deploys it.

If deploying as a separate project, create a new Sites project rather than
reusing the existing `project_id`, then preserve the logical binding names
described below and apply all SQL migrations in `drizzle/`.

## Environment variable names

Only names are listed here; this package contains no values.

### Hosted/runtime model configuration

- `DEEPSEEK_API_KEY` — optional server-side DeepSeek key

### Optional live evaluation

- `LIVE_EVAL_API_KEY`
- `LIVE_EVAL_BASE_URL`
- `LIVE_EVAL_MODEL`

### Script timeout controls

- `SITES_INSTALL_TIMEOUT`
- `SITES_INSTALL_KILL_AFTER`
- `SITES_BUILD_TIMEOUT`
- `SITES_BUILD_KILL_AFTER`

GitHub credentials are not stored in this repository or declared as a checked-in
environment value. The current GitHub connection flow accepts the credential at
runtime. Never add a real GitHub token to source control.

## Cloudflare dependencies and responsibilities

| Dependency | Binding | Responsibility | Local/CI fallback |
| --- | --- | --- | --- |
| Cloudflare D1 | `DB` | Durable InvestigationRun, tool, evidence, diagnosis, action, approval, audit, risk-event, chat, and Phase 3 runtime records | Local D1 simulation configured by Vite |
| Workers AI | `AI` | BGE-M3 embeddings for real semantic retrieval | Deterministic local embedding provider |
| Cloudflare Vectorize | `VECTORIZE` | Persistent vector search for feedback and incident chunks | In-memory/local vector index |
| Static assets | `ASSETS` | Serves generated frontend assets in the deployed Worker | Vite development server |
| Cloudflare Images | `IMAGES` | Platform-provided optional image binding | Not required by the core demo |
| R2 | none | Not used in v17 (`r2` is `null`) | Not applicable |

Hybrid retrieval combines lexical score, vector score, and metadata filters.
When Workers AI or Vectorize is unavailable, the runtime reports the fallback
mode instead of silently pretending that hosted vector retrieval ran.

## Database and migrations

The D1/Drizzle schema is under `db/`, and ordered migrations are under
`drizzle/`. Apply all migrations in sequence for a new database:

- `0000_dazzling_wasp.sql`
- `0001_greedy_ego.sql`
- `0002_risk_detection.sql`
- `0003_blue_excalibur.sql`
- `0004_mighty_tiger_shark.sql`

Do not point a new local instance at the production D1 database unless that is
explicitly intended and authorized.

## Completed capabilities

### Phase 1 — Investigation Runtime

- Persistent, auditable `InvestigationRun`
- Structured `ToolCall`, `ToolResult`, `Evidence`, `Diagnosis`, and
  `ProposedAction`
- Server-owned run states and page refresh recovery
- Android 7.3.0 deterministic investigation fixture
- OpenAI-compatible provider configuration, including DeepSeek and Kimi

### Phase 1.5 — Approval and action hardening

- Persistent Approval linked to a specific run and proposed action
- Server-side approval validation and frozen action arguments
- GitHub Issue action represented by a runtime ToolCall
- Replay protection and audit events
- Reject/closed-no-action semantics
- Transition to `WAITING_VERIFICATION` after successful action execution

### Phase 2 — Risk detection and analytics tools

- Metric buckets and deterministic Android 7.3.0 analytics fixture
- Dynamic baseline, minimum sample size, and consecutive-window detection
- Persistent `RiskEvent` linked to Release and InvestigationRun
- Formal `get_release`, `query_metric`, and `segment_metric` tool contracts
- RiskEvent-driven investigation launch

### Phase 3 — Agent loop, chat, and hybrid RAG

- Shared Planner Contract for `LLMPlanner` and
  `DeterministicInvestigationPlanner`
- Persistent AgentLoop, hypotheses, evidence links, confidence computation, and
  revisions
- Continue Investigation from `WAITING_APPROVAL`
- Human-Agent Chat integrated with the same runtime
- Real feedback and incident-document retrieval
- Chunking, metadata, embeddings, vector search, and hybrid retrieval
- Local/CI retrieval fallback
- RAG evaluation and Agent Runtime regression tests
- v17 production-bundle guard for deterministic planner construction

## Known limitations

- The bundled Android 7.3.0 dataset is deterministic fixture data, not a live
  production analytics connection.
- The current implementation does not include Astronomy Shop, Slack, Jira,
  MCP, multi-agent execution, or a general-purpose external data ingestion
  pipeline.
- A successful approved action enters `WAITING_VERIFICATION`; automated
  post-fix re-verification is not yet implemented.
- Hosted vector retrieval requires both Workers AI and Vectorize bindings.
  Without them, the product intentionally uses the local fallback.
- Local fallback vectors are designed for deterministic development and CI, not
  production-quality semantic ranking.
- GitHub Issue creation requires a user-provided repository and credential and
  performs a real external write only after server-side approval validation.
- The UI is an incremental product demonstration rather than a fully
  multi-tenant administration console.

## Sensitive-data statement

This migration package includes `.env.example` only. It does not include
`.env`, API keys, GitHub tokens, hosted environment values, dependency
directories, build outputs, local databases, Wrangler state, or runtime caches.

