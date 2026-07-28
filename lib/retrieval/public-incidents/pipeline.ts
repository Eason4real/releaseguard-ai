import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  incidentChunks,
  incidentChunkTerms,
  incidentDocuments,
  publicIncidentImportAttempts,
  publicIncidentRevisions,
} from "@/db/schema";
import { termFrequency, tokenize } from "../tokenizer";
import type { EmbeddingProvider, VectorIndex } from "../types";
import { normalizePostmortemsAppRecord, sha256 } from "./normalize";
import {
  PUBLIC_INCIDENT_INGESTION_VERSION,
  REAL_PUBLIC_CORPUS_VERSION,
  type ImportFailureStage,
  type PreparedPublicIncident,
  type PublicIncidentImportAttempt,
  type PublicIncidentImportReport,
  type PublicIncidentMechanism,
  type PublicIncidentRevision,
  type PublicIncidentSource,
  type RealPublicIncident,
  type SourceIdentityAssessment,
} from "./types";

const boundedMessage = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_FAILURE").slice(0, 500);

class ImportStageError extends Error {
  constructor(readonly stage: ImportFailureStage, readonly code: string, cause: unknown) {
    super(boundedMessage(cause));
  }
}

export interface PublicIncidentStore {
  inspect(incident: RealPublicIncident): Promise<SourceIdentityAssessment>;
  recordRevision(revision: PublicIncidentRevision): Promise<void>;
  beginAttempt(incident: RealPublicIncident, embeddingBackend: string, vectorBackend: string): Promise<PublicIncidentImportAttempt>;
  persistPrepared(attempt: PublicIncidentImportAttempt, item: PreparedPublicIncident): Promise<void>;
  indexPrepared(attempt: PublicIncidentImportAttempt, item: PreparedPublicIncident): Promise<void>;
  failAttempt(attempt: PublicIncidentImportAttempt, stage: ImportFailureStage, code: string, message: string): Promise<void>;
}

const assessment = (
  disposition: SourceIdentityAssessment["disposition"],
  documentId: string | null = null,
  previousContentHash: string | null = null,
  previousIngestionVersion: string | null = null,
): SourceIdentityAssessment => ({ disposition, documentId, previousContentHash, previousIngestionVersion });

export class MemoryPublicIncidentStore implements PublicIncidentStore {
  readonly items = new Map<string, PreparedPublicIncident>();
  readonly attempts = new Map<string, PublicIncidentImportAttempt>();
  readonly revisions: PublicIncidentRevision[] = [];
  private readonly failures = new Set<ImportFailureStage>();

  injectFailureOnce(stage: ImportFailureStage) {
    this.failures.add(stage);
  }

  private maybeFail(stage: ImportFailureStage) {
    if (!this.failures.delete(stage)) return;
    throw new ImportStageError(stage, `INJECTED_${stage}_FAILURE`, new Error(`Injected ${stage} failure`));
  }

  async inspect(incident: RealPublicIncident) {
    const existing = [...this.items.values()].map((item) => item.incident);
    const identity = existing.find((item) => item.sourceProvider === incident.sourceProvider
      && item.sourceRecordId === incident.sourceRecordId);
    if (identity) {
      if (identity.sourceUrl !== incident.sourceUrl || identity.originalSourceUrl !== incident.originalSourceUrl) {
        return assessment("IDENTITY_CONFLICT", `DOC-${identity.id}`, identity.contentHash, identity.ingestionVersion);
      }
      if (identity.contentHash !== incident.contentHash) {
        return assessment("UPDATE_AVAILABLE", `DOC-${identity.id}`, identity.contentHash, identity.ingestionVersion);
      }
      const latest = [...this.attempts.values()].filter((item) => item.provider === incident.sourceProvider
        && item.sourceRecordId === incident.sourceRecordId).at(-1);
      return assessment(latest && latest.status !== "COMPLETED" ? "RETRY_PENDING" : "UNCHANGED",
        `DOC-${identity.id}`, identity.contentHash, identity.ingestionVersion);
    }
    if (existing.some((item) => item.sourceUrl === incident.sourceUrl
      || item.originalSourceUrl === incident.originalSourceUrl)) return assessment("CANONICAL_URL_DUPLICATE");
    if (existing.some((item) => item.contentHash === incident.contentHash)) return assessment("CONTENT_HASH_DUPLICATE");
    return assessment("NEW");
  }

