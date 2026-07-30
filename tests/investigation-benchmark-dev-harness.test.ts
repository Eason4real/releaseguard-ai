import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicHarnessProvider,
  __testOnly,
  createDeterministicHarnessProviderFactory,
  executeHarnessAgentRuntime,
  runInvestigationBenchmarkDevHarness,
  semanticHarnessReport,
  type HarnessAgentRequest,
  type HarnessExecutionProvider,
  type HarnessExecutionProviderFactory,
} from "../eval/investigation-benchmark/harness";
import {
  INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH,
  INVESTIGATION_BENCHMARK_DEV_VERSION,
  loadInvestigationBenchmarkDevDataset,
} from "../eval/investigation-benchmark/dataset/dev";

const sourceCommit = "e99b1059fee50c771262b74977682ed1ce7c6b2d";
const deterministicMetadata = {
  label: "Deterministic Harness Validation" as const,
  executionProvider: "HARNESS_PROVIDER" as const,
  runtimeMode: "DETERMINISTIC_NO_LIVE_MODEL" as const,
  modelConfiguration: "deterministic / no live model" as const,
};

class CapturingProvider implements HarnessExecutionProvider {
  readonly providerType = "HARNESS_PROVIDER" as const;
  constructor(
    private readonly requests: HarnessAgentRequest[],
    private readonly delegate = new DeterministicHarnessProvider(),
  ) {}
  execute(request: HarnessAgentRequest) {
    this.requests.push(structuredClone(request));
    return this.delegate.execute(request);
  }
}

const capturingFactory = (requests: HarnessAgentRequest[]): HarnessExecutionProviderFactory => ({
  executionMetadata: deterministicMetadata,
  create: () => new CapturingProvider(requests),
});

test("formal Dev harness executes all 22 cases in stable order with isolated providers", async () => {
  const requests: HarnessAgentRequest[] = [];
  let providerCount = 0;
  const factory: HarnessExecutionProviderFactory = {
    executionMetadata: deterministicMetadata,
    create() {
      providerCount += 1;
      return new CapturingProvider(requests);
    },
  };
  const report = await runInvestigationBenchmarkDevHarness({ sourceCommit, providerFactory: factory });

  assert.equal(report.label, "Deterministic Harness Validation");
  assert.equal(providerCount, 22);
  assert.equal(requests.length, 22);
  assert.deepEqual(report.cases.map((item) => item.caseId),
    Array.from({ length: 22 }, (_, index) => `CASE-${String(index + 201).padStart(3, "0")}`));
  assert.equal(report.aggregate.totalCases, 22);
  assert.equal(report.aggregate.completedCases + report.aggregate.failedCases, 22);
  assert.equal(report.manifest.datasetHash, INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH);
  assert.equal(report.manifest.datasetVersion, INVESTIGATION_BENCHMARK_DEV_VERSION);
  assert.equal(report.manifest.sourceCommit, sourceCommit);
  assert.equal(report.manifest.executionProvider, "HARNESS_PROVIDER");
  assert.equal(report.manifest.runtimeMode, "DETERMINISTIC_NO_LIVE_MODEL");
  assert.equal(report.manifest.modelConfiguration, "deterministic / no live model");
});

test("runtime adapter uses isolated shared AgentLoop state and existing read-only tools", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures[0];
  const request = __testOnly.observationRequest(fixture);
  const runA = await executeHarnessAgentRuntime(request);
  const runB = await executeHarnessAgentRuntime(request);

  assert.equal(runA.run.status, "INCONCLUSIVE");
  assert.equal(runA.run.plannerType, "DETERMINISTIC");
  assert.notEqual(runA.run.id, runB.run.id);
  assert.ok(runA.iterations.length >= 4);
  assert.ok(runA.toolCalls.length > 0);
  assert.ok(runA.toolCalls.every((item) => item.status === "COMPLETED"));
  assert.ok(runA.toolCalls.every((item) => item.resultId !== null));
  assert.ok(runA.evidence.length > 0);
  const secondEvidenceIds = new Set(runB.evidence.map((item) => item.id));
  assert.equal(runA.evidence.some((item) => secondEvidenceIds.has(item.id)), false);
});

