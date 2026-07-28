# Real Public Corpus v1

ReleaseGuard AI's first curated public historical incident corpus contains 42 authentic incident records from 26 companies. It is frozen as `real-public-postmortems-app-v1` with manifest hash `cddd2fedebb585f94427d6ffcb25da930a001ceead882151d22c0d2a3f6c1bf7`.

## Corpus

The source dataset is [POSTMORTEMS_APP](https://postmortems.app), selected from its structured public catalog. The corpus stores minimal provider snapshots: title, company, dates, source URL, source categories and keywords, product, and source summary. It does not copy full postmortem articles.

Selection required a clear failure mechanism, identifiable impact, useful cause or mitigation information, complete provenance, and relevance to release or product-risk investigation. Eight reviewed records were rejected because they lacked a title and usable technical summary; rejection reasons are retained in the selection manifest rather than silently skipped.

Coverage includes all 12 target mechanisms:

- deployment or release regression
- configuration propagation
- database overload or saturation
- cache failure
- queue or worker failure
- dependency or third-party outage
- network or DNS
- capacity exhaustion
- data corruption or loss
- authentication or permission
- cascading failure
- observability or monitoring failure

The dataset metadata is GPL-3.0 under the POSTMORTEMS_APP repository license. Each original postmortem remains under its source-specific rights; the manifest and runtime provenance preserve the original URL and do not claim those articles are GPL-licensed.

## Retrieval Benchmark

The independent benchmark has 27 hand-written investigation queries. It covers direct same-company lookup, cross-company mechanism matching, similar symptoms with different mechanisms, historical traps, and sparse queries. Expected incident IDs, difficulty labels, notes, and forbidden false-similarity candidates exist only under `eval/`; they are not included in document text, chunk text, embedding metadata, or query rewriting.

The frozen offline result uses the project's deterministic token-hash embedding fallback:

| Retriever | Recall@1 | Recall@3 | Recall@5 | MRR |
| --- | ---: | ---: | ---: | ---: |
| BM25 | 0.9630 | 1.0000 | 1.0000 | 0.9753 |
| Vector | 0.5185 | 0.7778 | 0.8148 | 0.6630 |
| Hybrid / RRF | 0.7407 | 0.8889 | 0.9259 | 0.8262 |

Additional results:

- provenance completeness: 100%
- corpus leakage: 0
- false similarity rate: 0%
- mechanism Recall@3: 0.9259
- cross-company Recall@3: 0.8571

BM25 is stronger than Hybrid on this small, terminology-rich frozen corpus. The product decision recommendation is therefore BM25 Top-3 for this corpus when running the deterministic local fallback. This is not a recommendation to replace hosted BGE-M3 and Vectorize without a separate hosted comparison.

## Failure Analysis

Hybrid misses two expected incidents in Top-5:

- `REAL-20`: a monitoring-alarm failure expressed through a power-grid analogy is a semantic mismatch for the deterministic embedding.
- `REAL-21`: a database replication inconsistency is displaced by more lexically and semantically common database incidents.

These failures show that the fallback vector is useful for reproducibility, not production-quality semantic equivalence. The corpus is intentionally small, English-only, public-reference data, and not representative of a private company's architecture or incident distribution.

## Reproducibility

`npm run corpus:validate:real` validates count, diversity, stable hashes, deduplication, and provenance. `npm run eval:rag:real` runs the frozen BM25, Vector, and Hybrid comparison without network access. `npm run corpus:refresh:real -- --confirm-live-refresh` is the only live refresh path and is never called by tests or eval.
