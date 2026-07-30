import type {
  BenchmarkExecutionRequest,
  InvestigationBenchmarkCase,
} from "./types";

const requireOpaqueId = (value: string, prefix: "CASE" | "SRC" | "EV") => {
  if (!new RegExp(`^${prefix}-\\d{3,}$`).test(value)) {
    throw new Error(`NON_OPAQUE_BENCHMARK_IDENTIFIER: ${value}`);
  }
};

export function deriveBenchmarkExecutionRequest(
  benchmarkCase: InvestigationBenchmarkCase,
): BenchmarkExecutionRequest {
  const riskEvent = benchmarkCase.input.riskEvent;
  const release = benchmarkCase.input.release;
  requireOpaqueId(benchmarkCase.caseId, "CASE");
  for (const source of benchmarkCase.dataSources) {
    requireOpaqueId(source.sourceId, "SRC");
    if (source.fixtureRef !== `fixture://${source.sourceId}`) {
      throw new Error(`NON_OPAQUE_BENCHMARK_REFERENCE: ${source.fixtureRef}`);
    }
    for (const evidenceId of source.evidenceIds) requireOpaqueId(evidenceId, "EV");
  }
  return {
    executionKey: benchmarkCase.caseId,
    agentInput: {
      incidentId: benchmarkCase.input.incidentId,
      incidentQuestion: benchmarkCase.input.question,
      riskEvent: riskEvent ? {
        ...riskEvent,
        filters: { ...riskEvent.filters },
        triggerBucketIds: [...riskEvent.triggerBucketIds],
      } : null,
      ...(release !== undefined ? {
        release: release ? {
          ...release,
          featureFlags: [...release.featureFlags],
          changedModules: [...release.changedModules],
        } : null,
      } : {}),
      dataSources: benchmarkCase.dataSources.map((source) => ({
        kind: source.kind,
        sourceRef: source.fixtureRef,
      })),
    },
  };
}