  async recordRevision(revision: PublicIncidentRevision) {
    if (!this.revisions.some((item) => item.id === revision.id)) this.revisions.push(structuredClone(revision));
  }

  async beginAttempt(incident: RealPublicIncident, embeddingBackend: string, vectorBackend: string) {
    const retryCount = [...this.attempts.values()].filter((item) => item.provider === incident.sourceProvider
      && item.sourceRecordId === incident.sourceRecordId && item.contentHash === incident.contentHash).length;
    const attempt: PublicIncidentImportAttempt = {
      id: `PIA-${incident.sourceRecordId}-${incident.contentHash.slice(0, 12)}-${retryCount + 1}`,
      provider: incident.sourceProvider,
      sourceRecordId: incident.sourceRecordId,
      startedAt: incident.retrievedAt,
      completedAt: null,
      status: "PREPARING",
      documentId: `DOC-${incident.id}`,
      contentHash: incident.contentHash,
      sourcePayloadHash: incident.sourcePayloadHash,
      embeddingBackend,
      vectorBackend,
      failureStage: null,
      failureCode: null,
      failureMessage: null,
      retryCount,
      ingestionVersion: incident.ingestionVersion,
    };
    this.attempts.set(attempt.id, structuredClone(attempt));
    return attempt;
  }

  async persistPrepared(attempt: PublicIncidentImportAttempt, item: PreparedPublicIncident) {
    this.maybeFail("D1_PERSIST");
    const staged = new Map(this.items);
    staged.set(item.incident.id, structuredClone(item));
    const nextAttempt = { ...attempt, status: "INDEX_PENDING" as const };
    this.items.clear();
    for (const [id, prepared] of staged) this.items.set(id, prepared);
    this.attempts.set(attempt.id, nextAttempt);
  }

  async indexPrepared(attempt: PublicIncidentImportAttempt, item: PreparedPublicIncident) {
    this.maybeFail("VECTOR_INDEX");
    this.maybeFail("FINALIZE");
    const completedAt = item.incident.retrievedAt;
    const persisted = this.items.get(item.incident.id);
    if (persisted) persisted.document.indexStatus = "ACTIVE";
    this.attempts.set(attempt.id, { ...attempt, status: "COMPLETED", completedAt });
    await this.recordRevision(activeRevision(item.incident, completedAt));
  }

  async failAttempt(attempt: PublicIncidentImportAttempt, stage: ImportFailureStage, code: string, message: string) {
    const existing = this.attempts.get(attempt.id) ?? attempt;
    this.attempts.set(attempt.id, {
      ...existing,
      status: stage === "VECTOR_INDEX" || stage === "FINALIZE" ? "INDEX_FAILED" : "FAILED",
      failureStage: stage,
      failureCode: code,
      failureMessage: message.slice(0, 500),
    });
  }
}

export class D1PublicIncidentStore implements PublicIncidentStore {
  constructor(
    private readonly vectorIndex: VectorIndex,
    private readonly dbProvider: typeof getDb = getDb,
  ) {}

  async inspect(incident: RealPublicIncident) {
    const db = await this.dbProvider();
    const rows = await db.select().from(incidentDocuments)
      .where(eq(incidentDocuments.corpusType, "REAL_PUBLIC"));
    const identity = rows.find((row) => row.sourceProvider === incident.sourceProvider
      && row.sourceRecordId === incident.sourceRecordId);
    if (identity) {
      if (identity.sourceUrl !== incident.sourceUrl || identity.originalSourceUrl !== incident.originalSourceUrl) {
        return assessment("IDENTITY_CONFLICT", identity.id, identity.contentHash, identity.ingestionVersion);
      }
      if (identity.contentHash !== incident.contentHash) {
        return assessment("UPDATE_AVAILABLE", identity.id, identity.contentHash, identity.ingestionVersion);
      }
      const attempts = await db.select().from(publicIncidentImportAttempts).where(and(
        eq(publicIncidentImportAttempts.provider, incident.sourceProvider),
        eq(publicIncidentImportAttempts.sourceRecordId, incident.sourceRecordId),
      ));
      const latest = attempts.sort((left, right) => right.retryCount - left.retryCount)[0];
      return assessment(latest && latest.status !== "COMPLETED" ? "RETRY_PENDING" : "UNCHANGED",
        identity.id, identity.contentHash, identity.ingestionVersion);
    }
    if (rows.some((row) => row.sourceUrl === incident.sourceUrl
      || row.originalSourceUrl === incident.originalSourceUrl)) return assessment("CANONICAL_URL_DUPLICATE");
    if (rows.some((row) => row.contentHash === incident.contentHash)) return assessment("CONTENT_HASH_DUPLICATE");
    return assessment("NEW");
  }

