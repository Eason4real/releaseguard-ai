import assert from "node:assert/strict";
import test from "node:test";
import type { InvestigationPlanner, PlannerContext } from
  "../lib/investigation/planner";
import { LLMInvestigationSynthesizer } from "../lib/investigation/llm-synthesizer";
import {
  buildEvidencePacket,
  evaluateEvidenceReadiness,
  StagedInvestigationPlanner,
  type InvestigationSynthesizer,
} from "../lib/investigation/staged-planner";
import {
  buildEvidencePacketV2,
  evaluateEvidenceReadinessV2,
} from "../lib/investigation/evidence-packet-v2";
import { projectInvestigationOutcomeV2 } from
  "../lib/investigation/outcome-projection";
import type { InvestigationAggregate } from "../lib/investigation/types";

const aggregateFixture = (options: { includeImpact?: boolean } = {}): InvestigationAggregate => ({
  run: {
    id: "RUN-V7",
    incidentId: "INC-V7",
    riskEventId: "RISK-V7",
    releaseId: "REL-V7",
    question: "Did the release cause the conversion regression?",
    provider: "test",
    model: "test",
    plannerType: "LLM",
    status: "RUNNING",
    currentIteration: 2,
    activeIterationId: null,
    lockVersion: 0,
    modelCallCount: 0,
    maxModelCalls: 20,
    stopReason: null,
    currentDiagnosisRevision: 0,
    totalTokens: 0,
    errorMessage: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  release: { id: "REL-V7", version: "7.0.0", platform: "android" } as never,
  riskEvent: {
    metricKey: "checkout_conversion",
    firstBreachedAt: "2026-01-01T00:00:00.000Z",
    lastBreachedAt: "2026-01-01T01:00:00.000Z",
  } as never,
  hypotheses: [{
    id: "HYP-1",
    runId: "RUN-V7",
    revision: 1,
    statement: "The release introduced the regression.",
    supportIf: "Release and impact evidence align.",
    refuteIf: "Impact predates the release.",
    status: "SUPPORTED",
    confidence: "MEDIUM",
    supportScore: 4,
    contradictionScore: 0,
    confidenceReason: "Two current sources support the hypothesis.",
    createdBy: "AGENT",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }],
  evidence: [{
    id: "EV-RELEASE",
    runId: "RUN-V7",
    toolResultId: "TR-RELEASE",
    category: "RELEASE_CHANGE",
    statement: "The release changed checkout behavior.",
    source: "release catalog",
    strength: "MEDIUM",
    provenance: "synthetic",
    collectedAt: "2026-01-01T00:01:00.000Z",
  }, ...(options.includeImpact === false ? [] : [{
    id: "EV-METRIC",
    runId: "RUN-V7",
    toolResultId: "TR-METRIC",
    category: "PRODUCT_METRIC",
    statement: "Checkout conversion dropped after the release.",
    source: "product analytics",
    strength: "HIGH" as const,
    provenance: "synthetic" as const,
    collectedAt: "2026-01-01T00:02:00.000Z",
  }])],
  hypothesisEvidenceLinks: [{
    id: "LINK-RELEASE",
    runId: "RUN-V7",
    hypothesisId: "HYP-1",
    evidenceId: "EV-RELEASE",
    relation: "SUPPORTS",
    explanation: "The release contains a relevant change.",
    linkedBy: "AGENT",
    createdAt: "2026-01-01T00:03:00.000Z",
  }, ...(options.includeImpact === false ? [] : [{
    id: "LINK-METRIC",
    runId: "RUN-V7",
    hypothesisId: "HYP-1",
    evidenceId: "EV-METRIC",
    relation: "SUPPORTS" as const,
    explanation: "The timing and metric align.",
    linkedBy: "AGENT" as const,
    createdAt: "2026-01-01T00:04:00.000Z",
  }])],
  toolCalls: [{
    id: "TOOL-SECRET-TRANSCRIPT",
    proposedActionId: null,
    result: { id: "TR-SECRET", output: { privateTranscript: "must not enter packet" } },
  }] as never,
  iterations: [],
  traceEvents: [],
  auditEvents: [],
  evidenceRelations: [],
  diagnosis: null,
  diagnosisClaims: [],
  diagnosisClaimEvidenceLinks: [],
} as unknown as InvestigationAggregate);

const contextFor = (aggregate: InvestigationAggregate): PlannerContext => ({
  aggregate,
  trigger: "INITIAL",
  humanMessage: null,
  remainingIterations: 8,
  remainingToolCalls: 5,
});

const v8AggregateFixture = (): InvestigationAggregate => {
  const aggregate = aggregateFixture();
  aggregate.hypotheses.push({
    ...aggregate.hypotheses[0],
    id: "HYP-2",
    statement: "An external dependency introduced the regression.",
    status: "REJECTED",
    confidence: "LOW",
    supportScore: 0,
    contradictionScore: 2,
  });
  aggregate.toolCalls = [{
    id: "TOOL-RELEASE",
    runId: "RUN-V7",
    name: "get_release",
    arguments: { release_id: "REL-V7" },
    canonicalSignature: "get_release:{}",
    status: "SUCCESS",
    proposedActionId: null,
    approvalId: null,
    agentIterationId: null,
    triggerMessageId: null,
    cacheSourceToolCallId: null,
    iteration: 1,
    order: 1,
    resultId: "TR-RELEASE",
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: {
      id: "TR-RELEASE",
      runId: "RUN-V7",
      toolCallId: "TOOL-RELEASE",
      status: "SUCCESS",
      output: {
        data: {
          version: "7.0.0",
          platform: "android",
          changed_modules: ["Checkout", "Payments"],
          feature_flags: ["checkout_v2"],
          rollout: { percentage: 50 },
          released_at: "2026-01-01T00:00:00.000Z",
          gold_root_cause: "must not leak",
        },
        scoring: { expected: "must not leak" },
        privateTranscript: "must not leak",
      },
      errorMessage: null,
      retryable: false,
      createdAt: "2026-01-01T00:01:00.000Z",
    },
  }, {
    id: "TOOL-METRIC",
    runId: "RUN-V7",
    name: "query_metric",
    arguments: {
      metric_key: "checkout_conversion",
      start_time: "2026-01-01T00:00:00.000Z",
      end_time: "2026-01-01T01:00:00.000Z",
      filters: { platform: "android", appVersion: "7.0.0" },
    },
    canonicalSignature: "query_metric:{}",
    status: "SUCCESS",
    proposedActionId: null,
    approvalId: null,
    agentIterationId: null,
    triggerMessageId: null,
    cacheSourceToolCallId: null,
    iteration: 2,
    order: 1,
    resultId: "TR-METRIC",
    requestedAt: "2026-01-01T00:01:00.000Z",
    startedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:02:00.000Z",
    result: {
      id: "TR-METRIC",
      runId: "RUN-V7",
      toolCallId: "TOOL-METRIC",
      status: "SUCCESS",
      output: {
        query: {
          metric_key: "checkout_conversion",
          start_time: "2026-01-01T00:00:00.000Z",
          end_time: "2026-01-01T01:00:00.000Z",
          filters: { platform: "android", appVersion: "7.0.0" },
        },
        data: { summary: { value: 0.61, baseline: 0.94, sampleSize: 1200 } },
        case_id: "CASE-SECRET",
      },
      errorMessage: null,
      retryable: false,
      createdAt: "2026-01-01T00:02:00.000Z",
    },
  }];
  return aggregate;
};

test("v7 readiness requires assessed release and impact evidence from independent current sources", () => {
  const ready = evaluateEvidenceReadiness(aggregateFixture(), 5);
  assert.equal(ready.status, "READY_TO_SYNTHESIZE");
  assert.equal(ready.independentCurrentSources, 2);

  const incomplete = aggregateFixture({ includeImpact: false });
  assert.equal(evaluateEvidenceReadiness(incomplete, 5).status, "NEEDS_MORE_EVIDENCE");
  assert.equal(
    evaluateEvidenceReadiness(incomplete, 0).status,
    "UNRESOLVABLE_WITH_AVAILABLE_TOOLS",
  );
});

test("v7 Evidence Packet is stable and excludes tool results and exploration transcript", () => {
  const aggregate = aggregateFixture();
  const readiness = evaluateEvidenceReadiness(aggregate, 5);
  const packet = buildEvidencePacket(aggregate, readiness);
  assert.deepEqual(packet.evidence.map((item) => item.id), ["EV-METRIC", "EV-RELEASE"]);
  assert.equal("toolCalls" in packet, false);
  assert.doesNotMatch(JSON.stringify(packet), /privateTranscript|TOOL-SECRET-TRANSCRIPT/);
  assert.deepEqual(packet.evidence[0]?.relations.map((item) => item.hypothesisId), ["HYP-1"]);
});

test("v8 Evidence Packet projects concrete whitelisted facts without leaking raw fields", () => {
  const aggregate = v8AggregateFixture();
  const readiness = evaluateEvidenceReadinessV2(aggregate, 5);
  const packet = buildEvidencePacketV2(aggregate, readiness);
  assert.equal(packet.schemaVersion, "releaseguard-evidence-packet-v2");
  assert.equal(packet.readiness.status, "READY_FOR_CAUSAL");
  assert.deepEqual(packet.evidence.map((item) => item.id), ["EV-METRIC", "EV-RELEASE"]);
  const metric = packet.evidence.find((item) => item.id === "EV-METRIC")?.facts[0];
  assert.deepEqual(metric, {
    kind: "METRIC",
    metricKey: "checkout_conversion",
    value: 0.61,
    baseline: 0.94,
    delta: 0.61 - 0.94,
    sampleSize: 1200,
    window: {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T01:00:00.000Z",
    },
  });
  const release = packet.evidence.find((item) => item.id === "EV-RELEASE")?.facts[0];
  assert.deepEqual(release, {
    kind: "RELEASE",
    version: "7.0.0",
    platform: "android",
    modules: ["Checkout", "Payments"],
    flags: ["checkout_v2"],
    rolloutPercent: 50,
    releasedAt: "2026-01-01T00:00:00.000Z",
  });
  const serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /gold_root_cause|must not leak|privateTranscript|CASE-SECRET|scoring/);
  assert.equal(serialized, JSON.stringify(buildEvidencePacketV2(aggregate, readiness)));
});

