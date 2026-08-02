import assert from "node:assert/strict";
import test from "node:test";
import type { InvestigationPlanner } from "../lib/investigation/planner";
import type { InvestigationAggregate } from "../lib/investigation/types";
import type { LiveEvalObservability } from "../eval/support/live-eval-store";
import {
  DeterministicHarnessProvider,
  __testOnly,
  createDeterministicHarnessProviderFactory,
  executeHarnessAgentRuntime,
  runInvestigationBenchmarkDevHarness,
  sanitizeTelemetryValue,
  telemetryFromAggregate,
  semanticHarnessReport,
  type HarnessAgentRequest,
  type HarnessExecutionProvider,
  type HarnessExecutionProviderFactory,
  type HarnessExecutionTelemetry,
  type HarnessFixtureExecutionRecord,
} from "../eval/investigation-benchmark/harness";
import { benchmarkEvidenceMap } from
  "../eval/investigation-benchmark/harness/fixture-adapter";
import { projectInconclusivePrediction } from
  "../eval/investigation-benchmark/harness/inconclusive-prediction";
import { __testOnlyLiveProvider } from
  "../eval/investigation-benchmark/harness/live-provider";
import { __testOnlyDeterministicProvider } from
  "../eval/investigation-benchmark/harness/provider";
import {
  INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH,
  INVESTIGATION_BENCHMARK_DEV_VERSION,
  loadInvestigationBenchmarkDevDataset,
} from "../eval/investigation-benchmark/dataset/dev";
import { scoreRootCauseSemantics } from
  "../eval/investigation-benchmark/root-cause-semantic-scorer";
import type { InvestigationGroundTruth } from "../eval/investigation-benchmark/types";

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

const scriptedToolPlanner = (
  calls: Array<{ toolName: string; arguments: Record<string, unknown> }>,
): InvestigationPlanner => ({
  type: "DETERMINISTIC",
  async plan(context) {
    const hypotheses = context.aggregate.hypotheses.filter((item) => item.status !== "REJECTED");
    if (hypotheses.length === 0) {
      return {
        type: "CREATE_HYPOTHESES",
        hypotheses: [{
          statement: "The public fixture observations support a test-only hypothesis.",
          supportIf: "A compatible public selector returns an observation.",
          refuteIf: "No compatible public selector returns an observation.",
        }],
        rationale: "Create one deterministic test hypothesis.",
      };
    }
    const assessed = new Set(context.aggregate.hypothesisEvidenceLinks.map((item) => item.evidenceId));
    const pending = context.aggregate.evidence.filter((item) => !assessed.has(item.id));
    if (pending.length > 0) {
      return {
        type: "ASSESS_EVIDENCE",
        assessments: pending.map((evidence) => ({
          evidenceId: evidence.id,
          relations: hypotheses.map((hypothesis) => ({
            targetHypothesisId: hypothesis.id,
            relation: "NEUTRAL" as const,
            explanation: "Record the fixture observation without deriving an answer label.",
          })),
        })),
        rationale: "Assess every persisted observation.",
      };
    }
    const executed = context.aggregate.toolCalls.filter((item) => item.proposedActionId === null).length;
    const next = calls[executed];
    if (next) {
      return {
        type: "CALL_TOOL",
        toolName: next.toolName,
        arguments: next.arguments,
        targetHypothesisIds: hypotheses.map((item) => item.id),
        testIntent: "SUPPORT",
        rationale: "Execute the next deterministic selector test.",
      };
    }
    return {
      type: "STOP_INCONCLUSIVE",
      reasonCode: "INSUFFICIENT_EVIDENCE",
      reason: "The fixture selector test is complete.",
      rationale: "End the bounded offline test.",
    };
  },
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
  assert.equal(report.aggregate.completedCases + report.aggregate.failedCases
    + report.aggregate.inconclusiveCases, 22);
  assert.equal(report.schemaVersion, "investigation-live-benchmark-report-v1");
  assert.equal(report.reportStatus, "COMPLETE");
  assert.equal(report.manifest.processedCases, 22);
  assert.equal(report.manifest.datasetHash, INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH);
  assert.equal(report.manifest.datasetVersion, INVESTIGATION_BENCHMARK_DEV_VERSION);
  assert.equal(report.manifest.sourceCommit, sourceCommit);
  assert.equal(report.manifest.executionProvider, "HARNESS_PROVIDER");
  assert.equal(report.manifest.runtimeMode, "DETERMINISTIC_NO_LIVE_MODEL");
  assert.equal(report.manifest.modelConfiguration, "deterministic / no live model");
  assert.ok(report.cases.every((item) => item.telemetry?.schemaVersion
    === "benchmark-observability-v3"));
  assert.ok(report.cases.every((item) => /^[a-f0-9]{64}$/.test(
    item.telemetry?.telemetryIdentity ?? "",
  )));
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

test("fixture matching rejects a wrong segment dimension without consuming the observation", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures.find((item) =>
    item.benchmarkCase.caseId === "CASE-206")!;
  const request = __testOnly.observationRequest(fixture);
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan(context) {
      const hypotheses = context.aggregate.hypotheses.filter((item) => item.status !== "REJECTED");
      if (hypotheses.length === 0) {
        return {
          type: "CREATE_HYPOTHESES",
          hypotheses: [{
            statement: "The exposed new-user cohort is affected by the rollout.",
            supportIf: "The matching user-type segment observation is available.",
            refuteIf: "The matching user-type segment observation is unavailable.",
          }],
          rationale: "Create a test-only hypothesis.",
        };
      }
      const assessed = new Set(context.aggregate.hypothesisEvidenceLinks.map((item) => item.evidenceId));
      const pending = context.aggregate.evidence.filter((item) => !assessed.has(item.id));
      if (pending.length > 0) {
        return {
          type: "ASSESS_EVIDENCE",
          assessments: pending.map((evidence) => ({
            evidenceId: evidence.id,
            relations: hypotheses.map((hypothesis) => ({
              targetHypothesisId: hypothesis.id,
              relation: "SUPPORTS" as const,
              explanation: "The matching segment observation supports the hypothesis.",
            })),
          })),
          rationale: "Assess matched evidence.",
        };
      }
      const calls = context.aggregate.toolCalls.filter((item) => item.proposedActionId === null);
      const risk = context.aggregate.riskEvent!;
      if (calls.length < 2) {
        return {
          type: "CALL_TOOL",
          toolName: "segment_metric",
          arguments: {
            metric_key: risk.metricKey,
            start_time: risk.firstBreachedAt,
            end_time: risk.lastBreachedAt,
            filters: risk.filters,
            dimension: calls.length === 0 ? "region" : "user_type",
          },
          targetHypothesisIds: hypotheses.map((item) => item.id),
          testIntent: "SUPPORT",
          rationale: "Exercise incompatible and compatible selectors in order.",
        };
      }
      return {
        type: "STOP_INCONCLUSIVE",
        reasonCode: "INSUFFICIENT_EVIDENCE",
        reason: "Selector behavior has been observed.",
        rationale: "End the bounded fixture test.",
      };
    },
  };

  let matches: HarnessFixtureExecutionRecord[] = [];
  const aggregate = await executeHarnessAgentRuntime(request, {
    planner,
    maxIterations: 8,
    maxToolCalls: 2,
    onFixtureExecutions: (value) => { matches = value; },
  });
  const results = aggregate.toolCalls.map((call) => call.result?.status);
  assert.deepEqual(results, ["EMPTY", "SUCCESS"]);
  assert.equal(aggregate.evidence.length, 1);
  assert.equal(aggregate.evidence[0].category, "SEGMENT_METRIC");
  assert.equal(aggregate.evidence[0].source, "Benchmark Fixture");
  assert.equal(aggregate.evidence[0].provenance, "synthetic");
  assert.equal(matches[0].matched, false);
  assert.equal(matches[0].benchmarkEvidenceId, null);
  assert.equal(matches[0].matchedObservationId, null);
  assert.equal(matches[1].matched, true);
  assert.equal(matches[1].benchmarkEvidenceId,
    request.observations.find((item) => item.toolName === "segment_metric")!.evidenceId);
  assert.equal(benchmarkEvidenceMap(aggregate, matches).size, 1);
});