  async recordRevision(revision: PublicIncidentRevision) {
    const db = await this.dbProvider();
    await db.insert(publicIncidentRevisions).values(revision).onConflictDoNothing();
  }

  async beginAttempt(incident: RealPublicIncident, embeddingBackend: string, vectorBackend: string) {
    const db = await this.dbProvider();
    const previous = await db.select().from(publicIncidentImportAttempts).where(and(
      eq(publicIncidentImportAttempts.provider, incident.sourceProvider),
      eq(publicIncidentImportAttempts.sourceRecordId, incident.sourceRecordId),
    ));
    const retryCount = previous.filter((item) => item.contentHash === incident.contentHash).length;
    const attempt: PublicIncidentImportAttempt = {
      id: `PIA-${incident.sourceRecordId}-${incident.contentHash.slice(0, 12)}-${retryCount + 1}`,
      provider: incident.sourceProvider,
      sourceRecordId: incident.sourceRecordId,
      startedAt: incident.retrievedAt,
      completedAt: null,
      status: "PREPARING",
      documentId: `DOC-${incident.id}`,
      contentHash: incident.contentHash,
      sourcePayloadHash: incident.sourcePayloadHash,
      embeddingBackend,
      vectorBackend,
      failureStage: null,
      failureCode: null,
      failureMessage: null,
      retryCount,
      ingestionVersion: incident.ingestionVersion,
    };
    await db.insert(publicIncidentImportAttempts).values(attempt);
    return attempt;
  }

  async persistPrepared(attempt: PublicIncidentImportAttempt, item: PreparedPublicIncident) {
    const db = await this.dbProvider();
    const statements: unknown[] = [
      db.insert(incidentDocuments).values(item.document).onConflictDoNothing(),
      ...item.chunks.map((chunk) => db.insert(incidentChunks).values({
        id: chunk.id, documentId: chunk.documentId, incidentId: chunk.incidentId,
        title: chunk.title, section: chunk.section, content: chunk.content,
        metadataJson: chunk.metadataJson, searchText: chunk.searchText,
        tokenCount: chunk.tokenCount, contentHash: chunk.contentHash,
        corpusVersion: chunk.corpusVersion, corpusType: chunk.corpusType,
        embeddingModel: chunk.embeddingModel, embeddingJson: chunk.embeddingJson,
      }).onConflictDoNothing()),
      ...item.chunks.filter((chunk) => chunk.terms.length > 0).map((chunk) =>
        db.insert(incidentChunkTerms).values(chunk.terms.map((term) => ({ chunkId: chunk.id, ...term })))
          .onConflictDoNothing()),
      db.update(publicIncidentImportAttempts).set({ status: "INDEX_PENDING" })
        .where(and(eq(publicIncidentImportAttempts.id, attempt.id),
          eq(publicIncidentImportAttempts.status, "PREPARING"))),
    ];
    try {
      await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    } catch (error) {
      throw new ImportStageError("D1_PERSIST", "D1_PERSIST_FAILED", error);
    }
  }

  async indexPrepared(attempt: PublicIncidentImportAttempt, item: PreparedPublicIncident) {
    const db = await this.dbProvider();
    await db.update(publicIncidentImportAttempts).set({ status: "INDEXING" })
      .where(and(eq(publicIncidentImportAttempts.id, attempt.id),
        eq(publicIncidentImportAttempts.status, "INDEX_PENDING")));
    try {
      await this.vectorIndex.upsert(item.chunks.map((chunk) => ({
        id: chunk.id,
        values: JSON.parse(chunk.embeddingJson) as number[],
        metadata: {
          corpusVersion: chunk.corpusVersion,
          corpusType: chunk.corpusType,
          incidentId: chunk.incidentId,
          section: chunk.section,
          company: item.incident.company,
        },
      })));
    } catch (error) {
      throw new ImportStageError("VECTOR_INDEX", "VECTOR_INDEX_FAILED", error);
    }
    const completedAt = new Date().toISOString();
    try {
      await db.batch([
        db.update(incidentDocuments).set({ indexStatus: "ACTIVE" })
          .where(and(eq(incidentDocuments.id, attempt.documentId),
            eq(incidentDocuments.indexStatus, "PENDING"))),
        db.update(publicIncidentImportAttempts).set({ status: "COMPLETED", completedAt })
          .where(and(eq(publicIncidentImportAttempts.id, attempt.id),
            eq(publicIncidentImportAttempts.status, "INDEXING"))),
        db.insert(publicIncidentRevisions).values(activeRevision(item.incident, completedAt)).onConflictDoNothing(),
      ] as unknown as Parameters<typeof db.batch>[0]);
    } catch (error) {
      throw new ImportStageError("FINALIZE", "FINALIZE_STATUS_FAILED", error);
    }
  }

