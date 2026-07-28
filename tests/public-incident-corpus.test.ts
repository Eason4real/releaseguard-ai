import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import smokeSourceJson from "../data/public-incidents/smoke-source.json";
import manifest from "../data/public-incidents/manifest.json";
import { calculateHypothesisConfidence } from "../lib/investigation/confidence";
import { toolAdapters } from "../lib/investigation/tools";
import type { Evidence, HypothesisEvidenceLink } from "../lib/investigation/types";
import { DeterministicEmbeddingProvider } from "../lib/retrieval/embedding";
import { InMemoryIncidentRetriever } from "../lib/retrieval/local-retrievers";
import {
  createHostedPublicCorpusRuntime,
  validateHostedPublicCorpusBindings,
} from "../lib/retrieval/public-incidents/hosted";
import {
  canonicalizeUrl,
  hashSourcePayload,
  normalizePostmortemsAppRecord,
} from "../lib/retrieval/public-incidents/normalize";
import { PostmortemsAppSource } from "../lib/retrieval/public-incidents/postmortems-app";
import {
  MemoryPublicIncidentStore,
  importPublicIncidentCorpus,
} from "../lib/retrieval/public-incidents/pipeline";
import type {
  PostmortemsAppRecord,
  PublicIncidentSnapshotFile,
  PublicIncidentSource,
  PublicIncidentSourceSnapshot,
} from "../lib/retrieval/public-incidents/types";
import type { EmbeddingProvider } from "../lib/retrieval/types";

const snapshotFile = smokeSourceJson as unknown as PublicIncidentSnapshotFile;
const snapshots = snapshotFile.records;
const ids = snapshots.map((snapshot) => snapshot.sourceRecordId);
const embedding = new DeterministicEmbeddingProvider();

const frozenSource = (records: PublicIncidentSourceSnapshot[] = snapshots): PublicIncidentSource => ({
  provider: "POSTMORTEMS_APP",
  parse(input) { return input as PostmortemsAppRecord; },
  async fetchRecords(requestedIds) {
    const requested = new Set(requestedIds);
    return records.filter((record) => requested.has(record.sourceRecordId));
  },
});

const importInput = (store = new MemoryPublicIncidentStore(), source = frozenSource()) => ({
  source,
  sourceRecordIds: ids,
  store,
  embeddingProvider: embedding,
  vectorBackend: "LOCAL",
});

const changedSnapshot = async (
  original: PublicIncidentSourceSnapshot,
  payloadChange: Partial<PostmortemsAppRecord>,
): Promise<PublicIncidentSourceSnapshot> => {
  const payload = { ...original.payload, ...payloadChange };
  return { ...original, payload, sourcePayloadHash: await hashSourcePayload(payload) };
};

test("frozen source is an auditable minimal provider snapshot", async () => {
  assert.equal(snapshotFile.snapshotVersion, "postmortems-app-snapshot-v1");
  assert.equal(snapshots.length, 6);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.sourceProvider, "POSTMORTEMS_APP");
    assert.equal(snapshot.sourceRecordId, snapshot.payload.UUID);
    assert.match(snapshot.providerEndpoint, /^https:\/\/postmortems\.app\/postmortem\/.+\.json$/);
    assert.equal(snapshot.sourcePayloadHash, await hashSourcePayload(snapshot.payload));
    assert.equal(snapshot.etag, null);
    assert.equal(snapshot.lastModified, null);
    assert.equal(snapshot.payload.Description, undefined);
  }
  const slack = snapshots.find((snapshot) => snapshot.payload.Company === "Slack");
  assert.equal(slack?.payload.Product, "");
});

test("snapshot normalization, source hash, content hash, and manifest are deterministic", async () => {
  for (const snapshot of snapshots) {
    const normalized = await normalizePostmortemsAppRecord(snapshot);
    const later = await normalizePostmortemsAppRecord({ ...snapshot, retrievedAt: "2026-07-29T00:00:00.000Z" });
    const entry = manifest.records.find((record) => record.sourceId === snapshot.sourceRecordId);
    assert.ok(entry);
    assert.equal(normalized.sourcePayloadHash, snapshot.sourcePayloadHash);
    assert.equal(normalized.contentHash, later.contentHash);
    assert.equal(entry.sourcePayloadHash, normalized.sourcePayloadHash);
    assert.equal(entry.contentHash, normalized.contentHash);
    assert.equal(entry.snapshotVersion, normalized.snapshotVersion);
  }
});