test("v8 Evidence Packet preserves non-standard metric signals and before/after segments", () => {
  const aggregate = v8AggregateFixture();
  const metricCall = aggregate.toolCalls.find((item) => item.resultId === "TR-METRIC")!;
  metricCall.result!.output = {
    data: {
      failureRates: [0.05, 0.13, 0.28],
      rolloutSteps: [0.1, 0.25, 0.5],
      sampleSize: 5400,
      expectedScore: 100,
    },
  };
  const segmentEvidence = { ...aggregate.evidence[1], id: "EV-SEGMENT",
    toolResultId: "TR-SEGMENT", category: "SEGMENT_METRIC" };
  aggregate.evidence.push(segmentEvidence);
  aggregate.toolCalls.push({
    ...metricCall,
    id: "TOOL-SEGMENT",
    name: "segment_metric",
    resultId: "TR-SEGMENT",
    arguments: { metric_key: "checkout_conversion", dimension: "user_type" },
    result: {
      ...metricCall.result!,
      id: "TR-SEGMENT",
      toolCallId: "TOOL-SEGMENT",
      output: { data: {
        dimension: "user_type",
        before: [{ value: "NEW", rate: 0.3 }],
        after: [{ value: "NEW", rate: 0.5 }],
      } },
    },
  });
  const packet = buildEvidencePacketV2(aggregate);
  const metric = packet.evidence.find((item) => item.id === "EV-METRIC")?.facts[0];
  assert.equal(metric?.kind, "METRIC");
  if (metric?.kind === "METRIC") {
    assert.ok(metric.measurements?.some((item) =>
      item.name === "failureRates[2]" && item.value === 0.28));
    assert.ok(metric.measurements?.some((item) =>
      item.name === "rolloutSteps[2]" && item.value === 0.5));
    assert.ok(!metric.measurements?.some((item) => /expectedScore/i.test(item.name)));
  }
  const segment = packet.evidence.find((item) => item.id === "EV-SEGMENT")?.facts[0];
  assert.equal(segment?.kind, "SEGMENT");
  if (segment?.kind === "SEGMENT") {
    assert.deepEqual(segment.groups.map((item) => item.name), ["after:NEW", "before:NEW"]);
  }
});

