import { tokenize } from "./tokenizer";
import type { EmbeddingProvider, VectorIndex } from "./types";

const hash = (value: string) => {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
};

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = "deterministic-token-hash-v1";
  readonly dimensions = 256;
  readonly mode = "FALLBACK" as const;

  async embed(texts: string[]) {
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      for (const token of tokenize(text)) {
        const index = hash(token) % this.dimensions;
        vector[index] += (hash(`${token}:sign`) & 1) === 0 ? 1 : -1;
      }
      const norm = Math.sqrt(vector.reduce((sum, item) => sum + item ** 2, 0)) || 1;
      return vector.map((item) => item / norm);
    });
  }
}

type WorkersAI = {
  run(model: string, input: { text: string[] }): Promise<{
    data?: number[][];
    shape?: number[];
  }>;
};

export class WorkersAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = "@cf/baai/bge-m3";
  readonly dimensions = 1024;
  readonly mode = "REAL" as const;

  constructor(private readonly ai: WorkersAI) {}

  async embed(texts: string[]) {
    const response = await this.ai.run(this.model, { text: texts });
    if (!Array.isArray(response.data) || response.data.some((item) => item.length !== this.dimensions)) {
      throw new Error("Workers AI 返回的 BGE-M3 向量维度不正确。");
    }
    return response.data;
  }
}

type VectorizeBinding = {
  upsert(items: Array<{
    id: string;
    values: number[];
    metadata: Record<string, string | number | boolean>;
  }>): Promise<unknown>;
  query(
    vector: number[],
    options: {
      topK: number;
      returnMetadata?: "none" | "indexed" | "all";
      filter?: Record<string, unknown>;
    },
  ): Promise<{ matches?: Array<{ id: string; score: number }> }>;
};

export class CloudflareVectorIndex implements VectorIndex {
  readonly mode = "VECTORIZE" as const;

  constructor(private readonly binding: VectorizeBinding) {}

  async upsert(items: Array<{
    id: string;
    values: number[];
    metadata: Record<string, string | number | boolean>;
  }>) {
    await this.binding.upsert(items);
  }

  async query(vector: number[], options: { topK: number; filter?: Record<string, unknown> }) {
    const result = await this.binding.query(vector, {
      ...options,
      returnMetadata: "indexed",
    });
    return result.matches ?? [];
  }
}
