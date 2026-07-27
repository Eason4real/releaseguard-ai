export type FeedbackSearchInput = {
  query: string;
  startTime?: string;
  endTime?: string;
  platform?: string;
  version?: string;
  region?: string;
  userType?: string;
  limit?: number;
};

export type FeedbackMatch = {
  feedbackId: string;
  timestamp: string;
  platform: string;
  version: string;
  region: string;
  userType: string;
  content: string;
  tags: string[];
  relevance: number;
  matchedTerms: string[];
  provenance: {
    source: string;
    sourceReference: string;
  };
};

export interface FeedbackRetriever {
  search(input: FeedbackSearchInput): Promise<FeedbackMatch[]>;
}

export type IncidentSearchInput = {
  query: string;
  metricKey?: string;
  platform?: string;
  version?: string;
  region?: string;
  userType?: string;
  limit?: number;
};

export type IncidentMatch = {
  incidentId: string;
  title: string;
  relevance: number;
  chunk: string;
  metadata: Record<string, unknown>;
  provenance: {
    source: string;
    corpusVersion: string;
  };
  sourceDocument: string;
  chunkId: string;
  section: string;
  retrievalSignals: {
    lexicalRank: number | null;
    lexicalScore: number | null;
    vectorRank: number | null;
    vectorScore: number | null;
    metadataScore: number;
    finalScore: number;
    retrievalMode: "HYBRID_VECTORIZE" | "HYBRID_LOCAL" | "LEXICAL_DEGRADED";
    embeddingModel: string;
  };
};

export interface IncidentRetriever {
  search(input: IncidentSearchInput): Promise<IncidentMatch[]>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly mode: "REAL" | "FALLBACK";
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorIndex {
  readonly mode: "VECTORIZE" | "LOCAL";
  upsert(items: Array<{
    id: string;
    values: number[];
    metadata: Record<string, string | number | boolean>;
  }>): Promise<void>;
  query(
    vector: number[],
    options: {
      topK: number;
      filter?: Record<string, unknown>;
    },
  ): Promise<Array<{ id: string; score: number }>>;
}
