import type {
  BenchmarkRawInvestigationResult,
  BenchmarkResultProvider,
} from "./types";

export function createDeterministicFixtureProvider(
  results: readonly BenchmarkRawInvestigationResult[],
): BenchmarkResultProvider {
  const byCaseId = new Map(results.map((result) => [result.caseId, result]));
  return {
    run(request) {
      const result = byCaseId.get(request.executionKey);
      if (!result) throw new Error(`Missing deterministic fixture: ${request.executionKey}`);
      return result;
    },
  };
}
