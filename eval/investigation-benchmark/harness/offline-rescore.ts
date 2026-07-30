import { canonicalJson, sha256 } from "../../../lib/retrieval/public-incidents/normalize";
import { loadInvestigationBenchmarkDevDataset } from "../dataset/dev";
import { validateInvestigationBenchmarkDataset } from "../dataset/validator";
import { scoreInvestigationCase } from "../scorer";
import type { NormalizedInvestigationResult } from "../types";
import { aggregateHarnessCases, breakdownHarnessCases } from "./runner";
import type { HarnessCaseExecutionResult } from "./types";

type FrozenBaselineCase = {
  caseId: string;
  normalizedPrediction: NormalizedInvestigationResult | null;
};

type FrozenBaselineReport = {
  manifest: {
    datasetId: string;
    datasetVersion: string;
    datasetHash: string;
    evaluationContractVersion: string;
    sourceCommit: string;
    totalCases: number;
    completedCases: number;
    failedCases: number;
  };
  cases: FrozenBaselineCase[];
  semanticHash: string;
};

export async function rescoreFrozenBaselineReport(
  source: FrozenBaselineReport,
  sourceReportSha256: string,
) {
  if (!/^[a-f0-9]{64}$/.test(sourceReportSha256)) {
    throw new Error("INVALID_SOURCE_REPORT_SHA256");
  }
  if (source.manifest.totalCases !== 22 || source.cases.length !== 22) {
    throw new Error("FROZEN_BASELINE_CASE_COUNT_MISMATCH");
  }
  const dataset = loadInvestigationBenchmarkDevDataset();
  const validation = await validateInvestigationBenchmarkDataset(dataset);
  if (validation.status !== "PASS"
    || validation.expectedDatasetHash !== validation.calculatedDatasetHash) {
    throw new Error("RESCORE_DATASET_GOVERNANCE_FAILED");
  }
  const fixtures = new Map(dataset.fixtures.map((fixture) =>
    [fixture.benchmarkCase.caseId, fixture.benchmarkCase]));
  const entries = new Map(dataset.manifest.caseEntries.map((entry) => [entry.caseId, entry]));
  const expectedCaseIds = [...entries.keys()].sort();
  const sourceCaseIds = source.cases.map((item) => item.caseId).sort();
  if (canonicalJson(sourceCaseIds) !== canonicalJson(expectedCaseIds)) {
    throw new Error("FROZEN_BASELINE_CASE_ID_MISMATCH");
  }

  const cases: HarnessCaseExecutionResult[] = source.cases.map((sourceCase) => {
    const benchmarkCase = fixtures.get(sourceCase.caseId);
    const entry = entries.get(sourceCase.caseId);
    if (!benchmarkCase || !entry) throw new Error(`UNKNOWN_FROZEN_CASE: ${sourceCase.caseId}`);
    const normalizedPrediction = sourceCase.normalizedPrediction;
    const runtimeFailed = normalizedPrediction === null;
    const scoringInput: NormalizedInvestigationResult = normalizedPrediction ?? {
      caseId: sourceCase.caseId,
      predictedRootCause: "",
      predictedRootCauseId: null,
      citedEvidenceIds: [],
      diagnosisClaims: [],
      modelCallCount: 0,
      toolCallCount: 0,
    };
    if (scoringInput.caseId !== sourceCase.caseId) {
      throw new Error(`NORMALIZED_PREDICTION_CASE_ID_MISMATCH: ${sourceCase.caseId}`);
    }
    return {
      caseId: sourceCase.caseId,
      category: entry.category,
      difficulty: entry.difficulty,
      execution: {
        status: runtimeFailed ? "FAIL" : "PASS",
        terminalInvestigationState: runtimeFailed ? "FAILED" : "FINALIZED",
        modelCallCount: scoringInput.modelCallCount,
        toolCallCount: scoringInput.toolCallCount,
        ...(runtimeFailed ? { error: "FROZEN_BASELINE_RUNTIME_FAILURE" } : {}),
      },
      normalizedPrediction: normalizedPrediction ? structuredClone(normalizedPrediction) : null,
      scoring: scoreInvestigationCase(benchmarkCase, scoringInput, { runtimeFailed }),
    };
  });
  const aggregate = aggregateHarnessCases(cases);
  const breakdown = {
    category: breakdownHarnessCases(cases, "category"),
    difficulty: breakdownHarnessCases(cases, "difficulty"),
  };
  const identity = {
    datasetId: dataset.manifest.datasetId,
    datasetVersion: dataset.manifest.version,
    datasetHash: validation.calculatedDatasetHash,
    evaluationContractVersion: dataset.manifest.evaluationContractVersion,
    sourceCommit: source.manifest.sourceCommit,
    sourceReportSha256,
    sourceSemanticHash: source.semanticHash,
    scoringInput: "FROZEN_NORMALIZED_PREDICTION_ONLY" as const,
  };
  const semanticPayload = {
    label: "Offline Frozen Baseline Rescore",
    identity,
    cases: cases.map((item) => ({
      ...item,
      normalizedPrediction: item.normalizedPrediction
        ? { ...item.normalizedPrediction, durationMs: undefined }
        : null,
      scoring: { ...item.scoring, cost: { ...item.scoring.cost, durationMs: undefined } },
    })),
    aggregate,
    breakdown,
  };
  return {
    ...semanticPayload,
    semanticHash: await sha256(canonicalJson(semanticPayload)),
  };
}
