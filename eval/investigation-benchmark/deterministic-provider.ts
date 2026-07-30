import type {
  BenchmarkRawInvestigationResult,
  BenchmarkResultProvider,
} from "./types";

export function createDeterministicFixtureProvider(
  results: readonly BenchmarkRawInvestigationResult[],
): BenchmarkResultProvider {
  const byCaseId = new Map(results.map((result) => [result.caseId, result]));
  return {
    run(benchmarkCase) {
      const result = byCaseId.get(benchmarkCase.caseId);
      if (!result) throw new Error(`Missing deterministic fixture: ${benchmarkCase.caseId}`);
      return result;
    },
  };
}