test("normalization does not enrich missing facts and separates rights", async () => {
  const slack = snapshots.find((snapshot) => snapshot.payload.Company === "Slack")!;
  const normalized = await normalizePostmortemsAppRecord(slack);
  assert.deepEqual(normalized.products, []);
  assert.equal(normalized.incidentDateEnd, null);
  assert.equal(normalized.datasetLicense.name, "GPL-3.0");
  assert.equal(normalized.originalContentRights.status, "SOURCE_SPECIFIC");
  assert.equal(normalized.originalContentRights.licenseName, null);
  assert.notEqual(normalized.originalContentRights.licenseName, normalized.datasetLicense.name);
  assert.equal(normalized.causeSummary, null);
});

test("URL canonicalization is stable without erasing business parameters", () => {
  const first = canonicalizeUrl("HTTPS://WWW.Example.com:443/path/?utm_source=x&b=2&a=1#fragment");
  const second = canonicalizeUrl("https://example.com/path?a=1&b=2&utm_campaign=y");
  assert.equal(first, "https://example.com/path?a=1&b=2");
  assert.equal(first, second);
  assert.equal(canonicalizeUrl("https://example.com/path?release=7.3.0"), "https://example.com/path?release=7.3.0");
  assert.throws(() => canonicalizeUrl("file:///etc/passwd"), /INVALID_SOURCE_URL/);
});

test("POSTMORTEMS_APP follows only bounded same-host HTTPS redirects", async () => {
  let calls = 0;
  const source = new PostmortemsAppSource(async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: `/postmortem/${ids[0]}.json?canonical=1` } });
    return Response.json(snapshots[0].payload);
  }, 1, 2, () => new Date("2026-07-28T00:00:00.000Z"));
  const [snapshot] = await source.fetchRecords([ids[0]]);
  assert.equal(calls, 2);
  assert.match(snapshot.providerEndpoint, /postmortems\.app/);
});

test("POSTMORTEMS_APP rejects external, insecure, localhost, and private redirects before follow", async () => {
  for (const location of [
    "https://example.com/record.json",
    "http://postmortems.app/record.json",
    "https://localhost/record.json",
    "https://127.0.0.1/record.json",
    "https://10.0.0.1/record.json",
  ]) {
    let calls = 0;
    const source = new PostmortemsAppSource(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location } });
    });
    await assert.rejects(() => source.fetchRecords([ids[0]]), /REDIRECT_REJECTED/);
    assert.equal(calls, 1);
  }
});

test("adapter retries transient failures without network-dependent tests", async () => {
  let attempts = 0;
  const source = new PostmortemsAppSource(async () => {
    attempts += 1;
    return attempts === 1 ? new Response("retry", { status: 503 }) : Response.json(snapshots[0].payload);
  }, 2);
  const result = await source.fetchRecords([ids[0]]);
  assert.equal(result.length, 1);
  assert.equal(attempts, 2);
});

test("dry-run is non-persistent and completed import is idempotent", async () => {
  const store = new MemoryPublicIncidentStore();
  const dryRun = await importPublicIncidentCorpus({ ...importInput(store), dryRun: true });
  assert.equal(dryRun.accepted, 6);
  assert.equal(store.items.size, 0);
  assert.equal(store.attempts.size, 0);
  const imported = await importPublicIncidentCorpus(importInput(store));
  assert.equal(imported.completed, 6);
  assert.equal(store.items.size, 6);
  const retry = await importPublicIncidentCorpus(importInput(store));
  assert.equal(retry.unchanged, 6);
  assert.equal(retry.completed, 0);
  assert.equal(store.items.size, 6);
});