test("app-version selection cannot consume a platform observation or shift its citation", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures.find((item) =>
    item.benchmarkCase.caseId === "CASE-219")!;
  const base = __testOnly.observationRequest(fixture);
  const risk = base.agentInput.riskEvent!;
  const platform = base.observations.find((item) =>
    item.toolName === "segment_metric" && item.selector.dimension === "platform")!;
  const request = { ...base, observations: [platform] };
  const common = {
    metric_key: risk.metricKey,
    start_time: risk.firstBreachedAt,
    end_time: risk.lastBreachedAt,
    filters: risk.filters,
  };
  let records: HarnessFixtureExecutionRecord[] = [];
  const aggregate = await executeHarnessAgentRuntime(request, {
    planner: scriptedToolPlanner([
      { toolName: "segment_metric", arguments: { ...common, dimension: "app_version" } },
      { toolName: "segment_metric", arguments: { ...common, dimension: "platform" } },
    ]),
    maxIterations: 8,
    maxToolCalls: 2,
    onFixtureExecutions: (value) => { records = value; },
  });
  assert.deepEqual(aggregate.toolCalls.map((call) => call.result?.status), ["EMPTY", "SUCCESS"]);
  assert.deepEqual(records.map((item) => item.benchmarkEvidenceId), [null, platform.evidenceId]);
  assert.deepEqual([...benchmarkEvidenceMap(aggregate, records).values()], [platform.evidenceId]);
});

test("fixture Evidence uses production release and metric categories", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures.find((item) =>
    item.benchmarkCase.caseId === "CASE-202")!;
  const aggregate = await executeHarnessAgentRuntime(__testOnly.observationRequest(fixture));
  assert.deepEqual(aggregate.evidence.map((item) => item.category),
    ["RELEASE_CHANGE", "PRODUCT_METRIC"]);
  assert.ok(aggregate.evidence.every((item) => item.source === "Benchmark Fixture"));
  assert.ok(aggregate.evidence.every((item) => item.provenance === "synthetic"));
});

test("all fixture tools map to production categories with fixture provenance", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures.find((item) =>
    item.benchmarkCase.caseId === "CASE-202")!;
  const base = __testOnly.observationRequest(fixture);
  const risk = base.agentInput.riskEvent!;
  const release = base.agentInput.release!;
  const request: HarnessAgentRequest = {
    ...base,
    observations: [
      { evidenceId: "EV-15001", sourceRef: "fixture://SRC-15001", toolName: "get_release",
        observationScope: "CURRENT_INCIDENT", status: "SUCCESS",
        selector: { releaseId: release.id }, output: { data: { id: release.id } } },
      { evidenceId: "EV-15002", sourceRef: "fixture://SRC-15002", toolName: "query_metric",
        observationScope: "CURRENT_INCIDENT", status: "SUCCESS",
        selector: { metricKey: risk.metricKey, platform: "Web" }, output: { data: { metric: risk.metricKey } } },
      { evidenceId: "EV-15003", sourceRef: "fixture://SRC-15003", toolName: "segment_metric",
        observationScope: "CURRENT_INCIDENT", status: "SUCCESS",
        selector: { metricKey: risk.metricKey, dimension: "region", platform: "Web" },
        output: { data: { dimension: "region", breakdown: [] } } },
      { evidenceId: "EV-15004", sourceRef: "fixture://SRC-15004", toolName: "search_user_feedback",
        observationScope: "CURRENT_INCIDENT", status: "SUCCESS",
        selector: { metricKey: risk.metricKey, platform: "Web" }, output: { matches: [] } },
      { evidenceId: "EV-15005", sourceRef: "fixture://SRC-15005", toolName: "search_similar_incidents",
        observationScope: "HISTORICAL", status: "SUCCESS",
        selector: { metricKey: risk.metricKey, platform: "Web" }, output: { matches: [] } },
    ],
  };
  const commonMetricArgs = {
    metric_key: risk.metricKey,
    start_time: risk.firstBreachedAt,
    end_time: risk.lastBreachedAt,
    filters: { platform: "Web" },
  };
  const aggregate = await executeHarnessAgentRuntime(request, {
    planner: scriptedToolPlanner([
      { toolName: "get_release", arguments: { release_id: release.id } },
      { toolName: "query_metric", arguments: { ...commonMetricArgs, granularity_minutes: 5 } },
      { toolName: "segment_metric", arguments: { ...commonMetricArgs, dimension: "region" } },
      { toolName: "search_user_feedback", arguments: { query: "search timeout", platform: "Web" } },
      { toolName: "search_similar_incidents", arguments: {
        query: "search timeout", metricKey: risk.metricKey, platform: "Web",
      } },
    ]),
    maxIterations: 14,
    maxToolCalls: 5,
  });
  assert.deepEqual(aggregate.evidence.map((item) => item.category), [
    "RELEASE_CHANGE", "PRODUCT_METRIC", "SEGMENT_METRIC", "USER_FEEDBACK", "SIMILAR_INCIDENT",
  ]);
  assert.ok(aggregate.evidence.every((item) => item.source === "Benchmark Fixture"));
  assert.ok(aggregate.evidence.every((item) => item.provenance === "synthetic"));
});

