import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DeterministicEmbeddingProvider } from "../lib/retrieval/embedding";
import { InMemoryIncidentRetriever } from "../lib/retrieval/local-retrievers";
import { PostmortemsAppSource } from "../lib/retrieval/public-incidents/postmortems-app";
import { MemoryPublicIncidentStore, importPublicIncidentCorpus } from "../lib/retrieval/public-incidents/pipeline";
import type {
  PublicIncidentMechanism,
  PublicIncidentImportReport,
  PublicIncidentSnapshotFile,
  PublicIncidentSource,
} from "../lib/retrieval/public-incidents/types";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const useLiveSource = args.has("--live");
const projectRoot = process.cwd();

const fatalReport = (code: string, message: string): PublicIncidentImportReport => ({
  fetched: 0, accepted: 0, rejected: 0, unchanged: 0, updateAvailable: 0,
  identityConflict: 0, duplicate: 0, persisted: 0, indexed: 0, completed: 0,
  partial: 0, failed: 1, documents: 0, chunks: 0, dryRun,
  failures: [{ sourceRecordId: null, stage: "SNAPSHOT", reasonCode: code, message }],
  rejections: [], duplicateDetails: [], updates: [],
});

let report: PublicIncidentImportReport;
let retrievalSmoke: null | Record<string, unknown> = null;
let idempotencySmoke: null | Pick<PublicIncidentImportReport, "unchanged" | "completed" | "failed"> = null;
let sourceMode = useLiveSource ? "LIVE_PUBLIC_HTTP" : "FROZEN_SOURCE_SNAPSHOT";
let persistenceMode = dryRun ? "NONE" : "ISOLATED_IGNORED_CACHE";
try {
  if (args.has("--d1")) {
    throw new Error("HOSTED_IMPORT_REQUIRES_WORKER_RUNTIME");
  }
  const sourcePath = resolve(projectRoot, "data/public-incidents/curated-source-v1.json");
  const manifestPath = resolve(projectRoot, "data/public-incidents/corpus-v1-manifest.json");
  const snapshotFile = JSON.parse(await readFile(sourcePath, "utf8")) as PublicIncidentSnapshotFile;
  const corpusManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    records: Array<{ sourceId: string; mechanisms: PublicIncidentMechanism[] }>;
  };
  const curationMechanisms = Object.fromEntries(corpusManifest.records.map((record) =>
    [record.sourceId, record.mechanisms]));
  const ids = snapshotFile.records.map((record) => record.sourceRecordId);
  const frozenSource: PublicIncidentSource = {
    provider: "POSTMORTEMS_APP",
    parse(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MALFORMED_SOURCE_RECORD");
      return input;
    },
    async fetchRecords(sourceRecordIds) {
      const requested = new Set(sourceRecordIds);
      return snapshotFile.records.filter((record) => requested.has(record.sourceRecordId));
    },
  };
  const source = useLiveSource ? new PostmortemsAppSource() : frozenSource;
  const store = new MemoryPublicIncidentStore();
  report = await importPublicIncidentCorpus({
    source,
    sourceRecordIds: ids,
    store,
    embeddingProvider: new DeterministicEmbeddingProvider(),
    vectorBackend: "LOCAL",
    curationMechanisms,
    dryRun,
  });

  if (!dryRun && report.completed > 0) {
    const cacheDirectory = resolve(projectRoot, "data/public-incidents/cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(resolve(cacheDirectory, "curated-v1-index.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      retrievalBackend: "FALLBACK",
      corpusType: "REAL_PUBLIC",
      documents: [...store.items.values()],
      attempts: [...store.attempts.values()],
    }, null, 2));
    const [match] = await new InMemoryIncidentRetriever([...store.items.values()]).search({
      query: "poison message unhandled panic worker crash",
      corpusScope: "REAL_PUBLIC_ONLY",
      limit: 1,
    });
    retrievalSmoke = match ? {
      incidentId: match.incidentId,
      title: match.title,
      corpusType: match.provenance.corpusType,
      company: match.provenance.company,
      sourceRecordId: match.provenance.sourceRecordId,
      originalSourceUrl: match.provenance.originalSourceUrl,
      retrievalBackend: match.retrievalSignals.retrievalMode,
    } : null;
    const retry = await importPublicIncidentCorpus({
      source,
      sourceRecordIds: ids,
      store,
      embeddingProvider: new DeterministicEmbeddingProvider(),
      vectorBackend: "LOCAL",
      curationMechanisms,
    });
    idempotencySmoke = {
      unchanged: retry.unchanged,
      completed: retry.completed,
      failed: retry.failed,
    };
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "UNKNOWN_FATAL_ERROR";
  report = fatalReport(message, message);
  if (message === "HOSTED_IMPORT_REQUIRES_WORKER_RUNTIME") {
    sourceMode = "INVALID_NODE_HOSTED_MODE";
    persistenceMode = "NONE";
  }
}

console.log(JSON.stringify({
  source: "POSTMORTEMS_APP",
  sourceMode,
  persistence: persistenceMode,
  retrievalBackend: "FALLBACK",
  retrievalSmoke,
  idempotencySmoke,
  ...report,
}, null, 2));
if (report.failed > 0 || report.partial > 0) process.exitCode = 1;
