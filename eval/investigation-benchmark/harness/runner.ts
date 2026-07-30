import { deriveBenchmarkExecutionRequest } from "../execution-input";
import { normalizeInvestigationResult } from "../normalizer";
import { aggregateInvestigationMetrics, scoreInvestigationCase } from "../scorer";
import type { BenchmarkRawInvestigationResult, InvestigationBenchmarkCase } from "../types";
import { loadInvestigationBenchmarkDevDataset } from "../dataset/dev";
import type {
  DatasetCaseEntry,
  GovernedBenchmarkCaseFixture,
  InvestigationBenchmarkDatasetDefinition,
} from "../dataset/types";
import { validateInvestigationBenchmarkDataset } from "../dataset/validator";
import { calculateHarnessSemanticHash } from "./semantic-hash";
import type {
  DevHarnessReport,
  DevHarnessRunOptions,
  HarnessAgentRequest,
  HarnessAggregateMetrics,
  HarnessCaseExecutionResult,
  HarnessToolObservation,
} from "./types";

const ENABLED_TOOLS = [
  "get_release",
  "query_metric",
  "segment_metric",
  "search_user_feedback",
  "search_similar_incidents",
] as const;

const observationRequest = (
  fixture: GovernedBenchmarkCaseFixture,
): HarnessAgentRequest => {
  const execution = deriveBenchmarkExecutionRequest(fixture.benchmarkCase);
  const sourceRefById = new Map(fixture.benchmarkCase.dataSources.map((source) =>
    [source.sourceId, source.fixtureRef]));
  const observations: HarnessToolObservation[] = fixture.evidence.map((item) => {
    const sourceRef = sourceRefById.get(item.sourceId);
    if (!sourceRef) throw new Error(`MISSING_SOURCE_REFERENCE: ${item.evidenceId}`);
    if (!(ENABLED_TOOLS as readonly string[]).includes(item.toolName)) {
      throw new Error(`HARNESS_TOOL_NOT_ENABLED: ${item.toolName}`);
    }
    return {
      evidenceId: item.evidenceId,
      sourceRef,
      toolName: item.toolName,
      observationScope: item.observationScope,
      status: "SUCCESS",
      output: structuredClone(item.payload),
    };
  });
  return {
    agentInput: execution.agentInput,
    enabledTools: [...ENABLED_TOOLS],
    observations,
  };
};

const failurePrediction = (benchmarkCase: InvestigationBenchmarkCase) =>
  normalizeInvestigationResult({
    caseId: benchmarkCase.caseId,
    predictedRootCause: "",
    predictedRootCauseId: null,
    citedEvidenceIds: [],
    diagnosisClaims: [],
    modelCallCount: 0,
    toolCallCount: 0,
  });

export const aggregateHarnessCases = (cases: HarnessCaseExecutionResult[]): HarnessAggregateMetrics => {
  const scores = cases.map((item) => item.scoring);
  const base = aggregateInvestigationMetrics(scores);
  return {
    totalCases: cases.length,
    completedCases: cases.filter((item) => item.execution.status === "PASS").length,
    failedCases: cases.filter((item) => item.execution.status === "FAIL").length,
    rootCauseTop1Accuracy: base.rootCauseTop1Accuracy,
    automaticallyEvaluatedCases: base.automaticallyEvaluatedCases,
    correctCases: base.correctCases,
    incorrectCases: base.incorrectCases,
    reviewRequiredCases: base.reviewRequiredCases,
    runtimeFailedCases: base.runtimeFailedCases,
    autoEvaluationCoverage: base.autoEvaluationCoverage,
    autoEvaluableAccuracy: base.autoEvaluableAccuracy,
    meanEvidencePrecision: base.meanEvidencePrecision,
    meanUnsupportedClaimRate: base.meanUnsupportedClaimRate,
    groundingEvaluableCases: scores.filter((item) => item.grounding.status === "EVALUABLE").length,
    groundingUnavailableCases: scores.filter((item) => item.grounding.status === "NOT_EVALUABLE").length,
    medianModelCalls: base.medianModelCalls,
    medianToolCalls: base.medianToolCalls,
    totalModelCalls: scores.reduce((sum, item) => sum + item.cost.modelCalls, 0),
    totalToolCalls: scores.reduce((sum, item) => sum + item.cost.toolCalls, 0),
  };
};

export const breakdownHarnessCases = (
  cases: HarnessCaseExecutionResult[],
  key: "category" | "difficulty",
) => Object.fromEntries([...new Set(cases.map((item) => item[key]))].sort()
  .map((value) => [value, aggregateHarnessCases(cases.filter((item) => item[key] === value))]));

