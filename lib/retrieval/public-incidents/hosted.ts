import { drizzle } from "drizzle-orm/d1";
import manifest from "../../../data/public-incidents/manifest.json";
import * as schema from "../../../db/schema";
import { CloudflareVectorIndex, WorkersAIEmbeddingProvider } from "../embedding";
import { PostmortemsAppSource } from "./postmortems-app";
import { D1PublicIncidentStore, importPublicIncidentCorpus } from "./pipeline";
import type { PublicIncidentImportReport } from "./types";

type HostedD1 = Parameters<typeof drizzle>[0];
type HostedAI = ConstructorParameters<typeof WorkersAIEmbeddingProvider>[0];
type HostedVectorize = ConstructorParameters<typeof CloudflareVectorIndex>[0];

export type PublicCorpusHostedBindings = {
  DB?: HostedD1;
  AI?: HostedAI;
  VECTORIZE?: HostedVectorize;
};

export function validateHostedPublicCorpusBindings(
  bindings: PublicCorpusHostedBindings,
): asserts bindings is Required<PublicCorpusHostedBindings> {
  if (!bindings.DB) throw new Error("PUBLIC_CORPUS_HOSTED_BINDING_MISSING:DB");
  if (!bindings.AI) throw new Error("PUBLIC_CORPUS_HOSTED_BINDING_MISSING:AI");
  if (!bindings.VECTORIZE) throw new Error("PUBLIC_CORPUS_HOSTED_BINDING_MISSING:VECTORIZE");
}

export function createHostedPublicCorpusRuntime(bindings: PublicCorpusHostedBindings) {
  validateHostedPublicCorpusBindings(bindings);
  const embeddingProvider = new WorkersAIEmbeddingProvider(bindings.AI);
  const vectorIndex = new CloudflareVectorIndex(bindings.VECTORIZE);
  const store = new D1PublicIncidentStore(
    vectorIndex,
    async () => drizzle(bindings.DB, { schema }),
  );
  return { embeddingProvider, vectorIndex, store };
}

export async function runHostedPublicCorpusImport(
  bindings: PublicCorpusHostedBindings,
  sourceRecordIds: string[] = manifest.records.map((record) => record.sourceId),
): Promise<PublicIncidentImportReport> {
  const allowlist = new Set(manifest.records.map((record) => record.sourceId));
  if (sourceRecordIds.some((sourceRecordId) => !allowlist.has(sourceRecordId))) {
    throw new Error("PUBLIC_CORPUS_SOURCE_NOT_ALLOWLISTED");
  }
  const { embeddingProvider, vectorIndex, store } = createHostedPublicCorpusRuntime(bindings);
  return importPublicIncidentCorpus({
    source: new PostmortemsAppSource(),
    sourceRecordIds,
    store,
    embeddingProvider,
    vectorBackend: vectorIndex.mode,
  });
}
