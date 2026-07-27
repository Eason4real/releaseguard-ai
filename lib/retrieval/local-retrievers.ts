import { DeterministicEmbeddingProvider } from "./embedding";
import { feedbackFixtures, INCIDENT_CORPUS_VERSION, incidentFixtures } from "./fixtures";
import { cosineSimilarity, termFrequency, tokenize } from "./tokenizer";
import type {
  FeedbackMatch,
  FeedbackRetriever,
  FeedbackSearchInput,
  IncidentMatch,
  IncidentRetriever,
  IncidentSearchInput,
} from "./types";

const round = (value: number) => Number(value.toFixed(6));

export class InMemoryFeedbackRetriever implements FeedbackRetriever {
  async search(input: FeedbackSearchInput): Promise<FeedbackMatch[]> {
    const queryTokens = [...new Set(tokenize(input.query))];
    return feedbackFixtures().filter((item) =>
      (!input.startTime || item.timestamp >= input.startTime)
      && (!input.endTime || item.timestamp <= input.endTime)
      && (!input.platform || item.platform === input.platform)
      && (!input.version || item.appVersion === input.version)
      && (!input.region || item.region === input.region)
      && (!input.userType || item.userType === input.userType))
      .map((item) => {
        const tokens = new Set(tokenize(`${item.content} ${item.tags.join(" ")}`));
        const matchedTerms = queryTokens.filter((token) => tokens.has(token));
        const relevance = queryTokens.length ? matchedTerms.length / queryTokens.length : 0;
        return { item, matchedTerms, relevance };
      })
      .filter((item) => item.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance)
      .slice(0, Math.min(20, Math.max(1, input.limit ?? 5)))
      .map(({ item, matchedTerms, relevance }) => ({
        feedbackId: item.id,
        timestamp: item.timestamp,
        platform: item.platform,
        version: item.appVersion,
        region: item.region,
        userType: item.userType,
        content: item.content,
        tags: item.tags,
        relevance: round(relevance),
        matchedTerms,
        provenance: { source: item.source, sourceReference: item.sourceReference },
      }));
  }
}

export class InMemoryIncidentRetriever implements IncidentRetriever {
  private readonly embedding = new DeterministicEmbeddingProvider();

  async search(input: IncidentSearchInput): Promise<IncidentMatch[]> {
    const chunks = incidentFixtures.flatMap((incident) =>
      Object.entries(incident.sections).map(([section, content]) => ({
        id: `CH-${incident.incidentId}-${section}`,
        incident,
        section,
        content,
        searchText: `${incident.incidentId} ${incident.title} ${section} ${content} ${incident.components.join(" ")}`,
      }))).filter(({ incident }) =>
        (!input.platform || incident.platform === input.platform)
        && (!input.metricKey || incident.metricKeys.includes(input.metricKey))
        && (!input.version || incident.versions.includes(input.version))
        && (!input.region || incident.regions.includes(input.region))
        && (!input.userType || incident.userTypes.includes(input.userType)));
    const queryTokens = [...new Set(tokenize(input.query))];
    const [queryVector] = await this.embedding.embed([input.query]);
    const vectors = await this.embedding.embed(chunks.map((item) => item.searchText));
    const scored = chunks.map((item, index) => {
      const frequencies = termFrequency(item.searchText);
      const lexicalScore = queryTokens.reduce((sum, token) =>
        sum + Math.log1p(frequencies.get(token) ?? 0), 0);
      const vectorScore = cosineSimilarity(queryVector, vectors[index]);
      return { item, lexicalScore, vectorScore };
    });
    const lexical = [...scored].sort((a, b) => b.lexicalScore - a.lexicalScore);
    const vector = [...scored].sort((a, b) => b.vectorScore - a.vectorScore);
    const lexicalRank = new Map(lexical.map((item, index) => [item.item.id, index + 1]));
    const vectorRank = new Map(vector.map((item, index) => [item.item.id, index + 1]));
    const fused = scored.map((item) => {
      const lRank = lexicalRank.get(item.item.id)!;
      const vRank = vectorRank.get(item.item.id)!;
      const metadataScore =
        (input.platform ? 0.3 : 0)
        + (input.metricKey ? 0.3 : 0)
        + (input.version ? 0.2 : 0)
        + (input.region ? 0.1 : 0)
        + (input.userType ? 0.1 : 0);
      const finalScore = (0.45 / (60 + lRank) + 0.55 / (60 + vRank))
        * (1 + 0.25 * metadataScore);
      return { ...item, lRank, vRank, metadataScore, finalScore };
    }).sort((a, b) => b.finalScore - a.finalScore);
    const max = fused[0]?.finalScore || 1;
    const limit = Math.min(10, Math.max(1, input.limit ?? 5));
    const perIncident = new Map<string, number>();
    return fused.filter(({ item }) => {
      const count = perIncident.get(item.incident.incidentId) ?? 0;
      if (count >= 2) return false;
      perIncident.set(item.incident.incidentId, count + 1);
      return true;
    }).slice(0, limit).map((item) => ({
      incidentId: item.item.incident.incidentId,
      title: item.item.incident.title,
      relevance: round(item.finalScore / max),
      chunk: item.item.content,
      metadata: {
        platform: item.item.incident.platform,
        versions: item.item.incident.versions,
        metricKeys: item.item.incident.metricKeys,
        regions: item.item.incident.regions,
        userTypes: item.item.incident.userTypes,
        components: item.item.incident.components,
        severity: item.item.incident.severity,
      },
      provenance: {
        source: "ReleaseGuard Incident Knowledge Base",
        corpusVersion: INCIDENT_CORPUS_VERSION,
      },
      sourceDocument: `incident://phase3/${item.item.incident.incidentId}`,
      chunkId: item.item.id,
      section: item.item.section,
      retrievalSignals: {
        lexicalRank: item.lRank,
        lexicalScore: round(item.lexicalScore),
        vectorRank: item.vRank,
        vectorScore: round(item.vectorScore),
        metadataScore: round(item.metadataScore),
        finalScore: round(item.finalScore),
        retrievalMode: "HYBRID_LOCAL",
        embeddingModel: this.embedding.model,
      },
    }));
  }
}