test("v8 Evidence Packet preserves complete empty retrieval as negative evidence", () => {
  const aggregate = v8AggregateFixture();
  const metricCall = aggregate.toolCalls.find((item) => item.resultId === "TR-METRIC")!;
  aggregate.evidence.push({
    ...aggregate.evidence[1],
    id: "EV-FEEDBACK-EMPTY",
    toolResultId: "TR-FEEDBACK-EMPTY",
    category: "USER_FEEDBACK",
  });
  aggregate.toolCalls.push({
    ...metricCall,
    id: "TOOL-FEEDBACK-EMPTY",
    name: "search_user_feedback",
    resultId: "TR-FEEDBACK-EMPTY",
    arguments: { query: "activation issue", platform: "web" },
    result: {
      ...metricCall.result!,
      id: "TR-FEEDBACK-EMPTY",
      toolCallId: "TOOL-FEEDBACK-EMPTY",
      output: { coverage: "complete", matches: [], queryWindow: "incident" },
    },
  });
  const packet = buildEvidencePacketV2(aggregate);
  const feedback = packet.evidence.find((item) => item.id === "EV-FEEDBACK-EMPTY");
  assert.deepEqual(feedback?.facts, [{
    kind: "FEEDBACK",
    themes: [],
    representativeSamples: [],
    filters: { platform: "web" },
    coverage: "complete",
  }]);
  assert.match(feedback?.factSummary ?? "", /themes=none; samples=0; coverage=complete/);
});

