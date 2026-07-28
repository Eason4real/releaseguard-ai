import assert from "node:assert/strict";
import corpusManifestJson from "../data/public-incidents/corpus-v1-manifest.json";
import curatedSourceJson from "../data/public-incidents/curated-source-v1.json";
import frozenResult from "./results/real-public-retrieval-v1.json";
import { DeterministicEmbeddingProvider } from "../lib/retrieval/embedding";
import { canonicalJson, hashSourcePayload, normalizePostmortemsAppRecord, sha256 } from "../lib/retrieval/public-incidents/normalize";
import { preparePublicIncident } from "../lib/retrieval/public-incidents/pipeline";
import { PUBLIC_INCIDENT_MECHANISMS, REAL_PUBLIC_CORPUS_VERSION, type PreparedPublicIncident, type PublicIncidentMechanism, type PublicIncidentSnapshotFile } from "../lib/retrieval/public-incidents/types";
import { cosineSimilarity, termFrequency, tokenize } from "../lib/retrieval/tokenizer";
import { realPublicRetrievalCases, type RealPublicRetrievalCase } from "./fixtures/real-public-retrieval-cases";

type ManifestRecord = { sourceId: string; sourceRecordId: string; revision: number; company: string; mechanisms: PublicIncidentMechanism[]; contentHash: string; sourcePayloadHash: string; originalSourceUrl: string };
type CorpusManifest = { schemaVersion: string; corpusVersion: string; createdAt: string; incidentCount: number; companies: string[]; mechanisms: PublicIncidentMechanism[]; categories: string[]; ingestionVersion: string; snapshotVersion: string; manifestHash: string; records: ManifestRecord[]; rejectedCandidates: Array<{ sourceId: string; reason: string }> };
type RetrievalMode = "BM25" | "VECTOR" | "HYBRID_RRF";
type Ranked = { incidentId: string; score: number; rank: number };
type MetricSet = { recallAt1: number; recallAt3: number; recallAt5: number; mrr: number };

const manifest = corpusManifestJson as CorpusManifest;
const snapshotFile = curatedSourceJson as unknown as PublicIncidentSnapshotFile;
const round = (value: number) => Number(value.toFixed(4));
export async function loadPreparedRealPublicCorpus() {
  const mechanisms = new Map(manifest.records.map((record) => [record.sourceId, record.mechanisms]));
  return Promise.all(snapshotFile.records.map(async (snapshot) => preparePublicIncident(
    await normalizePostmortemsAppRecord(snapshot, mechanisms.get(snapshot.sourceRecordId) ?? []),
    new DeterministicEmbeddingProvider(),
  )));
}

export async function validateRealPublicCorpus() {
  assert.equal(manifest.corpusVersion, REAL_PUBLIC_CORPUS_VERSION);
  assert.ok(manifest.incidentCount >= 30 && manifest.incidentCount <= 50);
  assert.equal(manifest.incidentCount, snapshotFile.records.length);
  assert.equal(manifest.records.length, snapshotFile.records.length);
  assert.ok(manifest.companies.length >= 12);
  assert.deepEqual([...manifest.mechanisms].sort(), [...PUBLIC_INCIDENT_MECHANISMS].sort());
  assert.ok(manifest.rejectedCandidates.length > 0);
  const manifestBase = { ...manifest } as Omit<CorpusManifest, "manifestHash"> & { manifestHash?: string };
  delete manifestBase.manifestHash;
  assert.equal(manifest.manifestHash, await sha256(canonicalJson(manifestBase)));
  const ids = new Set<string>();
  const urls = new Set<string>();
  const contentHashes = new Set<string>();
  for (const snapshot of snapshotFile.records) {
    assert.equal(snapshot.payload.Description, undefined);
    assert.equal(snapshot.sourcePayloadHash, await hashSourcePayload(snapshot.payload));
    assert.ok(!ids.has(snapshot.sourceRecordId));
    ids.add(snapshot.sourceRecordId);
    const record = manifest.records.find((item) => item.sourceId === snapshot.sourceRecordId);
    assert.ok(record);
    assert.equal(record.sourceRecordId, snapshot.sourceRecordId);
    assert.equal(record.revision, 1);
    const incident = await normalizePostmortemsAppRecord(snapshot, record.mechanisms);
    assert.equal(record.sourcePayloadHash, incident.sourcePayloadHash);
    assert.equal(record.contentHash, incident.contentHash);
    assert.ok(incident.sourceUrl && incident.originalSourceUrl && incident.datasetLicense.url);
    assert.ok(!urls.has(incident.originalSourceUrl));
    assert.ok(!contentHashes.has(incident.contentHash));
    urls.add(incident.originalSourceUrl);
    contentHashes.add(incident.contentHash);
  }
  return { incidentCount: manifest.incidentCount, companyCount: manifest.companies.length,
    mechanismCount: manifest.mechanisms.length, manifestHash: manifest.manifestHash,
    provenanceCompleteness: 1, duplicateCount: 0 };
}