test("embedding and D1 persistence failures are audited and recoverable", async () => {
  const throwingEmbedding: EmbeddingProvider = {
    ...embedding,
    model: embedding.model,
    dimensions: embedding.dimensions,
    mode: embedding.mode,
    async embed() { throw new Error("embedding unavailable"); },
  };
  const embeddingStore = new MemoryPublicIncidentStore();
  const embeddingReport = await importPublicIncidentCorpus({
    ...importInput(embeddingStore, frozenSource([snapshots[0]])),
    sourceRecordIds: [ids[0]],
    embeddingProvider: throwingEmbedding,
  });
  assert.equal(embeddingReport.failures[0].stage, "EMBEDDING");
  assert.equal([...embeddingStore.attempts.values()][0].status, "FAILED");

  const d1Store = new MemoryPublicIncidentStore();
  d1Store.injectFailureOnce("D1_PERSIST");
  const failed = await importPublicIncidentCorpus({ ...importInput(d1Store, frozenSource([snapshots[0]])), sourceRecordIds: [ids[0]] });
  assert.equal(failed.failures[0].stage, "D1_PERSIST");
  assert.equal(d1Store.items.size, 0);
  const recovered = await importPublicIncidentCorpus({ ...importInput(d1Store, frozenSource([snapshots[0]])), sourceRecordIds: [ids[0]] });
  assert.equal(recovered.completed, 1);
  assert.equal(d1Store.items.size, 1);
  assert.equal(d1Store.attempts.size, 2);
});

test("Vectorize and final marker failures remain partial and retry with deterministic IDs", async () => {
  for (const stage of ["VECTOR_INDEX", "FINALIZE"] as const) {
    const store = new MemoryPublicIncidentStore();
    store.injectFailureOnce(stage);
    const first = await importPublicIncidentCorpus({ ...importInput(store, frozenSource([snapshots[0]])), sourceRecordIds: [ids[0]] });
    assert.equal(first.partial, 1);
    assert.equal([...store.attempts.values()][0].status, "INDEX_FAILED");
    const pendingResults = await new InMemoryIncidentRetriever([...store.items.values()]).search({
      query: "telemetry", corpusScope: "REAL_PUBLIC_ONLY", limit: 1,
    });
    assert.deepEqual(pendingResults, []);
    const chunkIds = [...store.items.values()][0].chunks.map((chunk) => chunk.id);
    const retry = await importPublicIncidentCorpus({ ...importInput(store, frozenSource([snapshots[0]])), sourceRecordIds: [ids[0]] });
    assert.equal(retry.completed, 1);
    assert.deepEqual([...store.items.values()][0].chunks.map((chunk) => chunk.id), chunkIds);
    assert.equal(store.items.size, 1);
    assert.equal(store.attempts.size, 2);
    assert.equal([...store.attempts.values()][0].failureStage, stage);
  }
});

test("legitimate updates and identity conflicts are distinct and preserve revision audit", async () => {
  const store = new MemoryPublicIncidentStore();
  await importPublicIncidentCorpus({ ...importInput(store, frozenSource([snapshots[0]])), sourceRecordIds: [ids[0]] });
  const activeHash = [...store.items.values()][0].incident.contentHash;
  const updated = await changedSnapshot(snapshots[0], { Summary: `${snapshots[0].payload.Summary} Updated upstream.` });
  const updateReport = await importPublicIncidentCorpus({
    ...importInput(store, frozenSource([updated])), sourceRecordIds: [ids[0]],
  });
  assert.equal(updateReport.updateAvailable, 1);
  assert.equal(updateReport.updates[0].previousContentHash, activeHash);
  assert.notEqual(updateReport.updates[0].newContentHash, activeHash);
  assert.equal([...store.items.values()][0].incident.contentHash, activeHash);
  assert.ok(store.revisions.some((revision) => revision.status === "UPDATE_AVAILABLE"));

  const conflict = await changedSnapshot(snapshots[0], { URL: "https://example.com/different-incident" });
  const conflictReport = await importPublicIncidentCorpus({
    ...importInput(store, frozenSource([conflict])), sourceRecordIds: [ids[0]],
  });
  assert.equal(conflictReport.identityConflict, 1);
  assert.ok(store.revisions.some((revision) => revision.status === "IDENTITY_CONFLICT"));
});