test("v8 readiness distinguishes causal, bounded, abstention, and collection states", () => {
  const causal = v8AggregateFixture();
  assert.equal(evaluateEvidenceReadinessV2(causal, 5).status, "READY_FOR_CAUSAL");

  const bounded = v8AggregateFixture();
  bounded.hypotheses[1] = {
    ...bounded.hypotheses[1], status: "SUPPORTED", confidence: "MEDIUM",
    supportScore: bounded.hypotheses[0].supportScore, contradictionScore: 0,
  };
  bounded.hypothesisEvidenceLinks.push(
    ...bounded.evidence.map((evidence, index) => ({
      id: `LINK-HYP-2-${index}`,
      runId: "RUN-V7",
      hypothesisId: "HYP-2",
      evidenceId: evidence.id,
      relation: "SUPPORTS" as const,
      explanation: "The same current evidence does not distinguish the competing mechanism.",
      linkedBy: "AGENT" as const,
      createdAt: "2026-01-01T00:05:00.000Z",
    })),
  );
  assert.equal(
    evaluateEvidenceReadinessV2(bounded, 0).status,
    "READY_FOR_BOUNDED_HYPOTHESIS",
  );
  assert.equal(evaluateEvidenceReadinessV2(bounded, 3).status, "NEEDS_COLLECTION");

  const untestedAlternative = v8AggregateFixture();
  untestedAlternative.hypotheses[1] = {
    ...untestedAlternative.hypotheses[1],
    status: "ACTIVE",
    confidence: "LOW",
    supportScore: 0,
    contradictionScore: 0,
  };
  untestedAlternative.hypothesisEvidenceLinks.push(
    ...untestedAlternative.evidence.map((evidence, index) => ({
      id: `LINK-UNTESTED-${index}`,
      runId: "RUN-V7",
      hypothesisId: "HYP-2",
      evidenceId: evidence.id,
      relation: "NEUTRAL" as const,
      explanation: "This evidence does not test the viable alternative.",
      linkedBy: "AGENT" as const,
      createdAt: "2026-01-01T00:06:00.000Z",
    })),
  );
  const untested = evaluateEvidenceReadinessV2(untestedAlternative, 0);
  assert.equal(untested.status, "READY_FOR_CAUSAL");
  assert.deepEqual(untested.unresolvedCompetingHypothesisIds, []);
  assert.ok(!untested.reasons.includes("UNTESTED_VIABLE_COMPETITOR"));

  const collecting = aggregateFixture({ includeImpact: false });
  assert.equal(evaluateEvidenceReadinessV2(collecting, 3).status, "NEEDS_COLLECTION");

  const abstaining = aggregateFixture({ includeImpact: false });
  abstaining.hypotheses = [];
  abstaining.evidence = [];
  abstaining.hypothesisEvidenceLinks = [];
  assert.equal(evaluateEvidenceReadinessV2(abstaining, 0).status, "READY_FOR_ABSTENTION");
});