const bm25Scores = (items: PreparedPublicIncident[], query: string) => {
  const rows = items.map((item) => ({ incidentId: item.incident.id, text: item.chunks.map((chunk) => chunk.searchText).join(" ") }));
  const terms = [...new Set(tokenize(query))];
  const lengths = rows.map((row) => tokenize(row.text).length);
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(rows.length, 1);
  return rows.map((row, index) => {
    const frequencies = termFrequency(row.text);
    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const df = rows.filter((candidate) => termFrequency(candidate.text).has(term)).length;
      const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
      score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * lengths[index] / Math.max(averageLength, 1))));
    }
    return { incidentId: row.incidentId, score };
  });
};

async function rank(items: PreparedPublicIncident[], query: string, mode: RetrievalMode): Promise<Ranked[]> {
  const lexical = bm25Scores(items, query).sort((left, right) => right.score - left.score || left.incidentId.localeCompare(right.incidentId));
  const embedding = new DeterministicEmbeddingProvider();
  const [queryVector, ...vectors] = await embedding.embed([query, ...items.map((item) => item.chunks.map((chunk) => chunk.searchText).join(" "))]);
  const vector = items.map((item, index) => ({ incidentId: item.incident.id, score: cosineSimilarity(queryVector, vectors[index]) }))
    .sort((left, right) => right.score - left.score || left.incidentId.localeCompare(right.incidentId));
  const selected = mode === "BM25" ? lexical : mode === "VECTOR" ? vector : items.map((item) => {
    const lexicalRank = lexical.findIndex((row) => row.incidentId === item.incident.id) + 1;
    const vectorRank = vector.findIndex((row) => row.incidentId === item.incident.id) + 1;
    return { incidentId: item.incident.id, score: 0.45 / (60 + lexicalRank) + 0.55 / (60 + vectorRank) };
  }).sort((left, right) => right.score - left.score || left.incidentId.localeCompare(right.incidentId));
  return selected.map((item, index) => ({ ...item, rank: index + 1 }));
}

const metrics = (cases: RealPublicRetrievalCase[], rankings: Map<string, Ranked[]>): MetricSet => {
  const reciprocalRanks = cases.map((item) => {
    const ranking = rankings.get(item.id) ?? [];
    const rank = ranking.findIndex((row) => item.relevantIncidentIds.includes(row.incidentId));
    return rank < 0 ? 0 : 1 / (rank + 1);
  });
  const recall = (k: number) => cases.filter((item) => (rankings.get(item.id) ?? []).slice(0, k)
    .some((row) => item.relevantIncidentIds.includes(row.incidentId))).length / cases.length;
  return { recallAt1: round(recall(1)), recallAt3: round(recall(3)), recallAt5: round(recall(5)),
    mrr: round(reciprocalRanks.reduce((sum, value) => sum + value, 0) / cases.length) };
};

