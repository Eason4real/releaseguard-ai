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
import { HARNESS_TELEMETRY_SCHEMA_VERSION } from "./telemetry";
import { projectObservationSelector } from "./fixture-adapter";
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
      selector: projectObservationSelector({
        toolName: item.toolName,
        output: item.payload,
        metricKey: execution.agentInput.riskEvent?.metricKey ?? null,
        filters: execution.agentInput.riskEvent?.filters ?? {},
        releaseId: execution.agentInput.release?.id ?? null,
        releaseVersion: execution.agentInput.release?.version ?? null,
      }),
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
  const validationEvents = cases.flatMap((item) => item.telemetry?.plannerValidationEvents ?? []);
  const failedValidationEvents = validationEvents.filter((item) => item.outcome === "REPAIR_FAILED");
  const repairAttempts = validationEvents.filter((item) => item.outcome === "REPAIR_ATTEMPTED").length;
  const repairSuccesses = validationEvents.filter((item) => item.outcome === "REPAIRED").length;
  const acceptedPlannerDecisions = cases.reduce((sum, item) =>
    sum + (item.telemetry?.plannerActions.length ?? 0), 0);
  const plannerDecisionOutcomes = acceptedPlannerDecisions + failedValidationEvents.length;
  const firstAttemptSuccesses = Math.max(0, acceptedPlannerDecisions - repairSuccesses);
  const evaluableRootCauses = scores.filter((item) => item.rootCause.correct !== null);
  const tokenUsages = cases.flatMap((item) => item.normalizedPrediction?.tokenUsage
    ? [item.normalizedPrediction.tokenUsage]
    : []);
  const tokenValue = (key: "inputTokens" | "outputTokens" | "totalTokens") => {
    const values = tokenUsages.map((item) => item[key]);
    return values.length > 0 && values.every((value) => value !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
  };
  const errorTaxonomyCounts = {
    PLANNER_SCHEMA_ERROR: failedValidationEvents.filter((item) => item.validationKind === "SCHEMA").length,
    INVALID_PLANNER_DECISION: failedValidationEvents.filter((item) => item.validationKind === "SEMANTIC").length,
    RUNTIME_ERROR: 0,
  };
  for (const item of cases) {
    const category = item.execution.errorCategory;
    if (!category) continue;
    const itemFailures = item.telemetry?.plannerValidationEvents.filter((event) =>
      event.outcome === "REPAIR_FAILED") ?? [];
    const representedByTelemetry = category === "PLANNER_SCHEMA_ERROR"
      ? itemFailures.some((event) => event.validationKind === "SCHEMA")
      : category === "INVALID_PLANNER_DECISION"
        ? itemFailures.some((event) => event.validationKind === "SEMANTIC")
        : false;
    if (!representedByTelemetry) errorTaxonomyCounts[category] += 1;
  }
  const durations = cases.flatMap((item) => item.normalizedPrediction?.durationMs === undefined
    ? []
    : [item.normalizedPrediction.durationMs]);
  return {
    totalCases: cases.length,
    completedCases: cases.filter((item) =>
      item.execution.terminalInvestigationState === "FINALIZED").length,
    failedCases: cases.filter((item) => item.execution.status === "FAIL").length,
    inconclusiveCases: cases.filter((item) =>
      item.execution.terminalInvestigationState === "INCONCLUSIVE").length,
    rootCauseTop1Accuracy: base.rootCauseTop1Accuracy,
    rootCauseExactMatchAccuracy: evaluableRootCauses.length === 0 ? null
      : evaluableRootCauses.filter((item) => item.rootCause.matchedBy === "ID").length
        / evaluableRootCauses.length,
    rootCauseSemanticAccuracy: base.rootCauseTop1Accuracy,
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
    plannerValidationFailures: failedValidationEvents.length,
    plannerDecisionRepairAttempts: repairAttempts,
    plannerDecisionRepairSuccesses: repairSuccesses,
    plannerDecisionRepairRate: repairAttempts === 0 ? null : repairSuccesses / repairAttempts,
    plannerFirstAttemptSuccessRate: plannerDecisionOutcomes === 0
      ? null
      : firstAttemptSuccesses / plannerDecisionOutcomes,
    plannerFinalSuccessRate: plannerDecisionOutcomes === 0
      ? null
      : acceptedPlannerDecisions / plannerDecisionOutcomes,
    errorTaxonomyCounts,
    groundedContractMismatches: validationEvents.filter((item) =>
      item.validationCode === "FINALIZE_GROUNDED_CONTRACT_MISMATCH").length,
    tokenUsage: {
      inputTokens: tokenValue("inputTokens"),
      outputTokens: tokenValue("outputTokens"),
      totalTokens: tokenValue("totalTokens"),
      completeness: tokenUsages.length === 0
        ? "UNAVAILABLE"
        : tokenUsages.length === cases.length
          && tokenUsages.every((item) => item.completeness === "COMPLETE")
          ? "COMPLETE"
          : "PARTIAL",
    },
    totalDurationMs: durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0),
    estimatedOrActualCost: null,
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
        errorCategory: null,
      },
      normalizedPrediction,
      telemetry: outcome.telemetry ?? null,
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
        errorCategory: outcome?.errorCategory ?? "RUNTIME_ERROR",
      },
      normalizedPrediction: null,
      telemetry: outcome?.telemetry ?? null,
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
  const runId = options.runId ?? crypto.randomUUID();
  const cases: HarnessCaseExecutionResult[] = [];
  const createReport = async (
    reportStatus: DevHarnessReport["reportStatus"],
    completedAt: string | null,
  ): Promise<DevHarnessReport> => {
    const reportWithoutHash = {
      schemaVersion: "investigation-live-benchmark-report-v1" as const,
      reportStatus,
      label: options.providerFactory.executionMetadata.label,
      manifest: {
        runId,
        datasetId: dataset.manifest.datasetId,
        datasetVersion: dataset.manifest.version,
        datasetHash: validation.calculatedDatasetHash,
        evaluationContractVersion: dataset.manifest.evaluationContractVersion,
        telemetrySchemaVersion: HARNESS_TELEMETRY_SCHEMA_VERSION,
        sourceCommit: options.sourceCommit,
        executionProvider: options.providerFactory.executionMetadata.executionProvider,
        runtimeMode: options.providerFactory.executionMetadata.runtimeMode,
        enabledTools: [...ENABLED_TOOLS],
        modelConfiguration: options.providerFactory.executionMetadata.modelConfiguration,
        startedAt,
        completedAt,
        totalCases: entries.length,
        processedCases: cases.length,
        completedCases: cases.filter((item) =>
          item.execution.terminalInvestigationState === "FINALIZED").length,
        failedCases: cases.filter((item) => item.execution.status === "FAIL").length,
        inconclusiveCases: cases.filter((item) =>
          item.execution.terminalInvestigationState === "INCONCLUSIVE").length,
      },
      cases: structuredClone(cases),
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
  };
  for (const [index, entry] of entries.entries()) {
    const fixture = fixtures.get(entry.fixtureRef);
    if (!fixture) throw new Error(`MISSING_DEV_FIXTURE: ${entry.fixtureRef}`);
    options.onProgress?.({ index: index + 1, total: entries.length, caseId: entry.caseId, phase: "START" });
    const started = performance.now();
    const result = await executeCase(entry, fixture, options);
    cases.push(result);
    await options.onCheckpoint?.(await createReport("INCOMPLETE", null));
    options.onProgress?.({
      index: index + 1,
      total: entries.length,
      caseId: entry.caseId,
      phase: "END",
      terminalState: result.execution.terminalInvestigationState,
      modelCallCount: result.execution.modelCallCount,
      toolCallCount: result.execution.toolCallCount,
      durationMs: performance.now() - started,
    });
  }
  const completedAt = now();
  return createReport("COMPLETE", completedAt);
}

export const runInvestigationBenchmarkDevHarness = (
  options: DevHarnessRunOptions,
) => runInvestigationBenchmarkHarness(loadInvestigationBenchmarkDevDataset(), options);

export const __testOnly = { observationRequest, aggregate: aggregateHarnessCases };