test("v8 staged planner uses Packet v2 without changing the v7 default", async () => {
  const aggregate = v8AggregateFixture();
  let seenVersion = "";
  const collector: InvestigationPlanner = {
    type: "LLM",
    async plan() { throw new Error("collector should not run"); },
  };
  const synthesizer: InvestigationSynthesizer = {
    type: "LLM",
    async synthesize(input) {
      seenVersion = input.evidencePacket.schemaVersion;
      return {
        type: "STOP_INCONCLUSIVE",
        reasonCode: "INSUFFICIENT_EVIDENCE",
        reason: "Test-only bounded output.",
        rationale: "Test-only synthesis.",
      };
    },
  };
  await new StagedInvestigationPlanner(
    collector, synthesizer, { packetVersion: "V2" },
  ).plan(contextFor(aggregate));
  assert.equal(seenVersion, "releaseguard-evidence-packet-v2");
  await new StagedInvestigationPlanner(collector, synthesizer).plan(contextFor(aggregate));
  assert.equal(seenVersion, "releaseguard-evidence-packet-v1");
});

test("v8 Outcome Projection turns unresolved competition into an actionable bounded result", () => {
  const aggregate = v8AggregateFixture();
  aggregate.hypotheses[1] = {
    ...aggregate.hypotheses[1], status: "SUPPORTED", confidence: "MEDIUM",
    supportScore: aggregate.hypotheses[0].supportScore, contradictionScore: 0,
  };
  aggregate.hypothesisEvidenceLinks.push(
    ...aggregate.evidence.map((evidence, index) => ({
      id: `LINK-OUTCOME-${index}`,
      runId: "RUN-V7",
      hypothesisId: "HYP-2",
      evidenceId: evidence.id,
      relation: "SUPPORTS" as const,
      explanation: "Current evidence does not distinguish this mechanism.",
      linkedBy: "AGENT" as const,
      createdAt: "2026-01-01T00:05:00.000Z",
    })),
  );
  const projection = projectInvestigationOutcomeV2(aggregate);
  assert.equal(projection.kind, "BOUNDED_HYPOTHESIS");
  if (projection.kind !== "BOUNDED_HYPOTHESIS") return;
  assert.equal(projection.leadingHypothesis, "The release introduced the regression.");
  assert.deepEqual(projection.alternativeHypotheses, [
    "An external dependency introduced the regression.",
  ]);
  assert.equal(projection.recommendation, "PAUSE_DECISION");
  assert.ok(projection.confirmedFacts.some((item) => item.includes("value=0.61")));
  assert.ok(projection.supportingEvidenceIds.length > 0);
  assert.match(projection.nextBestEvidence, /supports one leading hypothesis while refuting/);
});

test("v8 Outcome Projection produces actionable abstention without asserting a cause", () => {
  const aggregate = aggregateFixture({ includeImpact: false });
  aggregate.hypotheses = [];
  aggregate.evidence = [];
  aggregate.hypothesisEvidenceLinks = [];
  const projection = projectInvestigationOutcomeV2(aggregate);
  assert.equal(projection.kind, "ACTIONABLE_ABSTENTION");
  if (projection.kind !== "ACTIONABLE_ABSTENTION") return;
  assert.ok(projection.missingInformation.includes("RELEASE_CONTEXT"));
  assert.ok(projection.missingInformation.includes("CURRENT_IMPACT"));
  assert.equal(projection.recommendedOwner, "Release owner");
  assert.equal(projection.prohibitedActions.length, 2);
});