export async function runRealPublicRetrievalEval() {
  const corpus = await loadPreparedRealPublicCorpus();
  const validation = await validateRealPublicCorpus();
  const rankings = new Map<RetrievalMode, Map<string, Ranked[]>>();
  for (const mode of ["BM25", "VECTOR", "HYBRID_RRF"] as const) {
    const byCase = new Map<string, Ranked[]>();
    for (const item of realPublicRetrievalCases) byCase.set(item.id, await rank(corpus, item.query, mode));
    rankings.set(mode, byCase);
  }
  const results = Object.fromEntries([...rankings].map(([mode, values]) => [mode, metrics(realPublicRetrievalCases, values)])) as Record<RetrievalMode, MetricSet>;
  const hybrid = rankings.get("HYBRID_RRF")!;
  const crossCompanyCases = realPublicRetrievalCases.filter((item) => item.crossCompanyAllowed);
  const crossCompanyRecallAt3 = round(crossCompanyCases.filter((item) => hybrid.get(item.id)!.slice(0, 3)
    .some((row) => item.relevantIncidentIds.includes(row.incidentId))).length / crossCompanyCases.length);
  const mechanismById = new Map(manifest.records.map((record) => [`RP-POSTMORTEMS_APP-${record.sourceId}`, record.mechanisms]));
  const mechanismRecallAt3 = round(realPublicRetrievalCases.filter((item) => hybrid.get(item.id)!.slice(0, 3)
    .some((row) => mechanismById.get(row.incidentId)?.includes(item.mechanism))).length / realPublicRetrievalCases.length);
  const trapCases = realPublicRetrievalCases.filter((item) => item.forbiddenIncidentIds.length > 0);
  const falseSimilar = trapCases.filter((item) => {
    const top = hybrid.get(item.id)!;
    const relevantRank = top.findIndex((row) => item.relevantIncidentIds.includes(row.incidentId));
    const forbiddenRank = top.findIndex((row) => item.forbiddenIncidentIds.includes(row.incidentId));
    return forbiddenRank >= 0 && (relevantRank < 0 || forbiddenRank < relevantRank);
  });
  const evalOnlyTokens = realPublicRetrievalCases.flatMap((item) => [item.id, item.difficulty, item.notes, item.query]);
  const indexedPayload = corpus.flatMap((item) => item.chunks.map((chunk) => `${chunk.content}\n${chunk.searchText}\n${chunk.metadataJson}`)).join("\n");
  const leakageCount = evalOnlyTokens.filter((value) => indexedPayload.includes(value)).length;
  const failures = realPublicRetrievalCases.flatMap((item) => {
    const top = hybrid.get(item.id)!;
    const relevantRank = top.findIndex((row) => item.relevantIncidentIds.includes(row.incidentId));
    if (relevantRank >= 0 && relevantRank < 5 && !falseSimilar.includes(item)) return [];
    const actual = top.slice(0, 5).map((row) => ({ incidentId: row.incidentId, rank: row.rank, score: round(row.score) }));
    const failureType = falseSimilar.includes(item) ? "FALSE_SIMILARITY"
      : relevantRank < 0 ? "CORPUS_COVERAGE_GAP"
        : bm25Scores(corpus, item.query).every((row) => row.score === 0) ? "LEXICAL_MISMATCH" : "SEMANTIC_MISMATCH";
    return [{ caseId: item.id, query: item.query, expected: item.relevantIncidentIds, actual, failureType }];
  });
  return { corpusVersion: manifest.corpusVersion, manifestHash: manifest.manifestHash,
    queryCount: realPublicRetrievalCases.length, validation, results,
    provenanceCompleteness: validation.provenanceCompleteness, corpusLeakage: leakageCount,
    falseSimilarityRate: round(falseSimilar.length / Math.max(trapCases.length, 1)),
    mechanismRecallAt3, crossCompanyRecallAt3, failureAnalysis: failures };
}

if (process.argv[1]?.endsWith("real-public-rag-eval.mjs")) {
  const report = await runRealPublicRetrievalEval();
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.corpusLeakage, 0);
  assert.equal(report.provenanceCompleteness, 1);
  assert.deepEqual(report.results, frozenResult.results);
  assert.deepEqual(report.failureAnalysis.map((item) => item.caseId), frozenResult.failureCaseIds);
}