const executeCase = async (
  entry: DatasetCaseEntry,
  fixture: GovernedBenchmarkCaseFixture,
  options: DevHarnessRunOptions,
): Promise<HarnessCaseExecutionResult> => {
  const provider = options.providerFactory.create();
  let outcome;
  try {
    outcome = await provider.execute(observationRequest(fixture));
    if (provider.providerType !== options.providerFactory.executionMetadata.executionProvider) {
      throw new Error("EXECUTION_PROVIDER_METADATA_MISMATCH");
    }
    if (outcome.status !== "PASS" || !outcome.prediction) {
      throw new Error(outcome.error ?? "HARNESS_EXECUTION_FAILED");
    }
    const raw: BenchmarkRawInvestigationResult = {
      caseId: fixture.benchmarkCase.caseId,
      ...outcome.prediction,
    };
    const normalizedPrediction = normalizeInvestigationResult(raw);
    return {
      caseId: entry.caseId,
      category: entry.category,
      difficulty: entry.difficulty,
      execution: {
        status: "PASS",
        terminalInvestigationState: outcome.terminalInvestigationState,
        modelCallCount: normalizedPrediction.modelCallCount,
        toolCallCount: normalizedPrediction.toolCallCount,
      },
      normalizedPrediction,
      scoring: scoreInvestigationCase(fixture.benchmarkCase, normalizedPrediction),
    };
  } catch (caught) {
    const normalized = failurePrediction(fixture.benchmarkCase);
    return {
      caseId: entry.caseId,
      category: entry.category,
      difficulty: entry.difficulty,
      execution: {
        status: "FAIL",
        terminalInvestigationState: "FAILED",
        modelCallCount: 0,
        toolCallCount: 0,
        error: caught instanceof Error ? caught.message : String(caught),
      },
      normalizedPrediction: null,
      scoring: scoreInvestigationCase(fixture.benchmarkCase, normalized, { runtimeFailed: true }),
    };
  }
};

export async function runInvestigationBenchmarkHarness(
  dataset: InvestigationBenchmarkDatasetDefinition,
  options: DevHarnessRunOptions,
): Promise<DevHarnessReport> {
  const validation = await validateInvestigationBenchmarkDataset(dataset);
  if (!validation.valid || validation.status !== "PASS") {
    throw new Error(`DEV_DATASET_GOVERNANCE_FAILED: ${validation.status}`);
  }
  if (validation.expectedDatasetHash !== validation.calculatedDatasetHash) {
    throw new Error("DEV_DATASET_HASH_MISMATCH");
  }
  const fixtures = new Map(dataset.fixtures.map((fixture) => [fixture.fixtureRef, fixture]));
  const allEntries = dataset.manifest.caseEntries
    .filter((entry) => entry.enabled && entry.split === "DEV")
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  const entries = options.caseId
    ? allEntries.filter((entry) => entry.caseId === options.caseId)
    : allEntries;
  if (options.caseId && entries.length !== 1) throw new Error(`UNKNOWN_DEV_CASE: ${options.caseId}`);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const cases: HarnessCaseExecutionResult[] = [];
  for (const entry of entries) {
    const fixture = fixtures.get(entry.fixtureRef);
    if (!fixture) throw new Error(`MISSING_DEV_FIXTURE: ${entry.fixtureRef}`);
    cases.push(await executeCase(entry, fixture, options));
  }
  const completedAt = now();
  const reportWithoutHash = {
    label: options.providerFactory.executionMetadata.label,
    manifest: {
      runId: options.runId ?? crypto.randomUUID(),
      datasetId: dataset.manifest.datasetId,
      datasetVersion: dataset.manifest.version,
      datasetHash: validation.calculatedDatasetHash,
      evaluationContractVersion: dataset.manifest.evaluationContractVersion,
      sourceCommit: options.sourceCommit,
      executionProvider: options.providerFactory.executionMetadata.executionProvider,
      runtimeMode: options.providerFactory.executionMetadata.runtimeMode,
      enabledTools: [...ENABLED_TOOLS],
      modelConfiguration: options.providerFactory.executionMetadata.modelConfiguration,
      startedAt,
      completedAt,
      totalCases: cases.length,
      completedCases: cases.filter((item) => item.execution.status === "PASS").length,
      failedCases: cases.filter((item) => item.execution.status === "FAIL").length,
    },
    cases,
    aggregate: aggregateHarnessCases(cases),
    breakdown: {
      category: breakdownHarnessCases(cases, "category"),
      difficulty: breakdownHarnessCases(cases, "difficulty"),
    },
  };
  return {
    ...reportWithoutHash,
    semanticHash: await calculateHarnessSemanticHash(reportWithoutHash),
  };
}

export const runInvestigationBenchmarkDevHarness = (
  options: DevHarnessRunOptions,
) => runInvestigationBenchmarkHarness(loadInvestigationBenchmarkDevDataset(), options);

export const __testOnly = { observationRequest, aggregate: aggregateHarnessCases };