  async failAttempt(attempt: PublicIncidentImportAttempt, stage: ImportFailureStage, code: string, message: string) {
    const db = await this.dbProvider();
    await db.update(publicIncidentImportAttempts).set({
      status: stage === "VECTOR_INDEX" || stage === "FINALIZE" ? "INDEX_FAILED" : "FAILED",
      failureStage: stage,
      failureCode: code,
      failureMessage: message.slice(0, 500),
    }).where(eq(publicIncidentImportAttempts.id, attempt.id));
  }
}

const publicMetadata = (incident: RealPublicIncident) => ({
  platform: "", versions: [] as string[], metricKeys: [] as string[], regions: [] as string[],
  userTypes: [] as string[], components: incident.products, severity: "",
  corpusType: incident.corpusType, sourceProvider: incident.sourceProvider,
  sourceRecordId: incident.sourceRecordId, company: incident.company, categories: incident.categories,
  mechanisms: incident.mechanisms,
  incidentDateStart: incident.incidentDateStart, incidentDateEnd: incident.incidentDateEnd,
  sourceUrl: incident.sourceUrl, originalSourceUrl: incident.originalSourceUrl,
  datasetLicense: incident.datasetLicense, originalContentRights: incident.originalContentRights,
  retrievedAt: incident.retrievedAt, contentHash: incident.contentHash,
  sourcePayloadHash: incident.sourcePayloadHash, snapshotVersion: incident.snapshotVersion,
  ingestionVersion: incident.ingestionVersion,
});

export async function preparePublicIncident(
  incident: RealPublicIncident,
  embeddingProvider: EmbeddingProvider,
): Promise<PreparedPublicIncident> {
  const sections = Object.entries({
    summary: incident.sourceSummary, cause: incident.causeSummary, impact: incident.impactSummary,
    detection: incident.detectionSummary, mitigation: incident.mitigationSummary,
    resolution: incident.resolutionSummary, lessons: incident.lessonsSummary,
  }).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (sections.length === 0) throw new Error("NO_INDEXABLE_CONTENT");
  const metadataJson = JSON.stringify(publicMetadata(incident));
  const searchTexts = sections.map(([section, content]) =>
    `${incident.title} ${incident.company} ${section} ${content} ${incident.categories.join(" ")} ${incident.products.join(" ")}`);
  const vectors = await embeddingProvider.embed(searchTexts);
  const documentId = `DOC-${incident.id}`;
  const chunks = await Promise.all(sections.map(async ([section, content], index) => {
    const searchText = searchTexts[index];
    const contentHash = await sha256(searchText);
    return {
      id: `CH-${incident.id}-${section}-${contentHash.slice(0, 8)}`,
      documentId, incidentId: incident.id, title: incident.title, section, content,
      metadataJson, searchText, tokenCount: tokenize(searchText).length, contentHash,
      corpusVersion: REAL_PUBLIC_CORPUS_VERSION, corpusType: "REAL_PUBLIC" as const,
      embeddingModel: embeddingProvider.model, embeddingJson: JSON.stringify(vectors[index]),
      terms: [...termFrequency(searchText)].map(([term, frequency]) => ({ term, termFrequency: frequency })),
    };
  }));
  const content = sections.map(([section, value]) => `## ${section}\n${value}`).join("\n\n");
  return {
    incident,
    document: {
      id: documentId, incidentId: incident.id, title: incident.title, content, metadataJson,
      sourceDocument: incident.sourceUrl, corpusVersion: REAL_PUBLIC_CORPUS_VERSION,
      contentHash: incident.contentHash, corpusType: "REAL_PUBLIC",
      sourceProvider: incident.sourceProvider, sourceRecordId: incident.sourceRecordId,
      sourceUrl: incident.sourceUrl, originalSourceUrl: incident.originalSourceUrl,
      datasetLicenseName: incident.datasetLicense.name, datasetLicenseUrl: incident.datasetLicense.url,
      originalRightsStatus: incident.originalContentRights.status,
      originalLicenseName: incident.originalContentRights.licenseName,
      originalLicenseUrl: incident.originalContentRights.licenseUrl,
      sourcePayloadHash: incident.sourcePayloadHash, snapshotVersion: incident.snapshotVersion,
      indexStatus: "PENDING",
      retrievedAt: incident.retrievedAt, ingestionVersion: incident.ingestionVersion,
      createdAt: incident.retrievedAt,
    },
    chunks,
  };
}

