import {
  CloudflareVectorIndex,
  DeterministicEmbeddingProvider,
  WorkersAIEmbeddingProvider,
} from "./embedding";
import { D1FeedbackRetriever, D1IncidentRetriever } from "./retrievers";

type RuntimeEnv = {
  AI?: ConstructorParameters<typeof WorkersAIEmbeddingProvider>[0];
  VECTORIZE?: ConstructorParameters<typeof CloudflareVectorIndex>[0];
};

export async function createRuntimeRetrievers() {
  let env: RuntimeEnv = {};
  try {
    const workersModule = "cloudflare:workers";
    const imported = await import(/* @vite-ignore */ workersModule) as { env?: RuntimeEnv };
    env = imported.env ?? {};
  } catch {
    // Local and CI use the deterministic fallback.
  }
  const embedding = env.AI
    ? new WorkersAIEmbeddingProvider(env.AI)
    : new DeterministicEmbeddingProvider();
  const vector = env.VECTORIZE ? new CloudflareVectorIndex(env.VECTORIZE) : null;
  return {
    feedbackRetriever: new D1FeedbackRetriever(),
    incidentRetriever: new D1IncidentRetriever(embedding, vector),
    ragMode: vector && embedding.mode === "REAL" ? "HYBRID_VECTORIZE" : "HYBRID_LOCAL",
    embeddingModel: embedding.model,
  };
}
