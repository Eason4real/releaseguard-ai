import { loadInvestigationBenchmarkDevDataset } from "../dataset/dev";
import { loadLivePreflightFixture } from "./preflight-fixture";
import type {
  HarnessExecutionProviderFactory,
  LivePreflightFixture,
  LivePreflightReport,
} from "./types";

export const assertLivePreflightIsolation = (
  fixture: LivePreflightFixture,
  governedDevCaseIds: readonly string[],
) => {
  if (fixture.executionPurpose !== "PREFLIGHT_ONLY" || fixture.benchmarkEligible !== false) {
    throw new Error("INVALID_PREFLIGHT_CONTRACT");
  }
  if (fixture.caseId !== "CASE-901" || /^CASE-2(?:0[1-9]|1\d|2[0-2])$/.test(fixture.caseId)) {
    throw new Error("INVALID_PREFLIGHT_CASE_ID");
  }
  if (governedDevCaseIds.includes(fixture.caseId)) {
    throw new Error("PREFLIGHT_CASE_COLLIDES_WITH_GOVERNED_DEV");
  }
};

export async function runLivePreflight(options: {
  sourceCommit: string;
  providerFactory: HarnessExecutionProviderFactory;
  fixture?: LivePreflightFixture;
}): Promise<LivePreflightReport> {
  const fixture = options.fixture ?? loadLivePreflightFixture();
  const devDataset = loadInvestigationBenchmarkDevDataset();
  assertLivePreflightIsolation(
    fixture,
    devDataset.manifest.caseEntries.map((entry) => entry.caseId),
  );
  if (options.providerFactory.executionMetadata.executionProvider !== "LIVE_LLM_PROVIDER") {
    throw new Error("PREFLIGHT_REQUIRES_LIVE_LLM_PROVIDER");
  }
  const modelConfiguration = options.providerFactory.executionMetadata.modelConfiguration;
  if (typeof modelConfiguration === "string") {
    throw new Error("PREFLIGHT_LIVE_MODEL_CONFIGURATION_REQUIRED");
  }
  const provider = options.providerFactory.create();
  if (provider.providerType !== "LIVE_LLM_PROVIDER") {
    throw new Error("PREFLIGHT_PROVIDER_METADATA_MISMATCH");
  }
  const outcome = await provider.execute(structuredClone(fixture.request));
  const prediction = outcome.prediction;
  const telemetry = outcome.telemetry;
  return {
    label: "Live Agent Preflight",
    executionPurpose: "PREFLIGHT_ONLY",
    benchmarkEligible: false,
    caseId: fixture.caseId,
    sourceCommit: options.sourceCommit,
    executionProvider: "LIVE_LLM_PROVIDER",
    provider: modelConfiguration.provider,
    model: modelConfiguration.model,
    endpoint: modelConfiguration.baseUrl,
    terminalState: outcome.terminalInvestigationState,
    status: outcome.status,
    modelCallCount: prediction?.modelCallCount ?? 0,
    toolCallCount: prediction?.toolCallCount ?? 0,
    tokenUsage: prediction?.tokenUsage,
    schemaRepairCount: telemetry?.schemaRepairCount ?? 0,
    plannerActions: telemetry?.plannerActions ?? [],
    toolTrajectory: telemetry?.toolTrajectory ?? [],
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}
