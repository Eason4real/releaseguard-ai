import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  feedbackRecords,
  incidentChunks,
  incidentChunkTerms,
  incidentDocuments,
  ragIndexVersions,
} from "@/db/schema";
import {
  feedbackFixtures,
  INCIDENT_CORPUS_VERSION,
  incidentFixtures,
} from "./fixtures";
import { cosineSimilarity, termFrequency, tokenize } from "./tokenizer";
import type {
  EmbeddingProvider,
  FeedbackMatch,
  FeedbackRetriever,
  FeedbackSearchInput,
  IncidentMatch,
  IncidentRetriever,
  IncidentSearchInput,
  IncidentCorpusScope,
  VectorIndex,
} from "./types";

const CHUNKER_VERSION = "semantic-sections-v1";

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
};

const round = (value: number) => Number(value.toFixed(6));
const batchesOf = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size));

export class D1FeedbackRetriever implements FeedbackRetriever {
  private async ensureSeeded() {
    const db = await getDb();
    const fixtures = feedbackFixtures();
    const [existing] = await db.select({ value: count() }).from(feedbackRecords);
    if (existing.value >= fixtures.length) return;
    for (const batch of batchesOf(fixtures, 5)) {
      await db.insert(feedbackRecords).values(batch.map((item) => ({
        id: item.id,
        timestamp: item.timestamp,
        platform: item.platform,
        appVersion: item.appVersion,
        region: item.region,
        userType: item.userType,
        content: item.content,
        tagsJson: JSON.stringify(item.tags),
        source: item.source,
        sourceReference: item.sourceReference,
        searchText: `${item.content} ${item.tags.join(" ")} ${item.platform} ${item.appVersion} ${item.region} ${item.userType}`,
      }))).onConflictDoNothing();
    }
  }

  async search(input: FeedbackSearchInput): Promise<FeedbackMatch[]> {
    await this.ensureSeeded();
    const rows = await (await getDb()).select().from(feedbackRecords);
    const queryTokens = [...new Set(tokenize(input.query))];
    const limit = Math.min(20, Math.max(1, input.limit ?? 5));
    return rows
      .filter((row) =>
        (!input.startTime || row.timestamp >= input.startTime)
        && (!input.endTime || row.timestamp <= input.endTime)
        && (!input.platform || row.platform === input.platform)
        && (!input.version || row.appVersion === input.version)
        && (!input.region || row.region === input.region)
        && (!input.userType || row.userType === input.userType))
      .map((row) => {
        const haystack = new Set(tokenize(row.searchText));
        const matchedTerms = queryTokens.filter((token) => haystack.has(token));
        const exactPhrase = row.searchText.toLowerCase().includes(input.query.toLowerCase());
        const metadataBoost =
          (input.platform && row.platform === input.platform ? 0.1 : 0)
          + (input.version && row.appVersion === input.version ? 0.15 : 0)
          + (input.region && row.region === input.region ? 0.05 : 0)
          + (input.userType && row.userType === input.userType ? 0.05 : 0);
        const relevance = Math.min(
          1,
          (queryTokens.length ? matchedTerms.length / queryTokens.length : 0)
          + (exactPhrase ? 0.2 : 0)
          + metadataBoost,
        );
        return {
          row,
          matchedTerms,
          relevance,
        };
      })
      .filter((item) => item.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance)
      .slice(0, limit)
      .map(({ row, matchedTerms, relevance }) => ({
        feedbackId: row.id,
        timestamp: row.timestamp,
        platform: row.platform,
        version: row.appVersion,
        region: row.region,
        userType: row.userType,
        content: row.content,
        tags: parseJson(row.tagsJson, []),
        relevance: round(relevance),
        matchedTerms,
        provenance: {
          source: row.source,
          sourceReference: row.sourceReference,
        },
      }));
  }
}

type ChunkMetadata = {
  platform: string;
  versions: string[];
  metricKeys: string[];
  regions: string[];
  userTypes: string[];
  components: string[];
  severity: string;
  corpusType?: "FIXTURE" | "REAL_PUBLIC" | "LIVE_ENTERPRISE";
  sourceProvider?: string;
  company?: string;
  categories?: string[];
  mechanisms?: string[];
  incidentDateStart?: string | null;
  originalSourceUrl?: string;
};