test("Agent-visible requests use an exact whitelist and exclude benchmark answers and metadata", async () => {
  const requests: HarnessAgentRequest[] = [];
  const report = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: capturingFactory(requests),
    caseId: "CASE-201",
  });
  assert.equal(report.cases.length, 1);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.deepEqual(Object.keys(request).sort(), ["agentInput", "enabledTools", "observations"]);
  assert.deepEqual(Object.keys(request.agentInput).sort(),
    ["dataSources", "incidentId", "incidentQuestion", "release", "riskEvent"]);
  assert.ok(request.observations.every((item) =>
    Object.keys(item).sort().join(",")
      === "evidenceId,observationScope,output,sourceRef,status,toolName"));
  assert.ok(request.observations.every((item) => /^EV-\d{3,}$/.test(item.evidenceId)));
  assert.ok(request.agentInput.dataSources.every((item) => /^fixture:\/\/SRC-\d{3,}$/.test(item.sourceRef)));

  const serialized = JSON.stringify(request);
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures[0];
  for (const forbiddenField of [
    "caseId", "title", "category", "difficulty", "difficultyScore", "difficultyDimensions",
    "templateFamily", "split", "manualReview", "groundTruth", "canonicalRootCauseId",
    "canonicalRootCause", "acceptableAliases", "requiredEvidenceIds", "supportingEvidenceIds",
    "distractorEvidenceIds", "rootCauseEvaluation", "requiredConceptGroups", "optionalConcepts",
    "forbiddenConcepts", "uncertaintyPolicy", "specificityPolicy", "datasetId", "datasetVersion",
    "datasetHash", "fixtureRef", "role",
  ]) assert.doesNotMatch(serialized, new RegExp(`"${forbiddenField}"`));
  assert.equal(serialized.includes(INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH), false);
  assert.equal(serialized.includes(INVESTIGATION_BENCHMARK_DEV_VERSION), false);
  assert.equal(serialized.includes(fixture.benchmarkCase.groundTruth.canonicalRootCause), false);
  assert.equal(serialized.includes("HOLDOUT"), false);
});

test("provider input has no execution key or case metadata from which to select an answer", async () => {
  const requests: HarnessAgentRequest[] = [];
  await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: capturingFactory(requests),
    caseId: "CASE-202",
  });
  const request = requests[0] as HarnessAgentRequest & Record<string, unknown>;
  assert.equal(request.caseId, undefined);
  assert.equal(request.executionKey, undefined);
  assert.equal(request.groundTruth, undefined);
  assert.equal(request.datasetVersion, undefined);
  assert.equal(request.datasetHash, undefined);
});

test("runtime failure is reported separately and excluded from automatic accuracy", async () => {
  let creation = 0;
  const factory: HarnessExecutionProviderFactory = {
    executionMetadata: deterministicMetadata,
    create() {
      creation += 1;
      if (creation === 1) {
        return {
          providerType: "HARNESS_PROVIDER" as const,
          execute() { throw new Error("DETERMINISTIC_TEST_FAILURE"); },
        };
      }
      return new DeterministicHarnessProvider();
    },
  };
  const report = await runInvestigationBenchmarkDevHarness({ sourceCommit, providerFactory: factory });
  assert.equal(report.aggregate.totalCases, 22);
  assert.equal(report.aggregate.completedCases, 21);
  assert.equal(report.aggregate.failedCases, 1);
  assert.equal(report.cases[0].execution.status, "FAIL");
  assert.equal(report.cases[0].execution.terminalInvestigationState, "FAILED");
  assert.equal(report.cases[0].scoring.rootCause.correct, null);
  assert.equal(report.cases[0].scoring.rootCause.evaluationStatus, "RUNTIME_FAILED");
  assert.equal(report.aggregate.runtimeFailedCases, 1);
  assert.equal(report.aggregate.automaticallyEvaluatedCases
    + report.aggregate.reviewRequiredCases + report.aggregate.runtimeFailedCases, 22);
});

