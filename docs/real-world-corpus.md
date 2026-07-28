# Real-world public incident corpus

ReleaseGuard supports three distinct corpus identities:

- `FIXTURE`: deterministic ReleaseGuard scenarios used by CI, regression tests, and evals.
- `REAL_PUBLIC`: historical incidents publicly published by engineering organizations.
- `LIVE_ENTERPRISE`: reserved for future private enterprise data; it is not implemented.

Real-world Data Upgrade A implements only `REAL_PUBLIC`. It does not connect ReleaseGuard to a customer's production systems, analytics, feedback, or internal incident history.

## Source and provenance

The only source adapter is `POSTMORTEMS_APP`. It reads the source's per-record JSON endpoint for an explicit allowlist of record UUIDs. The committed smoke file contains a minimal frozen provider snapshot, not a hand-authored normalized incident. Every snapshot records its provider, record ID, exact provider endpoint, retrieval time, canonical source-payload hash, snapshot version, and nullable HTTP validators. It retains only structured fields required by ingestion tests and excludes `Description`, article HTML, and full postmortem text.

Normalization is deterministic: it trims source strings, maps empty/sentinel values to null, normalizes dates, canonicalizes URLs, and stably sorts set-like arrays. It does not fill missing company/product/category values or use an LLM. `sourcePayloadHash` identifies the canonical frozen provider payload; `contentHash` identifies normalized semantic incident content and excludes retrieval/import timestamps.

The postmortems.app dataset is distributed under GPL-3.0. Rights in original linked articles remain `SOURCE_SPECIFIC` unless an article-level license is independently known. Dataset license and original-content rights are separate structured fields throughout snapshot normalization, manifest, D1 documents, chunk metadata, and retrieval provenance. The dataset license never propagates to the original article.

Fields missing from the structured source remain `null` or empty. The importer does not use an LLM to infer facts. In particular, the Upgrade A smoke records do not fabricate cause, impact, detection, mitigation, resolution, or lesson fields when the source has not separately structured them.

## Import

Offline deterministic dry-run:

```bash
npm run corpus:import:public -- --dry-run
```

Isolated smoke import using deterministic fallback embeddings:

```bash
npm run corpus:import:public
```

This writes an ignored local cache, not D1. `--live` fetches the same six allowlisted UUIDs from postmortems.app but still uses isolated local persistence and fallback embeddings. Node CLI `--d1` is rejected with a structured report because it is not a hosted Workers runtime.

The hosted path is the Worker's non-HTTP `scheduled` handler and is disabled unless `PUBLIC_CORPUS_IMPORT_ENABLED=true`. It validates that D1 `DB`, Workers AI `AI`, and Vectorize `VECTORIZE` are all present, then reuses the same importer with BGE-M3 and deterministic vector IDs. No public admin endpoint or arbitrary URL input is exposed. Triggering or configuring the scheduled handler against hosted resources requires explicit authorization.

The pipeline is `fetch snapshot -> validate/hash -> normalize -> identity assessment -> import attempt -> embed -> D1 document/chunks -> INDEX_PENDING -> Vectorize -> COMPLETED -> report`. D1 and Vectorize are not treated as one transaction. Persistent attempts use `PREPARING`, `INDEX_PENDING`, `INDEXING`, `COMPLETED`, `INDEX_FAILED`, and `FAILED` so partial imports are observable and retryable. Deterministic document, chunk, and vector IDs make retry safe. A report is emitted even when import work fails.

Identity dedupe uses `(sourceProvider, sourceRecordId)` first, canonical source/original URLs second, and normalized content hash third. Re-running a completed batch returns `UNCHANGED`. The same identity and URL anchors with a new content hash produces an audited `UPDATE_AVAILABLE`; changed identity anchors produce `IDENTITY_CONFLICT`. Neither state overwrites the active document. Revision records retain previous/new content hash, source-payload hash, ingestion versions, URLs, and detection time for later controlled updates.

## Sources of truth

- Frozen source snapshot: development/test evidence of the exact minimal provider payload.
- Manifest: versioned curated-corpus declaration and expected source identity/hash.
- D1: runtime canonical documents, chunks, import attempts, and revision history.
- Vectorize: derived retrieval index. It is never authoritative and may be safely rebuilt.

## Retrieval isolation

Both corpus types use the existing incident document, chunk, term, embedding, Vectorize, and hybrid ranking path. Search supports:

- `FIXTURE_ONLY` (the local/CI default)
- `REAL_PUBLIC_ONLY`
- `ALL` (the hosted retrieval runtime default)

The deterministic Phase 3 RAG eval and Phase 4 benchmarks continue to construct the fixture-only in-memory retriever, so public corpus changes cannot alter their ground truth. `REAL_PUBLIC` describes the corpus, while `FALLBACK` or `HYBRID_VECTORIZE` describes the retrieval backend; those labels are independent.

Public matches remain `SIMILAR_INCIDENT` historical memory with low evidence weight. They can suggest a hypothesis but cannot independently confirm the root cause of a current incident. Every REAL_PUBLIC match returns provider/record identity, company/date, canonical and original URLs, dataset license, original rights, retrieval time, source/content hashes, snapshot version, and ingestion version. Evidence is labeled per item; mixed fixture/public history is labeled `MIXED`, never globally upgraded to REAL PUBLIC.

## Smoke selection

The Upgrade A manifest contains six incidents from GitHub, Cloudflare, Slack, GitLab, Honeycomb, and incident.io. The sample spans configuration propagation, cascading cache/database load, operator/data-loss failure, product-wide outage, telemetry/security-policy interaction, and asynchronous worker panic. Upgrade B may curate a larger corpus after source quality, licensing, and retrieval behavior are reviewed.