type ChunkCandidate = {
  id: string;
  incidentId: string;
  title: string;
  section: string;
  content: string;
  sourceDocument: string;
  metadata: ChunkMetadata;
  embedding: number[] | null;
  corpusVersion: string;
  corpusType: "FIXTURE" | "REAL_PUBLIC" | "LIVE_ENTERPRISE";
  provenance: IncidentMatch["provenance"];
};

export class D1IncidentRetriever implements IncidentRetriever {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly vectorIndex: VectorIndex | null = null,
    private readonly defaultScope: IncidentCorpusScope = "FIXTURE_ONLY",
  ) {}

  private async ensureSeeded() {
    const db = await getDb();
    const expectedChunkCount = incidentFixtures.reduce(
      (sum, incident) => sum + Object.keys(incident.sections).length,
      0,
    );
    const expectedTermCount = incidentFixtures.reduce((sum, incident) =>
      sum + Object.entries(incident.sections).reduce((sectionSum, [section, value]) => {
        const text = `${incident.incidentId} ${incident.title} ${section} ${value} ${incident.components.join(" ")}`;
        return sectionSum + termFrequency(text).size;
      }, 0), 0);
    const [[documentCount], [chunkCount], [termCount]] = await Promise.all([
      db.select({ value: count() }).from(incidentDocuments)
        .where(eq(incidentDocuments.corpusVersion, INCIDENT_CORPUS_VERSION)),
      db.select({ value: count() }).from(incidentChunks)
        .where(eq(incidentChunks.corpusVersion, INCIDENT_CORPUS_VERSION)),
      db.select({ value: count() }).from(incidentChunkTerms)
        .innerJoin(incidentChunks, eq(incidentChunkTerms.chunkId, incidentChunks.id))
        .where(eq(incidentChunks.corpusVersion, INCIDENT_CORPUS_VERSION)),
    ]);
    const needsSeedRepair = documentCount.value < incidentFixtures.length
      || chunkCount.value < expectedChunkCount
      || termCount.value < expectedTermCount;
    if (needsSeedRepair) {
      for (const incident of incidentFixtures) {
        const content = Object.entries(incident.sections)
          .map(([section, value]) => `## ${section}\n${value}`)
          .join("\n\n");
        const documentId = `DOC-${incident.incidentId}`;
        const metadata: ChunkMetadata = {
          platform: incident.platform,
          versions: incident.versions,
          metricKeys: incident.metricKeys,
          regions: incident.regions,
          userTypes: incident.userTypes,
          components: incident.components,
          severity: incident.severity,
        };
        await db.insert(incidentDocuments).values({
          id: documentId,
          incidentId: incident.incidentId,
          title: incident.title,
          content,
          metadataJson: JSON.stringify(metadata),
          sourceDocument: `incident://phase3/${incident.incidentId}`,
          corpusVersion: INCIDENT_CORPUS_VERSION,
          contentHash: await sha256(content),
          corpusType: "FIXTURE",
          createdAt: new Date().toISOString(),
        }).onConflictDoNothing();
        const sectionEntries = Object.entries(incident.sections);
        const texts = sectionEntries.map(([section, value]) =>
          `${incident.incidentId} ${incident.title} ${section} ${value} ${incident.components.join(" ")}`);
        const vectors = await this.embeddingProvider.embed(texts);
        for (let index = 0; index < sectionEntries.length; index += 1) {
          const [section, value] = sectionEntries[index];
          const searchText = texts[index];
          const contentHash = await sha256(searchText);
          const chunkId = `CH-${incident.incidentId}-${section}-${contentHash.slice(0, 8)}`;
          await db.insert(incidentChunks).values({
            id: chunkId,
            documentId,
            incidentId: incident.incidentId,
            title: incident.title,
            section,
            content: value,
            metadataJson: JSON.stringify(metadata),
            searchText,
            tokenCount: tokenize(searchText).length,
            contentHash,
            corpusVersion: INCIDENT_CORPUS_VERSION,
            corpusType: "FIXTURE",
            embeddingModel: this.embeddingProvider.model,
            embeddingJson: JSON.stringify(vectors[index]),
          }).onConflictDoNothing();
          const frequencies = termFrequency(searchText);
          if (frequencies.size > 0) {
            const terms = [...frequencies.entries()].map(([term, frequency]) => ({
                chunkId,
                term,
                termFrequency: frequency,
              }));
            for (const batch of batchesOf(terms, 25)) {
              await db.insert(incidentChunkTerms).values(batch).onConflictDoNothing();
            }
          }
        }
      }
    }

    const versionId = `${INCIDENT_CORPUS_VERSION}:${this.embeddingProvider.model}`;
    const active = await db.select().from(ragIndexVersions)
      .where(eq(ragIndexVersions.id, versionId))
      .limit(1);
    if (!active[0]) {
      const checksum = await sha256(JSON.stringify(incidentFixtures));
      await db.insert(ragIndexVersions).values({
        id: versionId,
        corpusVersion: INCIDENT_CORPUS_VERSION,
        embeddingModel: this.embeddingProvider.model,
        dimensions: this.embeddingProvider.dimensions,
        chunkerVersion: CHUNKER_VERSION,
        corpusChecksum: checksum,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
      }).onConflictDoNothing();
    }

    let chunks = await db.select().from(incidentChunks)
      .where(eq(incidentChunks.corpusVersion, INCIDENT_CORPUS_VERSION));
    const mismatched = chunks.filter((chunk) =>
      chunk.embeddingModel !== this.embeddingProvider.model || !chunk.embeddingJson);
    if (mismatched.length > 0) {
      const vectors = await this.embeddingProvider.embed(mismatched.map((chunk) => chunk.searchText));
      for (let index = 0; index < mismatched.length; index += 1) {
        await db.update(incidentChunks).set({
          embeddingModel: this.embeddingProvider.model,
          embeddingJson: JSON.stringify(vectors[index]),
        }).where(eq(incidentChunks.id, mismatched[index].id));
      }
      chunks = await db.select().from(incidentChunks)
        .where(eq(incidentChunks.corpusVersion, INCIDENT_CORPUS_VERSION));
    }

    if (this.vectorIndex) {
      await this.vectorIndex.upsert(chunks
        .filter((chunk) => chunk.embeddingJson)
        .map((chunk) => {
          const metadata = parseJson<ChunkMetadata>(chunk.metadataJson, {
            platform: "",
            versions: [],
            metricKeys: [],
            regions: [],
            userTypes: [],
            components: [],
            severity: "",
          });
          return {
            id: chunk.id,
            values: parseJson(chunk.embeddingJson!, []),
            metadata: {
              corpusVersion: INCIDENT_CORPUS_VERSION,
              corpusType: "FIXTURE",
              platform: metadata.platform,
              metricKey: metadata.metricKeys[0] ?? "",
              incidentId: chunk.incidentId,
              section: chunk.section,
            },
          };
        }));
    }
  }

  private metadataMatches(metadata: ChunkMetadata, input: IncidentSearchInput) {
    const publicUnknown = metadata.corpusType === "REAL_PUBLIC";
    return (!input.platform || metadata.platform === input.platform || publicUnknown)
      && (!input.metricKey || metadata.metricKeys.includes(input.metricKey) || publicUnknown)
      && (!input.version || metadata.versions.includes(input.version) || publicUnknown)
      && (!input.region || metadata.regions.includes(input.region) || publicUnknown)
      && (!input.userType || metadata.userTypes.includes(input.userType) || publicUnknown);
  }

  async search(input: IncidentSearchInput): Promise<IncidentMatch[]> {
    await this.ensureSeeded();
    const db = await getDb();
    const scope = input.corpusScope ?? this.defaultScope;
    const corpusType = scope === "FIXTURE_ONLY" ? "FIXTURE"
      : scope === "REAL_PUBLIC_ONLY" ? "REAL_PUBLIC" : null;
    const [chunkRows, documentRows] = await Promise.all([
      corpusType
        ? db.select().from(incidentChunks).where(eq(incidentChunks.corpusType, corpusType))
        : db.select().from(incidentChunks),
      corpusType
        ? db.select().from(incidentDocuments).where(and(
          eq(incidentDocuments.corpusType, corpusType),
          eq(incidentDocuments.indexStatus, "ACTIVE"),
        ))
        : db.select().from(incidentDocuments).where(eq(incidentDocuments.indexStatus, "ACTIVE")),
    ]);
    const documentById = new Map(documentRows.map((row) => [row.id, row]));
    const candidates: ChunkCandidate[] = chunkRows.filter((row) => documentById.has(row.documentId)).map((row) => {
      const document = documentById.get(row.documentId);
      const metadata = parseJson<ChunkMetadata>(row.metadataJson, {
        platform: "",
        versions: [],
        metricKeys: [],
        regions: [],
        userTypes: [],
        components: [],
        severity: "",
      });
      const realPublic = row.corpusType === "REAL_PUBLIC";
      return {
        id: row.id,
        incidentId: row.incidentId,
        title: row.title,
        section: row.section,
        content: row.content,
        sourceDocument: document?.sourceDocument ?? `incident://phase3/${row.incidentId}`,
        metadata,
        embedding: row.embeddingJson ? parseJson(row.embeddingJson, null) : null,
        corpusVersion: row.corpusVersion,
        corpusType: row.corpusType as ChunkCandidate["corpusType"],
        provenance: {
          source: realPublic ? "Public Historical Incident Corpus" : "ReleaseGuard Incident Knowledge Base",
          corpusVersion: row.corpusVersion,
          corpusType: row.corpusType as ChunkCandidate["corpusType"],
          ...(realPublic && document ? {
            sourceProvider: document.sourceProvider ?? undefined,
            sourceRecordId: document.sourceRecordId ?? undefined,
            company: metadata.company,
            incidentDateStart: metadata.incidentDateStart,
            categories: metadata.categories,
            mechanisms: metadata.mechanisms,
            sourceUrl: document.sourceUrl ?? undefined,
            originalSourceUrl: document.originalSourceUrl ?? undefined,
            datasetLicense: document.datasetLicenseName && document.datasetLicenseUrl ? {
              provider: document.sourceProvider ?? "POSTMORTEMS_APP",
              name: document.datasetLicenseName,
              url: document.datasetLicenseUrl,
            } : undefined,
            originalContentRights: document.originalRightsStatus && document.originalSourceUrl ? {
              status: document.originalRightsStatus as "KNOWN_LICENSE" | "SOURCE_SPECIFIC" | "UNKNOWN",
              licenseName: document.originalLicenseName,
              licenseUrl: document.originalLicenseUrl,
              sourceUrl: document.originalSourceUrl,
            } : undefined,
            retrievedAt: document.retrievedAt ?? undefined,
            contentHash: document.contentHash,
            sourcePayloadHash: document.sourcePayloadHash ?? undefined,
            snapshotVersion: document.snapshotVersion ?? undefined,
            ingestionVersion: document.ingestionVersion ?? undefined,
          } : {}),
        },
      };
    }).filter((item) => this.metadataMatches(item.metadata, input));

    const queryTerms = termFrequency(input.query);
    const documentCount = Math.max(candidates.length, 1);
    const averageLength = candidates.reduce((sum, item) =>
      sum + tokenize(`${item.title} ${item.section} ${item.content}`).length, 0) / documentCount;
    const documentFrequency = new Map<string, number>();
    for (const term of queryTerms.keys()) {
      documentFrequency.set(term, candidates.filter((item) =>
        termFrequency(`${item.title} ${item.section} ${item.content}`).has(term)).length);
    }
    const lexical = candidates.map((item) => {
      const frequencies = termFrequency(`${item.title} ${item.section} ${item.content}`);
      const length = [...frequencies.values()].reduce((sum, value) => sum + value, 0);
      let score = 0;
      for (const term of queryTerms.keys()) {
        const frequency = frequencies.get(term) ?? 0;
        if (!frequency) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
        score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / Math.max(averageLength, 1))));
      }
      return { id: item.id, score };
    }).filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 20);

    const [queryVector] = await this.embeddingProvider.embed([input.query]);
    let vector: Array<{ id: string; score: number }>;
    let retrievalMode: IncidentMatch["retrievalSignals"]["retrievalMode"];
    if (this.vectorIndex) {
      const filter: Record<string, unknown> = {};
      if (corpusType) filter.corpusType = { $eq: corpusType };
      if (scope === "FIXTURE_ONLY" && input.platform) filter.platform = { $eq: input.platform };
      if (scope === "FIXTURE_ONLY" && input.metricKey) filter.metricKey = { $eq: input.metricKey };
      vector = await this.vectorIndex.query(queryVector, { topK: 20, filter });
      retrievalMode = "HYBRID_VECTORIZE";
    } else {
      vector = candidates
        .filter((item) => item.embedding)
        .map((item) => ({
          id: item.id,
          score: cosineSimilarity(queryVector, item.embedding!),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 20);
      retrievalMode = this.embeddingProvider.mode === "REAL"
        ? "HYBRID_LOCAL"
        : "HYBRID_LOCAL";
    }

    const lexicalRank = new Map(lexical.map((item, index) => [item.id, { rank: index + 1, score: item.score }]));
    const vectorRank = new Map(vector.map((item, index) => [item.id, { rank: index + 1, score: item.score }]));
    const candidateById = new Map(candidates.map((item) => [item.id, item]));
    const union = new Set([...lexicalRank.keys(), ...vectorRank.keys()]);
    const fused = [...union].map((id) => {
      const item = candidateById.get(id);
      if (!item) return null;
      const lexicalSignal = lexicalRank.get(id);
      const vectorSignal = vectorRank.get(id);
      const metadataScore = (
        (input.platform && item.metadata.platform === input.platform ? 0.3 : 0)
        + (input.metricKey && item.metadata.metricKeys.includes(input.metricKey) ? 0.3 : 0)
        + (input.version && item.metadata.versions.includes(input.version) ? 0.2 : 0)
        + (input.region && item.metadata.regions.includes(input.region) ? 0.1 : 0)
        + (input.userType && item.metadata.userTypes.includes(input.userType) ? 0.1 : 0)
      );
      const rrf =
        (lexicalSignal ? 0.45 / (60 + lexicalSignal.rank) : 0)
        + (vectorSignal ? 0.55 / (60 + vectorSignal.rank) : 0);
      const finalScore = rrf * (1 + 0.25 * metadataScore);
      return { item, lexicalSignal, vectorSignal, metadataScore, finalScore };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.finalScore - left.finalScore);

    const limit = Math.min(10, Math.max(1, input.limit ?? 5));
    const perIncident = new Map<string, number>();
    const selected = fused.filter(({ item }) => {
      const count = perIncident.get(item.incidentId) ?? 0;
      if (count >= 2) return false;
      perIncident.set(item.incidentId, count + 1);
      return true;
    }).slice(0, limit);
    const maxScore = selected[0]?.finalScore || 1;
    return selected.map(({ item, lexicalSignal, vectorSignal, metadataScore, finalScore }) => ({
      incidentId: item.incidentId,
      title: item.title,
      relevance: round(finalScore / maxScore),
      chunk: item.content,
      metadata: item.metadata,
      provenance: item.provenance,
      sourceDocument: item.sourceDocument,
      chunkId: item.id,
      section: item.section,
      retrievalSignals: {
        lexicalRank: lexicalSignal?.rank ?? null,
        lexicalScore: lexicalSignal ? round(lexicalSignal.score) : null,
        vectorRank: vectorSignal?.rank ?? null,
        vectorScore: vectorSignal ? round(vectorSignal.score) : null,
        metadataScore: round(metadataScore),
        finalScore: round(finalScore),
        retrievalMode,
        embeddingModel: this.embeddingProvider.model,
      },
    }));
  }
}