test("a matching metric observation satisfies unchanged grounded Finalize validation", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures.find((item) =>
    item.benchmarkCase.caseId === "CASE-202")!;
  const request = __testOnly.observationRequest(fixture);
  const rootCause = "The search release changed timeout handling.";
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan(context) {
      const hypothesis = context.aggregate.hypotheses.find((item) => item.status !== "REJECTED");
      if (!hypothesis) {
        return {
          type: "CREATE_HYPOTHESES",
          hypotheses: [{
            statement: rootCause,
            supportIf: "The affected metric observation confirms the decline.",
            refuteIf: "The affected metric observation is unavailable.",
          }],
          rationale: "Create a deterministic grounding hypothesis.",
        };
      }
      const metricEvidence = context.aggregate.evidence.find((item) =>
        item.category === "PRODUCT_METRIC");
      if (!context.aggregate.toolCalls.some((item) => item.name === "query_metric")) {
        const risk = context.aggregate.riskEvent!;
        return {
          type: "CALL_TOOL",
          toolName: "query_metric",
          arguments: {
            metric_key: risk.metricKey,
            start_time: risk.firstBreachedAt,
            end_time: risk.lastBreachedAt,
            filters: risk.filters,
            granularity_minutes: 5,
            include_baseline: true,
          },
          targetHypothesisIds: [hypothesis.id],
          testIntent: "SUPPORT",
          rationale: "Collect the matching metric observation.",
        };
      }
      const assessed = metricEvidence && context.aggregate.hypothesisEvidenceLinks.some((item) =>
        item.evidenceId === metricEvidence.id && item.hypothesisId === hypothesis.id);
      if (metricEvidence && !assessed) {
        return {
          type: "ASSESS_EVIDENCE",
          assessments: [{
            evidenceId: metricEvidence.id,
            relations: [{
              targetHypothesisId: hypothesis.id,
              relation: "SUPPORTS",
              explanation: "The current product metric supports the selected hypothesis.",
            }],
          }],
          rationale: "Assess the metric evidence before finalization.",
        };
      }
      assert.ok(metricEvidence);
      return {
        type: "FINALIZE",
        selectedHypothesisId: hypothesis.id,
        diagnosis: {
          summary: "The current metric decline supports the selected release hypothesis.",
          claims: [{ type: "ROOT_CAUSE", statement: rootCause, evidenceIds: [metricEvidence.id] }, {
            type: "AFFECTED_METRIC",
            statement: "Search completion rate declined during the incident window.",
            evidenceIds: [metricEvidence.id],
          }],
        },
        disposition: "OBSERVE",
        rationale: "Finalize with current metric evidence.",
      };
    },
  };
  let observability: LiveEvalObservability | undefined;
  const aggregate = await executeHarnessAgentRuntime(request, {
    planner,
    maxIterations: 6,
    maxToolCalls: 1,
    onObservability: (value) => { observability = value; },
  });
  assert.equal(aggregate.run.status, "WAITING_VERIFICATION");
  assert.ok(aggregate.diagnosis);
  const telemetry = telemetryFromAggregate(request, aggregate, [], observability);
  assert.equal(telemetry.plannerValidationEvents.some((item) =>
    item.validationSubcode === "INVALID_METRIC_GROUNDING"), false);
});

test("actual execution records preserve reverse selector order and deterministic citation mapping", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures.find((item) =>
    item.benchmarkCase.caseId === "CASE-208")!;
  const base = __testOnly.observationRequest(fixture);
  const risk = base.agentInput.riskEvent!;
  const request: HarnessAgentRequest = {
    ...base,
    observations: [{
      evidenceId: "EV-15101", sourceRef: "fixture://SRC-15101", toolName: "segment_metric",
      observationScope: "CURRENT_INCIDENT", status: "SUCCESS",
      selector: { metricKey: risk.metricKey, dimension: "app_version", platform: "Android" },
      output: { data: { dimension: "app_version", breakdown: [{ value: "10.4", rate: 0.43 }] } },
    }, {
      evidenceId: "EV-15102", sourceRef: "fixture://SRC-15102", toolName: "segment_metric",
      observationScope: "CURRENT_INCIDENT", status: "SUCCESS",
      selector: { metricKey: risk.metricKey, dimension: "region", platform: "Android" },
      output: { data: { dimension: "region", breakdown: [{ value: "AU", rate: 0.42 }] } },
    }],
  };
  const common = {
    metric_key: risk.metricKey,
    start_time: risk.firstBreachedAt,
    end_time: risk.lastBreachedAt,
    filters: { platform: "Android" },
  };
  const execute = async () => {
    let records: HarnessFixtureExecutionRecord[] = [];
    const aggregate = await executeHarnessAgentRuntime(request, {
      planner: scriptedToolPlanner([
        { toolName: "segment_metric", arguments: { ...common, dimension: "region" } },
        { toolName: "segment_metric", arguments: { ...common, dimension: "app_version" } },
      ]),
      maxIterations: 8,
      maxToolCalls: 2,
      onFixtureExecutions: (value) => { records = value; },
    });
    return { aggregate, records, citations: benchmarkEvidenceMap(aggregate, records) };
  };
  const first = await execute();
  const second = await execute();
  assert.deepEqual(first.records.map((item) => item.benchmarkEvidenceId), ["EV-15102", "EV-15101"]);
  assert.deepEqual(first.records.map((item) => item.matchedObservationId),
    ["HARNESS-OBS-002", "HARNESS-OBS-001"]);
  assert.deepEqual([...first.citations.values()], ["EV-15102", "EV-15101"]);
  assert.deepEqual(__testOnlyDeterministicProvider.citedEvidenceIdsFromAggregate(
    first.aggregate, first.records,
  ), ["EV-15102", "EV-15101"]);
  assert.deepEqual([...__testOnlyLiveProvider.evidenceIdMap(
    first.aggregate, first.records,
  ).values()], ["EV-15102", "EV-15101"]);
  const stableRecord = (item: HarnessFixtureExecutionRecord) => ({
    ...item,
    toolCallId: null,
    toolResultId: null,
  });
  assert.deepEqual(first.records.map(stableRecord), second.records.map(stableRecord));
  assert.deepEqual([...first.citations.values()], [...second.citations.values()]);
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
      === "evidenceId,observationScope,output,selector,sourceRef,status,toolName"));
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
  assert.equal(report.aggregate.completedCases, 0);
  assert.equal(report.aggregate.failedCases, 1);
  assert.equal(report.aggregate.inconclusiveCases, 21);
  assert.equal(report.cases[0].execution.status, "FAIL");
  assert.equal(report.cases[0].execution.terminalInvestigationState, "FAILED");
  assert.equal(report.cases[0].telemetry, null);
  assert.equal(report.cases[0].scoring.rootCause.correct, null);
  assert.equal(report.cases[0].scoring.rootCause.evaluationStatus, "RUNTIME_FAILED");
  assert.equal(report.aggregate.runtimeFailedCases, 1);
  assert.equal(report.cases[0].execution.errorCategory, "RUNTIME_ERROR");
  assert.equal(report.aggregate.errorTaxonomyCounts.RUNTIME_ERROR, 1);
  assert.equal(report.aggregate.automaticallyEvaluatedCases
    + report.aggregate.reviewRequiredCases + report.aggregate.runtimeFailedCases, 22);
});

