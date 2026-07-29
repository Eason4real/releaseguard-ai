import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import corpusManifest from "../data/public-incidents/corpus-v1-manifest.json";
import curatedSource from "../data/public-incidents/curated-source-v1.json";
import frozenResult from "../eval/results/real-public-retrieval-v1.json";
import { realPublicRetrievalCases } from "../eval/fixtures/real-public-retrieval-cases";
import { loadPreparedRealPublicCorpus, runRealPublicRetrievalEval, validateRealPublicCorpus } from "../eval/real-public-rag-eval";
import { sha256 } from "../lib/retrieval/public-incidents/normalize";
import { PUBLIC_INCIDENT_MECHANISMS } from "../lib/retrieval/public-incidents/types";

test("REAL_PUBLIC corpus v1 is frozen, diverse, duplicate-free, and provenance-complete", async () => {
  const report = await validateRealPublicCorpus();
  assert.equal(report.incidentCount, 42);
  assert.equal(report.companyCount, 26);
  assert.equal(report.mechanismCount, PUBLIC_INCIDENT_MECHANISMS.length);
  assert.equal(report.provenanceCompleteness, 1);
  assert.equal(report.duplicateCount, 0);
  assert.match(report.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(corpusManifest.records.length, curatedSource.records.length);
  assert.ok(corpusManifest.rejectedCandidates.every((item) => item.reason.length > 0));
});

test("real retrieval eval is offline, isolated from indexed content, and reproducible", async () => {
  const first = await runRealPublicRetrievalEval();
  const second = await runRealPublicRetrievalEval();
  assert.deepEqual(first, second);
  assert.equal(first.queryCount, 27);
  assert.equal(first.corpusLeakage, 0);
  assert.equal(first.provenanceCompleteness, 1);
  assert.equal(first.falseSimilarityRate, 0);
  assert.ok(first.crossCompanyRecallAt3 >= 0.8);
  assert.ok(first.mechanismRecallAt3 >= 0.9);
  assert.equal(first.results.BM25.recallAt3, 1);
  assert.ok(first.results.BM25.mrr > first.results.HYBRID_RRF.mrr);
  assert.ok(first.results.HYBRID_RRF.recallAt5 >= first.results.HYBRID_RRF.recallAt3);
  assert.ok(first.failureAnalysis.length > 0);
  assert.deepEqual(first.results, frozenResult.results);
  assert.deepEqual(first.failureAnalysis.map((item) => item.caseId), frozenResult.failureCaseIds);
});

test("corpus version and curation metadata survive retrieval preparation", async () => {
  const prepared = await loadPreparedRealPublicCorpus();
  assert.ok(prepared.every((item) => item.document.corpusVersion === corpusManifest.corpusVersion));
  assert.ok(prepared.every((item) => item.incident.mechanisms.length > 0));
  assert.ok(prepared.every((item) => item.chunks.every((chunk) =>
    !realPublicRetrievalCases.some((evalCase) => chunk.content.includes(evalCase.id)
      || chunk.searchText.includes(evalCase.query)
      || chunk.metadataJson.includes(evalCase.notes)))));
});

test("REAL_PUBLIC historical memory UI exposes provenance without presenting current-event fact", async () => {
  const source = await readFile("app/private-live-workspace.tsx", "utf8");
  assert.match(source, /REAL PUBLIC HISTORICAL MEMORY/);
  assert.match(source, /Historical clue only/);
  assert.match(source, /originalSourceUrl/);
  assert.match(source, /corpusVersion/);
  assert.match(source, /Mechanism \/ category/);
});

test("Upgrade B leaves fixture RAG eval and Phase 4 scenario ground truth unchanged", async () => {
  assert.equal(await sha256(await readFile("eval/rag-eval.ts", "utf8")),
    "9b7452ff0221edaf8a3eda6d5c9fbf9e26952d37f8018485eb9f4168d15b83a1");
  assert.equal(await sha256(await readFile("eval/fixtures/phase4-scenarios.ts", "utf8")),
    "83a9ead598814ab302592848c2be10d7ba4726176d6cabfdc813ffc193289e67");
});
