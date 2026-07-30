import { aggregateInvestigationMetrics, scoreInvestigationCase } from "./scorer";
import { deriveBenchmarkExecutionRequest } from "./execution-input";
import { normalizeInvestigationResult } from "./normalizer";
import type {
  BenchmarkResultProvider,
  InvestigationBenchmarkCase,
  InvestigationBenchmarkRunResult,
} from "./types";

export async function runInvestigationBenchmark(
  benchmarkCases: InvestigationBenchmarkCase[],
  provider: BenchmarkResultProvider,
): Promise<InvestigationBenchmarkRunResult> {
  const cases = [];
  for (const benchmarkCase of benchmarkCases) {
    const request = deriveBenchmarkExecutionRequest(benchmarkCase);
    const rawResult = await provider.run(request);
    const normalizedResult = normalizeInvestigationResult(rawResult);
    cases.push(scoreInvestigationCase(benchmarkCase, normalizedResult));
  }
  return {
    cases,
    aggregate: aggregateInvestigationMetrics(cases),
  };
}