test("CASE-208 persists inconclusive reason and planner validation repair metrics", async () => {
  const dataset = loadInvestigationBenchmarkDevDataset();
  const fixture = dataset.fixtures.find((item) => item.benchmarkCase.caseId === "CASE-208")!;
  const telemetry = {
    schemaVersion: "benchmark-observability-v3",
    plannerActions: ["FINALIZE", "STOP_INCONCLUSIVE"],
    schemaRepairCount: 1,
    plannerStopDecision: {
      iteration: 2,
      reasonCode: "INSUFFICIENT_EVIDENCE",
      reason: "The grounded finalization contract still fails after bounded repair.",
      rationale: "Stop with the collected evidence and report the validation failure.",
    },
    plannerValidationEvents: [{
      iteration: 1,
      attemptIndex: 0,
      outcome: "REPAIR_ATTEMPTED",
      validationKind: "SEMANTIC",
      decisionType: "FINALIZE",
      validationCode: "FINALIZE_GROUNDED_CONTRACT_MISMATCH",
      validationPath: "diagnosis",
      validationSubcode: "ROOT_CAUSE_HYPOTHESIS_MISMATCH",
      responseHash: "a".repeat(64),
      responseStructure: null,
    }, {
      iteration: 1,
      attemptIndex: 1,
      outcome: "REPAIR_FAILED",
      validationKind: "SEMANTIC",
      decisionType: "FINALIZE",
      validationCode: "FINALIZE_GROUNDED_CONTRACT_MISMATCH",
      validationPath: "diagnosis",
      validationSubcode: "ROOT_CAUSE_HYPOTHESIS_MISMATCH",
      responseHash: "b".repeat(64),
      responseStructure: null,
    }],
  } as HarnessExecutionTelemetry;
  const report = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    caseId: "CASE-208",
    providerFactory: {
      executionMetadata: deterministicMetadata,
      create: () => ({
        providerType: "HARNESS_PROVIDER" as const,
        execute: () => ({
          status: "PASS" as const,
          terminalInvestigationState: "INCONCLUSIVE" as const,
          prediction: {
            predictedRootCause: fixture.benchmarkCase.groundTruth.canonicalRootCause,
            predictedRootCauseId: null,
            diagnosisClaims: [],
            modelCallCount: 2,
            toolCallCount: 0,
          },
          telemetry,
        }),
      }),
    },
  });

  assert.equal(report.cases[0].caseId, "CASE-208");
  assert.equal(report.cases[0].execution.terminalInvestigationState, "INCONCLUSIVE");
  assert.deepEqual(report.cases[0].telemetry?.plannerStopDecision,
    telemetry.plannerStopDecision);
  assert.equal(report.aggregate.inconclusiveCases, 1);
  assert.equal(report.aggregate.completedCases, 0);
  assert.equal(report.aggregate.plannerValidationFailures, 1);
  assert.equal(report.aggregate.plannerDecisionRepairAttempts, 1);
  assert.equal(report.aggregate.plannerDecisionRepairSuccesses, 0);
  assert.equal(report.aggregate.plannerDecisionRepairRate, 0);
  assert.equal(report.aggregate.errorTaxonomyCounts.INVALID_PLANNER_DECISION, 1);
  assert.equal(report.aggregate.groundedContractMismatches, 2);
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
  assert.deepEqual(runA.cases.map((item) => item.telemetry?.telemetryIdentity),
    runB.cases.map((item) => item.telemetry?.telemetryIdentity));
  assert.deepEqual(runA.cases.map((item) => item.telemetry?.plannerActions),
    runB.cases.map((item) => item.telemetry?.plannerActions));
  assert.deepEqual(semanticHarnessReport(runA), semanticHarnessReport(runB));
  assert.notEqual(runA.manifest.runId, runB.manifest.runId);
  assert.notEqual(runA.manifest.startedAt, runB.manifest.startedAt);
});

test("telemetry preserves execution order, sanitizes values, and marks unavailable history", async () => {
  const progress: Array<Record<string, unknown>> = [];
  const report = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: createDeterministicHarnessProviderFactory(),
    caseId: "CASE-201",
    onProgress: (event) => progress.push(event),
  });
  const telemetry = report.cases[0].telemetry!;
  assert.deepEqual(progress.map((item) => item.phase), ["START", "END"]);
  assert.deepEqual(telemetry.iterations.map((item) => item.sequence),
    [...telemetry.iterations.map((item) => item.sequence)].sort((a, b) => a - b));
  assert.deepEqual(telemetry.toolTrajectory.map((item) => item.order),
    [...telemetry.toolTrajectory.map((item) => item.order)].sort((a, b) => a - b));
  assert.ok((telemetry.hypothesisTransitions?.length ?? 0) >= 2);
  assert.equal(telemetry.hypothesisTransitions?.[0].before, null);
  assert.ok(telemetry.hypothesisTransitions?.some((item) => item.before !== null));
  assert.equal(telemetry.unavailableFields.includes(
    "hypothesisTransitions.confidenceBeforeAfter",
  ), false);
  assert.equal(telemetry.terminalState, "INCONCLUSIVE");
  assert.equal(telemetry.modelCallCount, report.cases[0].execution.modelCallCount);
  assert.equal(telemetry.toolCallCount, report.cases[0].execution.toolCallCount);

  const sanitized = sanitizeTelemetryValue({
    metric_key: "conversion_rate",
    apiKey: "secret-value",
    nested: { Authorization: "Bearer secret-value", safe: "secret-value" },
    groundTruth: { canonicalRootCauseId: "RC-999" },
    requiredConceptGroups: ["must-not-persist"],
  }, ["secret-value"]);
  assert.deepEqual(sanitized, {
    metric_key: "conversion_rate",
    nested: { safe: "[REDACTED]" },
  });
  const serialized = JSON.stringify(telemetry);
  for (const forbidden of [
    "groundTruth", "canonicalRootCauseId", "requiredConceptGroups", "semanticRubric",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);

  const fixture = loadInvestigationBenchmarkDevDataset().fixtures[0];
  const request = __testOnly.observationRequest(fixture);
  request.observations[0].output = {
    data: { safe: true },
    groundTruth: "must-not-persist",
    Authorization: "Bearer secret-value",
  };
  const aggregate = await executeHarnessAgentRuntime(request);
  const aggregateBeforeProjection = structuredClone(aggregate);
  const projected = telemetryFromAggregate(request, aggregate, ["secret-value"]);
  assert.equal(projected.guardEvents, null);
  assert.ok(projected.unavailableFields.includes("guardEvents"));
  assert.equal(projected.hypothesisTransitions, null);
  assert.ok(projected.unavailableFields.includes("hypothesisTransitions.confidenceBeforeAfter"));
  assert.deepEqual(aggregate, aggregateBeforeProjection);
  assert.deepEqual(projected.toolTrajectory[0].observationMetadata.topLevelKeys, ["data"]);
  assert.equal(JSON.stringify(projected).includes("must-not-persist"), false);
  assert.equal(JSON.stringify(projected).includes("secret-value"), false);
  assert.equal(JSON.stringify(semanticHarnessReport(report)).includes("telemetryIdentity"), false);
  assert.equal(JSON.stringify(semanticHarnessReport(report)).includes("guardEvents"), false);
  assert.equal(JSON.stringify(semanticHarnessReport(report)).includes("plannerValidationEvents"), false);
});