test("an explicit matching insufficient diagnosis is correct while an exception is not", async () => {
  const dataset = loadInvestigationBenchmarkDevDataset();
  const fixture = dataset.fixtures.find((item) => item.benchmarkCase.caseId === "CASE-219")!;
  const groundTruth = fixture.benchmarkCase.groundTruth;
  const correctFactory: HarnessExecutionProviderFactory = {
    executionMetadata: deterministicMetadata,
    create: () => ({
      providerType: "HARNESS_PROVIDER" as const,
      execute(request) {
        return {
          status: "PASS" as const,
          terminalInvestigationState: "INCONCLUSIVE" as const,
          prediction: {
            predictedRootCause: groundTruth.canonicalRootCause,
            predictedRootCauseId: null,
            citedEvidenceIds: request.observations.map((item) => item.evidenceId),
            diagnosisClaims: [],
            modelCallCount: 0,
            toolCallCount: request.observations.length,
          },
        };
      },
    }),
  };
  const correct = await runInvestigationBenchmarkDevHarness({
    sourceCommit, providerFactory: correctFactory, caseId: "CASE-219",
  });
  const failed = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    caseId: "CASE-219",
    providerFactory: { executionMetadata: deterministicMetadata, create: () => ({
      providerType: "HARNESS_PROVIDER" as const,
      execute() { throw new Error("NO_RESULT"); },
    }) },
  });
  assert.equal(correct.cases[0].scoring.rootCause.correct, true);
  assert.equal(correct.cases[0].execution.terminalInvestigationState, "INCONCLUSIVE");
  assert.equal(failed.cases[0].scoring.rootCause.correct, null);
  assert.equal(failed.cases[0].scoring.rootCause.evaluationStatus, "RUNTIME_FAILED");
  assert.equal(failed.cases[0].execution.terminalInvestigationState, "FAILED");
});

test("single-case debugging rejects unknown IDs and preserves dataset identity", async () => {
  const report = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: createDeterministicHarnessProviderFactory(),
    caseId: "CASE-222",
  });
  assert.deepEqual(report.cases.map((item) => item.caseId), ["CASE-222"]);
  assert.equal(report.manifest.totalCases, 1);
  assert.equal(report.manifest.datasetHash, INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH);
  await assert.rejects(runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: createDeterministicHarnessProviderFactory(),
    caseId: "CASE-999",
  }), /UNKNOWN_DEV_CASE/);
});

test("Run A and Run B have identical normalized results, scores, aggregates, and semantic hash", async () => {
  const timesA = ["2031-03-01T00:00:00.000Z", "2031-03-01T00:00:01.000Z"];
  const timesB = ["2031-03-02T00:00:00.000Z", "2031-03-02T00:00:09.000Z"];
  const runA = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: createDeterministicHarnessProviderFactory(),
    runId: "RUN-A",
    now: () => timesA.shift()!,
  });
  const runB = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: createDeterministicHarnessProviderFactory(),
    runId: "RUN-B",
    now: () => timesB.shift()!,
  });
  assert.deepEqual(runA.cases.map((item) => item.normalizedPrediction),
    runB.cases.map((item) => item.normalizedPrediction));
  assert.deepEqual(runA.cases.map((item) => item.scoring),
    runB.cases.map((item) => item.scoring));
  assert.deepEqual(runA.aggregate, runB.aggregate);
  assert.deepEqual(runA.breakdown, runB.breakdown);
  assert.equal(runA.semanticHash, runB.semanticHash);
  assert.deepEqual(semanticHarnessReport(runA), semanticHarnessReport(runB));
  assert.notEqual(runA.manifest.runId, runB.manifest.runId);
  assert.notEqual(runA.manifest.startedAt, runB.manifest.startedAt);
});

test("default fixture provider exposes deterministic citation edge cases to unchanged scorer semantics", async () => {
  const report = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: createDeterministicHarnessProviderFactory(),
    caseId: "CASE-201",
  });
  const result = report.cases[0];
  assert.equal(result.scoring.evidence.citedCount, 2);
  assert.equal(result.scoring.evidence.relevantCount, 1);
  assert.equal(result.scoring.evidence.precision, 1 / 2);
  assert.deepEqual(result.scoring.evidence.duplicateEvidenceIds,
    [...new Set(result.normalizedPrediction?.citedEvidenceIds)]);
  assert.deepEqual(result.scoring.evidence.unknownEvidenceIds, []);
  assert.equal(result.scoring.grounding.status, "EVALUABLE");
});