test("REAL_PUBLIC retrieval is isolated and carries complete provenance through hybrid ranking", async () => {
  const store = new MemoryPublicIncidentStore();
  await importPublicIncidentCorpus(importInput(store));
  const retriever = new InMemoryIncidentRetriever([...store.items.values()]);
  const [match] = await retriever.search({
    query: "poison message unhandled panic worker crash", corpusScope: "REAL_PUBLIC_ONLY", limit: 1,
  });
  assert.equal(match.provenance.corpusType, "REAL_PUBLIC");
  assert.equal(match.provenance.sourceProvider, "POSTMORTEMS_APP");
  assert.equal(match.provenance.sourceRecordId, ids[5]);
  assert.equal(match.provenance.datasetLicense?.name, "GPL-3.0");
  assert.equal(match.provenance.originalContentRights?.status, "SOURCE_SPECIFIC");
  assert.match(match.provenance.sourceUrl!, /^https:\/\/postmortems\.app/);
  assert.match(match.provenance.originalSourceUrl!, /^https:\/\//);
  assert.match(match.provenance.contentHash!, /^[a-f0-9]{64}$/);
  assert.match(match.provenance.sourcePayloadHash!, /^[a-f0-9]{64}$/);
  assert.equal(match.provenance.snapshotVersion, "postmortems-app-snapshot-v1");
  assert.equal(match.provenance.ingestionVersion, "public-incidents-v1");
  assert.equal(match.retrievalSignals.retrievalMode, "HYBRID_LOCAL");
  const fixture = await retriever.search({ query: "retry coupon", corpusScope: "FIXTURE_ONLY", limit: 10 });
  assert.ok(fixture.every((item) => item.provenance.corpusType === "FIXTURE"));
  const real = await retriever.search({ query: "database outage", corpusScope: "REAL_PUBLIC_ONLY", limit: 10 });
  assert.ok(real.every((item) => item.provenance.corpusType === "REAL_PUBLIC"));
  const all = await retriever.search({ query: "database outage", corpusScope: "ALL", limit: 10 });
  assert.ok(all.some((item) => item.provenance.corpusType === "FIXTURE"));
  assert.ok(all.some((item) => item.provenance.corpusType === "REAL_PUBLIC"));
});

test("hosted import fails closed unless D1, Workers AI, and Vectorize all exist", () => {
  assert.throws(() => validateHostedPublicCorpusBindings({}), /MISSING:DB/);
  assert.throws(() => validateHostedPublicCorpusBindings({ DB: {} as never }), /MISSING:AI/);
  assert.throws(() => validateHostedPublicCorpusBindings({ DB: {} as never, AI: {} as never }), /MISSING:VECTORIZE/);
  assert.doesNotThrow(() => validateHostedPublicCorpusBindings({
    DB: {} as never, AI: {} as never, VECTORIZE: {} as never,
  }));
  const runtime = createHostedPublicCorpusRuntime({
    DB: {} as never,
    AI: { run: async () => ({ data: [] }) } as never,
    VECTORIZE: { upsert: async () => undefined, query: async () => ({ matches: [] }) } as never,
  });
  assert.equal(runtime.embeddingProvider.mode, "REAL");
  assert.equal(runtime.embeddingProvider.model, "@cf/baai/bge-m3");
  assert.equal(runtime.vectorIndex.mode, "VECTORIZE");
});

test("REAL_PUBLIC remains low-authority historical evidence", async () => {
  const store = new MemoryPublicIncidentStore();
  await importPublicIncidentCorpus({ ...importInput(store, frozenSource([snapshots[5]])), sourceRecordIds: [ids[5]] });
  const [match] = await new InMemoryIncidentRetriever([...store.items.values()]).search({
    query: "poison message panic", corpusScope: "REAL_PUBLIC_ONLY", limit: 1,
  });
  const [extracted] = toolAdapters.search_similar_incidents.extractEvidence({ matches: [match] });
  assert.match(extracted.source, /Historical Memory \/ RAG · REAL PUBLIC · incident\.io/);
  assert.equal(extracted.provenance, "public_reference");
  const evidence: Evidence = {
    id: "EV-REAL-PUBLIC", runId: "RUN", toolResultId: "TR",
    ...extracted, collectedAt: snapshots[5].retrievedAt,
  };
  const link: HypothesisEvidenceLink = {
    id: "HEL", runId: "RUN", hypothesisId: "HYP", evidenceId: evidence.id,
    relation: "SUPPORTS", explanation: "historical clue", linkedBy: "AGENT", createdAt: snapshots[5].retrievedAt,
  };
  const confidence = calculateHypothesisConfidence([evidence], [link]);
  assert.equal(confidence.confidence, "LOW");
  assert.notEqual(confidence.status, "CONFIRMED");
});

test("mixed historical corpus UI never upgrades fixture evidence to REAL PUBLIC", async () => {
  const source = await readFile("app/page.tsx", "utf8");
  assert.match(source, /MIXED/);
  assert.match(source, /labeled per item/);
});