test("v7 staged planner bypasses collection and delegates terminal judgment to Synthesizer", async () => {
  let collectorCalls = 0;
  let synthesizerCalls = 0;
  const collector: InvestigationPlanner = {
    type: "LLM",
    async plan() {
      collectorCalls += 1;
      throw new Error("collector should not run when packet is ready");
    },
  };
  const synthesizer: InvestigationSynthesizer = {
    type: "LLM",
    async synthesize(input) {
      synthesizerCalls += 1;
      assert.equal(input.evidencePacket.readiness.status, "READY_TO_SYNTHESIZE");
      return {
        type: "STOP_INCONCLUSIVE",
        reasonCode: "INSUFFICIENT_EVIDENCE",
        reason: "Test-only abstention.",
        rationale: "Independent staged synthesis.",
      };
    },
  };
  const planner = new StagedInvestigationPlanner(collector, synthesizer);
  const decision = await planner.plan(contextFor(aggregateFixture()));
  assert.equal(decision.type, "STOP_INCONCLUSIVE");
  assert.equal(collectorCalls, 0);
  assert.equal(synthesizerCalls, 1);
});

test("v7 LLM Synthesizer receives only the Evidence Packet and uses the shared model budget", async () => {
  const aggregate = aggregateFixture();
  const readiness = evaluateEvidenceReadiness(aggregate, 5);
  const requests: Array<Record<string, unknown>> = [];
  let ordinal = 0;
  const synthesizer = new LLMInvestigationSynthesizer({
    provider: "deepseek",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-only-key",
    model: "same-model-as-collector",
    transport: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          type: "STOP_INCONCLUSIVE",
          reasonCode: "INSUFFICIENT_EVIDENCE",
          reason: "The packet does not distinguish the remaining alternatives.",
          rationale: "Abstain without inventing evidence.",
        }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const decision = await synthesizer.synthesize({
    ...contextFor(aggregate),
    evidencePacket: buildEvidencePacket(aggregate, readiness),
    readiness,
    modelCallBudget: {
      async reserve() {
        ordinal += 1;
        return {
          reserved: true as const,
          reservation: {
            id: `MCR-${ordinal}`,
            ordinal,
            maxModelCalls: 20,
            reservedAt: "2026-01-01T00:00:00.000Z",
          },
        };
      },
    },
  });
  assert.equal(decision.type, "STOP_INCONCLUSIVE");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.thinking, { type: "disabled" });
  assert.equal("tools" in (requests[0] ?? {}), false);
  assert.doesNotMatch(JSON.stringify(requests), /privateTranscript|TOOL-SECRET-TRANSCRIPT/);
  assert.equal(synthesizer.drainModelCallObservations().length, 1);
  assert.deepEqual(synthesizer.drainAttemptObservations().map((item) => item.outcome), [
    "ACCEPTED",
  ]);
});