test("planner validation events are stable, sanitized telemetry-only projections", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures[0];
  const request = __testOnly.observationRequest(fixture);
  const aggregate = await executeHarnessAgentRuntime(request);
  const template = aggregate.auditEvents[0];
  assert.ok(template);
  aggregate.auditEvents.push({
    ...template,
    id: "AE-VALIDATION-1",
    type: "PLANNER_DECISION_REPAIR_ATTEMPTED",
    actor: "LLM_PLANNER",
    details: {
      iterationSequence: 4,
      attemptIndex: 0,
      decisionType: "FINALIZE",
      validationKind: "SEMANTIC",
      validationCode: "FINALIZE_GROUNDED_CONTRACT_MISMATCH",
      validationPath: "diagnosis",
      validationSubcode: "ROOT_CAUSE_HYPOTHESIS_MISMATCH",
      responseHash: "a".repeat(64),
      response: "must-not-persist",
      prompt: "must-not-persist",
      responseStructure: {
        raw: {
          topLevelKeys: ["type", "diagnosis", "groundTruth", "Authorization"],
          shape: { type: "string", apiKey: "string", canonicalRootCauseId: "string" },
        },
        normalized: { topLevelKeys: ["type", "diagnosis"] },
      },
    },
  }, {
    ...template,
    id: "AE-VALIDATION-2",
    type: "PLANNER_DECISION_REPAIR_FAILED",
    actor: "LLM_PLANNER",
    details: {
      iterationSequence: 4,
      attemptIndex: 1,
      decisionType: "FINALIZE",
      validationKind: "SCHEMA",
      validationCode: "INVALID_FIELD_VALUE",
      validationPath: "diagnosis.claims",
      responseHash: "b".repeat(64),
      responseStructure: null,
    },
  });

  const telemetryA = telemetryFromAggregate(request, aggregate, ["must-not-persist"]);
  const telemetryB = telemetryFromAggregate(request, aggregate, ["must-not-persist"]);
  assert.deepEqual(telemetryA.plannerValidationEvents.map((item) => ({
    iteration: item.iteration,
    attemptIndex: item.attemptIndex,
    outcome: item.outcome,
    validationKind: item.validationKind,
    decisionType: item.decisionType,
    validationCode: item.validationCode,
    validationPath: item.validationPath,
    validationSubcode: item.validationSubcode,
    responseHash: item.responseHash,
  })), [{
    iteration: 4,
    attemptIndex: 0,
    outcome: "REPAIR_ATTEMPTED",
    validationKind: "SEMANTIC",
    decisionType: "FINALIZE",
    validationCode: "FINALIZE_GROUNDED_CONTRACT_MISMATCH",
    validationPath: "diagnosis",
    validationSubcode: "ROOT_CAUSE_HYPOTHESIS_MISMATCH",
    responseHash: "a".repeat(64),
  }, {
    iteration: 4,
    attemptIndex: 1,
    outcome: "REPAIR_FAILED",
    validationKind: "SCHEMA",
    decisionType: "FINALIZE",
    validationCode: "INVALID_FIELD_VALUE",
    validationPath: "diagnosis.claims",
    validationSubcode: null,
    responseHash: "b".repeat(64),
  }]);
  assert.equal(telemetryA.schemaRepairCount, 1);
  assert.equal(telemetryA.telemetryIdentity, telemetryB.telemetryIdentity);
  const semanticEvent = aggregate.auditEvents.find((item) => item.id === "AE-VALIDATION-1")!;
  semanticEvent.details.validationSubcode = "RAG_ONLY_ROOT_CAUSE";
  const changedSubcode = telemetryFromAggregate(request, aggregate, ["must-not-persist"]);
  assert.notEqual(telemetryA.telemetryIdentity, changedSubcode.telemetryIdentity);
  const serialized = JSON.stringify(telemetryA.plannerValidationEvents);
  for (const forbidden of [
    "must-not-persist", "prompt", "response\"", "groundTruth", "Authorization",
    "apiKey", "canonicalRootCauseId", "RC-999", "semanticRubric",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("duplicate guard telemetry links the rejected candidate without changing execution", async () => {
  const fixture = loadInvestigationBenchmarkDevDataset().fixtures[0];
  const request = __testOnly.observationRequest(fixture);
  const planner: InvestigationPlanner = {
    type: "DETERMINISTIC",
    async plan(context) {
      const active = context.aggregate.hypotheses.filter((item) => item.status !== "REJECTED");
      if (active.length === 0) {
        return {
          type: "CREATE_HYPOTHESES",
          hypotheses: [{
            statement: "A test-only hypothesis for duplicate guard observability.",
            supportIf: "A release observation is available.",
            refuteIf: "The release observation is unavailable.",
          }],
          rationale: "Create a deterministic test hypothesis.",
        };
      }
      const assessed = new Set(context.aggregate.hypothesisEvidenceLinks.map((item) => item.evidenceId));
      const pending = context.aggregate.evidence.filter((item) => !assessed.has(item.id));
      if (pending.length > 0) {
        return {
          type: "ASSESS_EVIDENCE",
          assessments: pending.map((evidence) => ({
            evidenceId: evidence.id,
            relations: active.map((hypothesis) => ({
              targetHypothesisId: hypothesis.id,
              relation: "NEUTRAL" as const,
              explanation: "Persist the test observation before proposing the duplicate.",
            })),
          })),
          rationale: "Assess the persisted evidence.",
        };
      }
      return {
        type: "CALL_TOOL",
        toolName: "get_release",
        arguments: {
          release_id: context.aggregate.release!.id,
          note: "secret-value",
          apiKey: "must-not-persist",
          groundTruth: { canonicalRootCauseId: "RC-999" },
        },
        targetHypothesisIds: active.map((item) => item.id),
        testIntent: "SUPPORT",
        rationale: "Propose the same deterministic tool call.",
      };
    },
  };
  const execute = async () => {
    let observability: LiveEvalObservability | undefined;
    const aggregate = await executeHarnessAgentRuntime(request, {
      planner,
      maxIterations: 8,
      maxToolCalls: 10,
      onObservability: (value) => { observability = value; },
    });
    const beforeProjection = structuredClone(aggregate);
    const telemetry = telemetryFromAggregate(request, aggregate, ["secret-value"], observability);
    assert.deepEqual(aggregate, beforeProjection);
    return { aggregate, telemetry };
  };

  const runA = await execute();
  const runB = await execute();
  assert.equal(runA.aggregate.run.status, "INCONCLUSIVE");
  assert.equal(runA.aggregate.run.stopReason, "DUPLICATE_TOOL_CALL");
  assert.equal(runA.aggregate.toolCalls.length, 1);
  assert.equal(runA.telemetry.toolCallCount, 1);
  assert.equal(runA.telemetry.guardEvents?.length, 1);
  assert.deepEqual(runA.telemetry.guardEvents?.[0], {
    eventType: "DUPLICATE_TOOL_CALL",
    iteration: 4,
    proposedToolName: "get_release",
    sanitizedProposedArguments: {
      release_id: request.agentInput.release!.id,
      note: "[REDACTED]",
    },
    proposedFingerprint: runA.telemetry.guardEvents?.[0].proposedFingerprint,
    duplicateOfToolCallId: "TOOL_CALL-001",
    duplicateOfFingerprint: runA.telemetry.guardEvents?.[0].duplicateOfFingerprint,
    resolution: "REJECTED_AND_STOPPED_INCONCLUSIVE",
  });
  assert.match(runA.telemetry.guardEvents![0].proposedFingerprint!, /^[a-f0-9]{64}$/);
  assert.equal(runA.telemetry.guardEvents![0].proposedFingerprint,
    runA.telemetry.guardEvents![0].duplicateOfFingerprint);
  const serialized = JSON.stringify(runA.telemetry.guardEvents);
  for (const forbidden of ["secret-value", "must-not-persist", "groundTruth", "RC-999"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(runA.telemetry.telemetryIdentity, runB.telemetry.telemetryIdentity);
});

test("default fixture provider does not cite a metric observation selected for another metric", async () => {
  const report = await runInvestigationBenchmarkDevHarness({
    sourceCommit,
    providerFactory: createDeterministicHarnessProviderFactory(),
    caseId: "CASE-201",
  });
  const result = report.cases[0];
  assert.equal(result.scoring.evidence.citedCount, 1);
  assert.equal(result.scoring.evidence.relevantCount, 1);
  assert.equal(result.scoring.evidence.precision, 1);
  assert.deepEqual(result.scoring.evidence.duplicateEvidenceIds,
    [...new Set(result.normalizedPrediction?.citedEvidenceIds)]);
  assert.deepEqual(result.scoring.evidence.unknownEvidenceIds, []);
  assert.equal(result.scoring.grounding.status, "EVALUABLE");
});

type ProjectionInput = Parameters<typeof projectInconclusivePrediction>[0];
type ProjectionHypothesis = ProjectionInput["hypotheses"][number];

const projectionHypothesis = (
  statement: string,
  overrides: Partial<ProjectionHypothesis> = {},
): ProjectionHypothesis => ({
  statement,
  status: "ACTIVE",
  confidence: "LOW",
  supportScore: 0,
  contradictionScore: 0,
  createdAt: "2031-02-01T00:00:00.000Z",
  ...overrides,
});

const projectionInput = (
  hypotheses: ProjectionHypothesis[],
  overrides: Partial<ProjectionInput["run"]> = {},
): ProjectionInput => ({
  run: {
    status: "INCONCLUSIVE",
    stopReason: "INSUFFICIENT_EVIDENCE",
    ...overrides,
  },
  hypotheses,
});

const projectedAlternatives = (value: string) => value
  .split(/; \(\d\) /)
  .map((item) => item.replace(/^.*?: \(1\) /, "").replace(/[.;]$/, ""));

test("inconclusive projection retains legacy hypotheses with missing creation timestamps", () => {
  const absent = projectionHypothesis("An absent-timestamp explanation remains possible.");
  delete absent.createdAt;
  const withNull = projectionHypothesis("A null-timestamp explanation remains possible.", {
    createdAt: null,
  });

  const absentText = projectInconclusivePrediction(projectionInput([absent]))!;
  const nullText = projectInconclusivePrediction(projectionInput([withNull]))!;
  assert.match(absentText, /absent-timestamp explanation/i);
  assert.match(nullText, /null-timestamp explanation/i);
  assert.match(absentText, /plausible but not sufficiently confirmed/i);
  assert.match(nullText, /plausible but not sufficiently confirmed/i);
});

test("inconclusive projection rejects invalid provided creation timestamps", () => {
  const invalid = [
    projectionHypothesis("Empty timestamp.", { createdAt: "" }),
    projectionHypothesis("Invalid timestamp.", { createdAt: "not-a-date" }),
    projectionHypothesis("Non-string timestamp.", { createdAt: 42 as unknown as string }),
  ];
  assert.equal(
    projectInconclusivePrediction(projectionInput(invalid)),
    "Insufficient evidence to determine a root cause from the available observations.",
  );
});

test("inconclusive projection deterministically orders missing and mixed creation timestamps", () => {
  const missingZulu = projectionHypothesis("Zulu missing alternative.", { createdAt: null });
  const missingAlpha = projectionHypothesis("Alpha missing alternative.");
  delete missingAlpha.createdAt;
  const bothMissing = projectionInput([missingZulu, missingAlpha]);
  const first = projectInconclusivePrediction(bothMissing)!;
  const second = projectInconclusivePrediction(structuredClone(bothMissing))!;
  assert.equal(first, second);
  assert.deepEqual(projectedAlternatives(first), [
    "Alpha missing alternative",
    "Zulu missing alternative",
  ]);

  const present = projectionHypothesis("Zulu authoritative alternative.");
  const missing = projectionHypothesis("Alpha legacy alternative.", { createdAt: null });
  const mixed = projectionInput([missing, present]);
  const mixedFirst = projectInconclusivePrediction(mixed)!;
  assert.equal(mixedFirst, projectInconclusivePrediction(structuredClone(mixed)));
  assert.deepEqual(projectedAlternatives(mixedFirst), [
    "Zulu authoritative alternative",
    "Alpha legacy alternative",
  ]);
  assert.equal(missing.createdAt, null);
});

test("inconclusive projection preserves ordering for valid creation timestamps", () => {
  const laterAlpha = projectionHypothesis("Alpha later alternative.", {
    createdAt: "2031-02-02T00:00:00.000Z",
  });
  const earlierZulu = projectionHypothesis("Zulu earlier alternative.", {
    createdAt: "2031-02-01T00:00:00.000Z",
  });
  assert.equal(
    projectInconclusivePrediction(projectionInput([laterAlpha, earlierZulu])),
    "Insufficient evidence to confirm a single root cause. The following unresolved "
      + "alternatives remain plausible, and the available observations cannot distinguish among "
      + "them: (1) Zulu earlier alternative; (2) Alpha later alternative.",
  );

  const equalTimestamps = projectionInput([
    projectionHypothesis("Zulu equal-time alternative."),
    projectionHypothesis("Alpha equal-time alternative."),
  ]);
  assert.deepEqual(projectedAlternatives(projectInconclusivePrediction(equalTimestamps)!), [
    "Alpha equal-time alternative",
    "Zulu equal-time alternative",
  ]);
});

test("inconclusive projection restores a legacy frozen three-alternative state", () => {
  const legacyHypotheses = [
    projectionHypothesis(
      "The REL-219 release (CheckoutClient change) is the root cause of the payment_completion_rate drop in AU.",
      { status: "WEAKENED", confidence: "LOW", contradictionScore: 1, createdAt: null },
    ),
    projectionHypothesis(
      "An instability in the payment provider (external dependency) is the root cause of the payment_completion_rate drop in AU.",
      { status: "SUPPORTED", confidence: "MEDIUM", supportScore: 3, createdAt: null },
    ),
    projectionHypothesis(
      "The payment_completion_rate drop in AU results from combined effects of the REL-219 release and an underlying payment provider degradation.",
      { status: "SUPPORTED", confidence: "MEDIUM", supportScore: 3, createdAt: null },
    ),
  ];
  const projected = projectInconclusivePrediction(projectionInput(legacyHypotheses))!;
  assert.deepEqual(projectedAlternatives(projected), [
    "An instability in the payment provider (external dependency) is the root cause of the payment_completion_rate drop in AU",
    "The payment_completion_rate drop in AU results from combined effects of the REL-219 release and an underlying payment provider degradation",
    "The REL-219 release (CheckoutClient change) is the root cause of the payment_completion_rate drop in AU",
  ]);
  assert.match(projected, /unresolved alternatives remain plausible/i);
  assert.match(projected, /cannot distinguish among them/i);

  const aggregate = {
    diagnosis: null,
    diagnosisClaims: [],
    diagnosisClaimEvidenceLinks: [],
    auditEvents: [],
    toolCalls: [],
    hypotheses: legacyHypotheses,
    run: { status: "INCONCLUSIVE", stopReason: "INSUFFICIENT_EVIDENCE", modelCallCount: 0 },
  } as unknown as InvestigationAggregate;
  const prediction = __testOnlyLiveProvider.predictionFromAggregate(aggregate, 0, []);
  assert.equal(prediction.predictedRootCause, projected);
  assert.equal(prediction.predictedRootCauseId, null);
  assert.deepEqual(prediction.diagnosisClaims, []);
  assert.deepEqual(prediction.citedEvidenceIds, []);
});

test("inconclusive projection keeps the candidate set when equal timestamps are omitted", () => {
  const complete = [
    projectionHypothesis("Zulu candidate."),
    projectionHypothesis("Alpha candidate."),
    projectionHypothesis("Middle candidate."),
  ];
  const legacy = complete.map((hypothesis) => {
    const legacyHypothesis = { ...hypothesis };
    delete legacyHypothesis.createdAt;
    return legacyHypothesis;
  });
  const completeText = projectInconclusivePrediction(projectionInput(complete))!;
  const legacyText = projectInconclusivePrediction(projectionInput(legacy))!;
  assert.equal(legacyText, completeText);
  assert.deepEqual(projectedAlternatives(legacyText), [
    "Alpha candidate",
    "Middle candidate",
    "Zulu candidate",
  ]);
});

test("inconclusive projection preserves three synthetic unresolved alternatives without claims", () => {
  const hypotheses = [
    projectionHypothesis("A checkout release defect remains a possible explanation.", {
      status: "WEAKENED", contradictionScore: 1,
    }),
    projectionHypothesis("Payment-provider instability remains a possible explanation.", {
      status: "SUPPORTED", confidence: "MEDIUM", supportScore: 4,
    }),
    projectionHypothesis("A combination of the checkout release and provider instability remains possible.", {
      status: "SUPPORTED", confidence: "MEDIUM", supportScore: 3,
    }),
  ];
  const text = projectInconclusivePrediction(projectionInput(hypotheses));
  assert.ok(text);
  for (const phrase of [
    "checkout release defect",
    "Payment-provider instability",
    "combination of the checkout release and provider instability",
  ]) assert.match(text, new RegExp(phrase, "i"));
  assert.match(text, /Insufficient evidence to confirm a single root cause/);
  assert.match(text, /cannot distinguish among them/);

  const aggregate = {
    diagnosis: null,
    diagnosisClaims: [],
    diagnosisClaimEvidenceLinks: [],
    auditEvents: [],
    toolCalls: [],
    hypotheses,
    run: { status: "INCONCLUSIVE", stopReason: "INSUFFICIENT_EVIDENCE",
      modelCallCount: 7 },
  } as unknown as InvestigationAggregate;
  const prediction = __testOnlyLiveProvider.predictionFromAggregate(aggregate, 123, []);
  assert.equal(prediction.predictedRootCause, text);
  assert.equal(prediction.predictedRootCauseId, null);
  assert.deepEqual(prediction.diagnosisClaims, []);
  assert.deepEqual(prediction.citedEvidenceIds, []);
});

test("inconclusive projection excludes rejected hypotheses and retains weakened alternatives", () => {
  const text = projectInconclusivePrediction(projectionInput([
    projectionHypothesis("Rejected but artificially high-scoring release theory.", {
      status: "REJECTED", confidence: "HIGH", supportScore: 999,
    }),
    projectionHypothesis("A weakened release alternative.", {
      status: "WEAKENED", contradictionScore: 2,
    }),
    projectionHypothesis("A supported provider alternative.", {
      status: "SUPPORTED", confidence: "MEDIUM", supportScore: 3,
    }),
  ]))!;
  assert.doesNotMatch(text, /Rejected but artificially high-scoring/);
  assert.match(text, /weakened release alternative/i);
  assert.match(text, /supported provider alternative/i);
  assert.ok(text.indexOf("supported provider alternative") < text.indexOf("weakened release alternative"));
  assert.doesNotMatch(text, /confirmed cause/i);
});

test("inconclusive projection uses exact fallback and a distinct single-alternative template", () => {
  const fallback = "Insufficient evidence to determine a root cause from the available observations.";
  assert.equal(projectInconclusivePrediction(projectionInput([])), fallback);
  assert.equal(projectInconclusivePrediction(projectionInput([
    projectionHypothesis("Rejected explanation.", { status: "REJECTED" }),
    projectionHypothesis("Unknown-state explanation.", { status: "UNKNOWN" }),
    projectionHypothesis("Unsafe\u0000explanation."),
  ])), fallback);

  const single = projectInconclusivePrediction(projectionInput([
    projectionHypothesis("A client retry defect remains possible."),
  ]))!;
  assert.match(single, /plausible but not sufficiently confirmed/i);
  assert.match(single, /no finalized diagnosis/i);
  assert.doesNotMatch(single, /among (?:these )?(?:unresolved )?alternatives/i);
  assert.doesNotMatch(single, /root cause (?:is|was)/i);
});

test("inconclusive projection is deterministic, bounded, Unicode-safe, and exact-only deduplicated", () => {
  const long = "Payment latency remained elevated across multiple cohorts. ".repeat(12)
    + "支付异常🚀";
  const input = projectionInput([
    projectionHypothesis(long, { status: "SUPPORTED", supportScore: 5 }),
    projectionHypothesis("Ａ checkout   release alternative。", {
      createdAt: "2031-02-02T00:00:00.000Z",
    }),
    projectionHypothesis("a CHECKOUT release alternative", {
      createdAt: "2031-02-03T00:00:00.000Z",
    }),
    projectionHypothesis("A checkout release alternative with a materially different mechanism", {
      createdAt: "2031-02-04T00:00:00.000Z",
    }),
  ]);
  const first = projectInconclusivePrediction(input)!;
  const second = projectInconclusivePrediction(structuredClone(input))!;
  assert.equal(first, second);
  assert.ok(Array.from(first).length <= 1_200);
  assert.equal(/[\uD800-\uDFFF]/u.test(first), false);
  assert.equal(first.match(/a checkout release alternative(?! with)/gi)?.length, 1);
  assert.match(first, /materially different mechanism/i);
  const rendered = projectedAlternatives(first);
  assert.ok(rendered.every((item) => Array.from(item).length <= 320));
});

test("inconclusive projection cannot expose benchmark metadata or internal hypothesis fields", () => {
  const input = {
    ...projectionInput([{
      ...projectionHypothesis("A public synthetic explanation remains possible."),
      id: "INTERNAL-HYPOTHESIS-ID",
      benchmarkEvidenceId: "BENCHMARK-EVIDENCE-ID",
    } as ProjectionHypothesis]),
    caseId: "FORBIDDEN-CASE-ID",
    difficulty: "FORBIDDEN-DIFFICULTY",
    expectedAnswer: "FORBIDDEN-EXPECTED-ANSWER",
    goldRootCause: "FORBIDDEN-GOLD-ROOT-CAUSE",
    role: "FORBIDDEN-ROLE",
    requiredEvidenceIds: ["FORBIDDEN-REQUIRED"],
    supportingEvidenceIds: ["FORBIDDEN-SUPPORTING"],
    distractorEvidenceIds: ["FORBIDDEN-DISTRACTOR"],
  } as ProjectionInput;
  const text = projectInconclusivePrediction(input)!;
  for (const forbidden of [
    "FORBIDDEN", "INTERNAL-HYPOTHESIS-ID", "BENCHMARK-EVIDENCE-ID",
    "SUPPORTED", "HIGH", "supportScore", "confidence",
  ]) assert.equal(text.includes(forbidden), false, forbidden);
});

test("finalized projection remains unchanged and failed state does not project alternatives", () => {
  const finalized = {
    diagnosis: { id: "DIAGNOSIS-SYNTHETIC", rootCause: "A finalized synthetic diagnosis." },
    diagnosisClaims: [],
    diagnosisClaimEvidenceLinks: [],
    auditEvents: [],
    toolCalls: [],
    hypotheses: [projectionHypothesis("An alternative that must not replace the diagnosis.")],
    run: { status: "WAITING_APPROVAL", stopReason: "SUFFICIENT_EVIDENCE", modelCallCount: 4 },
  } as unknown as InvestigationAggregate;
  const prediction = __testOnlyLiveProvider.predictionFromAggregate(finalized, 10, []);
  assert.equal(prediction.predictedRootCause, "A finalized synthetic diagnosis.");
  assert.equal("citedEvidenceIds" in prediction, false);
  assert.equal(projectInconclusivePrediction(projectionInput([
    projectionHypothesis("A failed-run alternative that must not be projected."),
  ], { status: "FAILED", stopReason: "PLANNER_ERROR" })), null);
});

test("synthetic unresolved projection scopes causal phrases to explicit alternatives", () => {
  const text = projectInconclusivePrediction(projectionInput([
    projectionHypothesis("A checkout release defect remains possible.", { status: "SUPPORTED" }),
    projectionHypothesis("Payment-provider instability remains possible.", { status: "SUPPORTED" }),
  ]))!;
  const groundTruth: InvestigationGroundTruth = {
    canonicalRootCauseId: "SYNTHETIC-RC",
    canonicalRootCause: "Synthetic alternatives remain unresolved.",
    acceptableAliases: [],
    requiredEvidenceIds: [], supportingEvidenceIds: [], distractorEvidenceIds: [],
    rootCauseEvaluation: {
      expectedAnswerMode: "ABSTAIN",
      requiredConceptGroups: [
        { id: "release-alternative", anyOf: ["CHECKOUT_RELEASE"] },
        { id: "provider-alternative", anyOf: ["PAYMENT_PROVIDER_INSTABILITY"] },
        { id: "alternatives-unresolved", anyOf: ["ALTERNATIVES_UNRESOLVED"] },
      ],
      optionalConcepts: ["EVIDENCE_INSUFFICIENT"],
      forbiddenConcepts: ["DEFINITE_CAUSAL_ATTRIBUTION"],
      uncertaintyPolicy: "REQUIRE_UNRESOLVED_ALTERNATIVES",
      specificityPolicy: "ALLOW_MORE_SPECIFIC_IF_CONSISTENT",
    },
  };
  const score = scoreRootCauseSemantics(groundTruth, {
    caseId: "SYNTHETIC-NON-DATASET",
    predictedRootCause: text,
    predictedRootCauseId: null,
    citedEvidenceIds: [], diagnosisClaims: [], modelCallCount: 0, toolCallCount: 0,
  });
  assert.deepEqual(score.audit.missingRequiredConcepts, []);

  const assertive = projectInconclusivePrediction(projectionInput([
    projectionHypothesis("The checkout regression was caused by a client release defect."),
    projectionHypothesis("Payment-provider instability remains possible."),
  ]))!;
  const scopedAlternative = scoreRootCauseSemantics(groundTruth, {
    caseId: "SYNTHETIC-PRECEDENCE-RISK",
    predictedRootCause: assertive,
    predictedRootCauseId: null,
    citedEvidenceIds: [], diagnosisClaims: [], modelCallCount: 0, toolCallCount: 0,
  });
  assert.equal(scopedAlternative.audit.predictedAnswerMode, "ABSTAIN");
  assert.ok(scopedAlternative.audit.matchedConcepts.includes("ALTERNATIVES_UNRESOLVED"));
  assert.equal(scopedAlternative.audit.matchedConcepts.includes("DEFINITE_CAUSAL_ATTRIBUTION"), false);
  assert.equal(scopedAlternative.audit.uncertaintyPolicyResult, "PASS");
  assert.equal(scopedAlternative.correct, true);
});