const revisionId = (incident: RealPublicIncident, status: PublicIncidentRevision["status"]) =>
  `PIR-${incident.sourceRecordId}-${incident.contentHash.slice(0, 16)}-${status}`;

const activeRevision = (incident: RealPublicIncident, detectedAt: string): PublicIncidentRevision => ({
  id: revisionId(incident, "ACTIVE"), provider: incident.sourceProvider,
  sourceRecordId: incident.sourceRecordId, documentId: `DOC-${incident.id}`, status: "ACTIVE",
  previousContentHash: null, contentHash: incident.contentHash,
  sourcePayloadHash: incident.sourcePayloadHash, previousIngestionVersion: null,
  ingestionVersion: incident.ingestionVersion, sourceUrl: incident.sourceUrl,
  originalSourceUrl: incident.originalSourceUrl, detectedAt,
});

const candidateRevision = (
  incident: RealPublicIncident,
  identity: SourceIdentityAssessment,
  status: Extract<PublicIncidentRevision["status"], "UPDATE_AVAILABLE" | "IDENTITY_CONFLICT">,
): PublicIncidentRevision => ({
  id: revisionId(incident, status), provider: incident.sourceProvider,
  sourceRecordId: incident.sourceRecordId, documentId: identity.documentId, status,
  previousContentHash: identity.previousContentHash, contentHash: incident.contentHash,
  sourcePayloadHash: incident.sourcePayloadHash,
  previousIngestionVersion: identity.previousIngestionVersion,
  ingestionVersion: PUBLIC_INCIDENT_INGESTION_VERSION,
  sourceUrl: incident.sourceUrl, originalSourceUrl: incident.originalSourceUrl,
  detectedAt: incident.retrievedAt,
});

const emptyReport = (dryRun: boolean): PublicIncidentImportReport => ({
  fetched: 0, accepted: 0, rejected: 0, unchanged: 0, updateAvailable: 0,
  identityConflict: 0, duplicate: 0, persisted: 0, indexed: 0, completed: 0,
  partial: 0, failed: 0, documents: 0, chunks: 0, dryRun,
  failures: [], rejections: [], duplicateDetails: [], updates: [],
});