test("Synthesizer repair receives the bounded validation code and field path", async () => {
  const aggregate = aggregateFixture();
  const readiness = evaluateEvidenceReadiness(aggregate, 5);
  const requests: Array<Record<string, unknown>> = [];
  let ordinal = 0;
  const synthesizer = new LLMInvestigationSynthesizer({
    provider: "deepseek",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-only-key",
    model: "same-model-as-collector",
    transport: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requests.length === 1 ? JSON.stringify({
        type: "FINALIZE",
        selectedHypothesisId: "HYP-1",
        diagnosis: { summary: "Release regression.", claims: [{
          type: "LIMITATION",
          statement: "The available data has a scope limitation.",
          evidenceIds: [],
        }] },
        disposition: "OBSERVE",
        rationale: "Bounded conclusion.",
      }) : JSON.stringify({
        type: "FINALIZE",
        selectedHypothesisId: "HYP-1",
        diagnosis: { summary: "Release regression.", claims: [{
          type: "ROOT_CAUSE",
          statement: "The release introduced the regression.",
          evidenceIds: ["EV-RELEASE", "EV-METRIC"],
        }] },
        disposition: "FIX",
        rationale: "The current evidence supports the selected hypothesis.",
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const decision = await synthesizer.synthesize({
    ...contextFor(aggregate),
    evidencePacket: buildEvidencePacket(aggregate, readiness),
    readiness,
    modelCallBudget: {
      async reserve() {
        ordinal += 1;
        return { reserved: true as const, reservation: {
          id: `MCR-REPAIR-${ordinal}`,
          ordinal,
          maxModelCalls: 20,
          reservedAt: "2026-01-01T00:00:00.000Z",
        } };
      },
    },
  });
  assert.equal(decision.type, "FINALIZE");
  assert.equal(requests.length, 2);
  const repairBody = JSON.stringify(requests[1]);
  assert.match(repairBody, /MISSING_REQUIRED_FIELD/);
  assert.match(repairBody, /diagnosis\.claims\[0\]\.limitationType/);
  assert.doesNotMatch(repairBody, /test-only-key/);
  assert.deepEqual(synthesizer.drainAttemptObservations().map((item) => item.outcome), [
    "REPAIR_ATTEMPTED",
    "ACCEPTED",
  ]);
});

test("Synthesizer converts exhausted validation repair into a valid abstention", async () => {
  const aggregate = aggregateFixture();
  const readiness = evaluateEvidenceReadiness(aggregate, 5);
  let ordinal = 0;
  const synthesizer = new LLMInvestigationSynthesizer({
    provider: "deepseek",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-only-key",
    model: "same-model-as-collector",
    transport: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "not valid JSON" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const decision = await synthesizer.synthesize({
    ...contextFor(aggregate),
    evidencePacket: buildEvidencePacket(aggregate, readiness),
    readiness,
    modelCallBudget: {
      async reserve() {
        ordinal += 1;
        return { reserved: true as const, reservation: {
          id: `MCR-FAILED-REPAIR-${ordinal}`,
          ordinal,
          maxModelCalls: 20,
          reservedAt: "2026-01-01T00:00:00.000Z",
        } };
      },
    },
  });
  assert.equal(decision.type, "STOP_INCONCLUSIVE");
  assert.equal(ordinal, 2);
  assert.deepEqual(synthesizer.drainAttemptObservations().map((item) => ({
    outcome: item.outcome,
    code: item.validationCode,
    response: item.publicResponse,
  })), [{
    outcome: "REPAIR_ATTEMPTED",
    code: "INVALID_JSON",
    response: "not valid JSON",
  }, {
    outcome: "REPAIR_FAILED",
    code: "INVALID_JSON",
    response: "not valid JSON",
  }]);
});

test("Synthesizer adds only a fixed public rationale when an otherwise valid decision omits it", async () => {
  const aggregate = aggregateFixture();
  const readiness = evaluateEvidenceReadiness(aggregate, 5);
  let ordinal = 0;
  const synthesizer = new LLMInvestigationSynthesizer({
    provider: "deepseek",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-only-key",
    model: "same-model-as-collector",
    transport: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      type: "FINALIZE",
      selectedHypothesisId: "HYP-1",
      diagnosis: { summary: "Release regression.", claims: [{
        type: "ROOT_CAUSE",
        statement: "The release introduced the regression.",
        evidenceIds: ["EV-RELEASE", "EV-METRIC"],
      }] },
      disposition: "FIX",
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const decision = await synthesizer.synthesize({
    ...contextFor(aggregate),
    evidencePacket: buildEvidencePacket(aggregate, readiness),
    readiness,
    modelCallBudget: { async reserve() {
      ordinal += 1;
      return { reserved: true as const, reservation: {
        id: `MCR-RATIONALE-${ordinal}`, ordinal, maxModelCalls: 20,
        reservedAt: "2026-01-01T00:00:00.000Z",
      } };
    } },
  });
  assert.equal(decision.type, "FINALIZE");
  assert.equal(decision.rationale, "基于持久化 Evidence Packet 执行独立综合，并由服务端校验结论与引用。");
  assert.equal(ordinal, 1);
});