export async function importPublicIncidentCorpus(input: {
  source: PublicIncidentSource;
  sourceRecordIds: string[];
  store: PublicIncidentStore;
  embeddingProvider: EmbeddingProvider;
  vectorBackend: string;
  curationMechanisms?: Readonly<Record<string, PublicIncidentMechanism[]>>;
  dryRun?: boolean;
}): Promise<PublicIncidentImportReport> {
  const report = emptyReport(Boolean(input.dryRun));
  let snapshots;
  try {
    snapshots = await input.source.fetchRecords(input.sourceRecordIds);
    report.fetched = snapshots.length;
  } catch (error) {
    report.failed = input.sourceRecordIds.length;
    report.failures.push({ sourceRecordId: null, stage: "SNAPSHOT", reasonCode: "SOURCE_FETCH_FAILED", message: boundedMessage(error) });
    return report;
  }
  const sourceIds = new Set<string>();
  const urls = new Set<string>();
  const hashes = new Set<string>();
  for (const snapshot of snapshots) {
    let incident: RealPublicIncident;
    try {
      incident = await normalizePostmortemsAppRecord(
        snapshot,
        input.curationMechanisms?.[snapshot.sourceRecordId] ?? [],
      );
    } catch (error) {
      report.rejected += 1;
      report.rejections.push({ sourceRecordId: snapshot.sourceRecordId, reason: boundedMessage(error) });
      continue;
    }
    const internalDuplicate = sourceIds.has(incident.sourceRecordId)
      || urls.has(incident.sourceUrl) || urls.has(incident.originalSourceUrl)
      || hashes.has(incident.contentHash);
    if (internalDuplicate) {
      report.duplicate += 1;
      report.duplicateDetails.push({ sourceRecordId: incident.sourceRecordId, reason: "DUPLICATE_IN_BATCH" });
      continue;
    }
    sourceIds.add(incident.sourceRecordId);
    urls.add(incident.sourceUrl);
    urls.add(incident.originalSourceUrl);
    hashes.add(incident.contentHash);
    let identity: SourceIdentityAssessment;
    try {
      identity = await input.store.inspect(incident);
    } catch (error) {
      report.failed += 1;
      report.failures.push({
        sourceRecordId: incident.sourceRecordId, stage: "D1_PERSIST",
        reasonCode: "IDENTITY_INSPECTION_FAILED", message: boundedMessage(error),
      });
      continue;
    }
    if (identity.disposition === "UNCHANGED") {
      report.unchanged += 1;
      continue;
    }
    if (identity.disposition === "UPDATE_AVAILABLE" || identity.disposition === "IDENTITY_CONFLICT") {
      const disposition = identity.disposition;
      if (!input.dryRun) {
        try {
          await input.store.recordRevision(candidateRevision(incident, identity, disposition));
        } catch (error) {
          report.failed += 1;
          report.failures.push({
            sourceRecordId: incident.sourceRecordId, stage: "D1_PERSIST",
            reasonCode: "REVISION_AUDIT_FAILED", message: boundedMessage(error),
          });
          continue;
        }
      }
      if (disposition === "UPDATE_AVAILABLE") report.updateAvailable += 1;
      else report.identityConflict += 1;
      report.updates.push({
        sourceRecordId: incident.sourceRecordId, disposition,
        previousContentHash: identity.previousContentHash,
        newContentHash: incident.contentHash, sourcePayloadHash: incident.sourcePayloadHash,
      });
      continue;
    }
    if (identity.disposition === "CANONICAL_URL_DUPLICATE" || identity.disposition === "CONTENT_HASH_DUPLICATE") {
      report.duplicate += 1;
      report.duplicateDetails.push({ sourceRecordId: incident.sourceRecordId, reason: identity.disposition });
      continue;
    }
    report.accepted += 1;
    if (input.dryRun) {
      try {
        const item = await preparePublicIncident(incident, input.embeddingProvider);
        report.documents += 1;
        report.chunks += item.chunks.length;
      } catch (error) {
        report.failed += 1;
        report.failures.push({ sourceRecordId: incident.sourceRecordId, stage: "EMBEDDING", reasonCode: "PREPARATION_FAILED", message: boundedMessage(error) });
      }
      continue;
    }
    let attempt: PublicIncidentImportAttempt;
    try {
      attempt = await input.store.beginAttempt(
        incident, input.embeddingProvider.model, input.vectorBackend,
      );
    } catch (error) {
      report.failed += 1;
      report.failures.push({
        sourceRecordId: incident.sourceRecordId, stage: "D1_PERSIST",
        reasonCode: "IMPORT_ATTEMPT_CREATE_FAILED", message: boundedMessage(error),
      });
      continue;
    }
    let persisted = false;
    try {
      let item: PreparedPublicIncident;
      try {
        item = await preparePublicIncident(incident, input.embeddingProvider);
      } catch (error) {
        throw new ImportStageError("EMBEDDING", "EMBEDDING_FAILED", error);
      }
      report.documents += 1;
      report.chunks += item.chunks.length;
      await input.store.persistPrepared(attempt, item);
      persisted = true;
      report.persisted += 1;
      await input.store.indexPrepared(attempt, item);
      report.indexed += item.chunks.length;
      report.completed += 1;
    } catch (error) {
      const failure = error instanceof ImportStageError
        ? error : new ImportStageError(persisted ? "VECTOR_INDEX" : "D1_PERSIST", "IMPORT_FAILED", error);
      try {
        await input.store.failAttempt(attempt, failure.stage, failure.code, failure.message);
      } catch {
        // The structured report still exposes the original failure when status persistence also fails.
      }
      if (persisted) report.partial += 1;
      report.failed += 1;
      report.failures.push({
        sourceRecordId: incident.sourceRecordId, stage: failure.stage,
        reasonCode: failure.code, message: failure.message,
      });
    }
  }
  return report;
}
