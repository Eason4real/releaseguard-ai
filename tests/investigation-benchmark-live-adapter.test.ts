import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { callModel } from "../lib/investigation/model";
import { lockInvestigationBenchmarkDataset } from
  "../eval/investigation-benchmark/dataset/hash";
import { authorDevCase } from
  "../eval/investigation-benchmark/dataset/dev/case-builder";
import type { InvestigationBenchmarkDatasetDefinition } from
  "../eval/investigation-benchmark/dataset/types";
import {
  LiveHarnessConfigurationError,
  LiveLLMHarnessProvider,
  __testOnly,
  createLiveLLMHarnessProviderFactory,
  runInvestigationBenchmarkHarness,
  type HarnessAgentRequest,
  type LiveHarnessModelConfig,
} from "../eval/investigation-benchmark/harness";

const SECRET = "PREFLIGHT_TEST_ONLY_NOT_A_REAL_SECRET";
const ROOT_CAUSE = "The test-only release changed receipt rendering behavior.";

const authored = authorDevCase({
  number: 901,
  title: "NON_BENCHMARK live adapter fixture",
  question: "Why did receipt rendering change after the test-only release?",
  symptom: "PREFLIGHT_TEST_ONLY receipt rendering symptom.",
  category: "release_regression",
  templateFamily: "TPL-901",
  provenance: { sourceType: "synthetic", description: "PREFLIGHT_TEST_ONLY wiring fixture." },
  metricKey: "receipt_render_success_rate",
  filters: { platform: "Web" },
  observedValue: 0.7,
  baselineValue: 0.95,
  release: {
    version: "test-only-1",
    platform: "Web",
    rolloutStatus: "FULL",
    rolloutPercentage: 100,
    featureFlags: ["receipt_test_only"],
    changedModules: ["ReceiptRenderer"],
  },
  observations: [{
    sourceKey: "release",
    sourceKind: "release",
    toolName: "get_release",
    role: "CAUSAL",
    payload: {
      schema_version: "1",
      data: {
        id: "REL-901",
        version: "test-only-1",
        platform: "Web",
        changed_modules: ["ReceiptRenderer"],
      },
    },
  }],
  requiredObservationIndexes: [0],
  supportingObservationIndexes: [0],
  distractorObservationIndexes: [],
  canonicalRootCause: ROOT_CAUSE,
  acceptableAliases: ["Receipt rendering changed in the test-only release"],
  semanticDifficulty: {
    plausibleHypotheses: 0,
    causalDirectness: 0,
    temporalCorrelationTrap: 0,
    evidenceCompleteness: 0,
  },
  reviewNotes: [
    "NON_BENCHMARK: root cause exists only to prove scorer compatibility.",
    "PREFLIGHT_TEST_ONLY: one read-only release observation is tool-solvable.",
    "TEST_ONLY: no formal Dev or Holdout identity is used.",
  ],
});

const testDataset = async () => {
  const fixtureRef = "test-only-fixture://FX-901";
  const fixture = structuredClone(authored.fixture);
  fixture.fixtureRef = fixtureRef;
  fixture.fixtureData = { datasetStage: "PREFLIGHT_TEST_ONLY" };
  const definition: InvestigationBenchmarkDatasetDefinition = {
    manifest: {
      schemaVersion: "1",
      datasetId: "NON_BENCHMARK",
      purpose: "TEST_ONLY",
      version: "0.0.0",
      evaluationContractVersion: "phase1a-v1",
      createdAt: "2031-01-01T00:00:00.000Z",
      updatedAt: "2031-01-01T00:00:00.000Z",
      expectedDatasetHash: null,
      caseEntries: [{ ...structuredClone(authored.entry), fixtureRef }],
    },
    fixtures: [fixture],
  };
  return lockInvestigationBenchmarkDataset(definition);
};

const plannerContext = (init: RequestInit | undefined) => {
  const body = JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string; content: string }>;
  };
  return body.messages.at(-1)?.content ?? "";
};

const idFrom = (context: string, collection: "hypotheses" | "evidence") => {
  const match = context.match(new RegExp(`"${collection}":\\[\\{"id":"([^"]+)"`));
  assert.ok(match, `${collection} id must be present in Planner context`);
  return match[1];
};

const response = (decision: unknown) => Response.json({
  model: "stub-model",
  choices: [{ message: { role: "assistant", content: JSON.stringify(decision) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const successfulTransport = (requests: Array<{ url: string; context: string }>): typeof fetch => {
  let call = 0;
  return async (input, init) => {
    const context = plannerContext(init);
    requests.push({ url: String(input), context });
    call += 1;
    if (call === 1) return response({
      type: "CREATE_HYPOTHESES",
      rationale: "Create one test-only hypothesis.",
      hypotheses: [{
        statement: ROOT_CAUSE,
        supportIf: "The release tool returns the changed receipt module.",
        refuteIf: "The release tool shows no receipt change.",
      }],
    });
    const hypothesisId = idFrom(context, "hypotheses");
    if (call === 2) return response({
      type: "CALL_TOOL",
      rationale: "Read release context through the production AgentLoop.",
      toolName: "get_release",
      arguments: { release_id: "REL-901" },
      targetHypothesisIds: [hypothesisId],
      testIntent: "SUPPORT",
    });
    const evidenceId = idFrom(context, "evidence");
    if (call === 3) return response({
      type: "ASSESS_EVIDENCE",
      rationale: "Assess the tool observation before finalization.",
      assessments: [{
        evidenceId,
        relations: [{
          targetHypothesisId: hypothesisId,
          relation: "SUPPORTS",
          explanation: "The read-only release observation supports the test hypothesis.",
        }],
      }],
    });
    return response({
      type: "FINALIZE",
      rationale: "Finalize the grounded test-only result.",
      selectedHypothesisId: hypothesisId,
      diagnosis: {
        summary: "The release observation supports the receipt rendering change.",
        claims: [{ type: "ROOT_CAUSE", statement: ROOT_CAUSE, evidenceIds: [evidenceId] }],
      },
      disposition: "OBSERVE",
    });
  };
};

const config = (transport: typeof fetch): LiveHarnessModelConfig => ({
  provider: "openai-compatible",
  baseUrl: "https://user:password@example.test/v1/?query=must-not-persist",
  apiKey: SECRET,
  model: "stub-model",
  transport,
});

test("Live adapter executes LLM Planner, structured tool call, observation feedback, and scorer", async () => {
  const requests: Array<{ url: string; context: string }> = [];
  const dataset = await testDataset();
  const report = await runInvestigationBenchmarkHarness(dataset, {
    sourceCommit: "PREFLIGHT_TEST_ONLY",
    providerFactory: createLiveLLMHarnessProviderFactory(config(successfulTransport(requests))),
    caseId: "CASE-901",
    runId: "NON_BENCHMARK-LIVE-ADAPTER",
  });

  assert.equal(report.label, "Live LLM Benchmark");
  assert.equal(report.manifest.executionProvider, "LIVE_LLM_PROVIDER");
  assert.equal(report.manifest.runtimeMode, "LIVE_LLM");
  assert.equal(report.manifest.totalCases, 1);
  assert.equal(report.manifest.completedCases, 1);
  assert.equal(report.cases[0].execution.terminalInvestigationState, "FINALIZED");
  assert.equal(report.cases[0].execution.modelCallCount, 4);
  assert.equal(report.cases[0].execution.toolCallCount, 1);
  assert.deepEqual(report.cases[0].normalizedPrediction?.tokenUsage, {
    inputTokens: 40,
    outputTokens: 20,
    totalTokens: 60,
    completeness: "COMPLETE",
  });
  assert.equal(report.cases[0].normalizedPrediction?.predictedRootCause, ROOT_CAUSE);
  assert.deepEqual(report.cases[0].normalizedPrediction?.citedEvidenceIds, ["EV-14030"]);
  assert.equal(report.cases[0].scoring.rootCause.correct, true);
  assert.equal(report.cases[0].scoring.evidence.precision, 1);
  assert.equal(report.cases[0].scoring.grounding.unsupportedClaimRate, 0);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((item) => item.url === "https://example.test/v1/chat/completions"));
  assert.match(requests[2].context, /get_release/);
  assert.match(requests[2].context, /ReceiptRenderer/);

  const serializedRequests = JSON.stringify(requests);
  for (const forbidden of [
    "CASE-901", "NON_BENCHMARK", "PREFLIGHT_TEST_ONLY", "groundTruth", "difficulty",
    "canonicalRootCause", "acceptableAliases", "requiredEvidenceIds", "supportingEvidenceIds",
    "distractorEvidenceIds", SECRET,
  ]) assert.equal(serializedRequests.includes(forbidden), false, forbidden);

  const serializedReport = JSON.stringify(report);
  assert.equal(serializedReport.includes(SECRET), false);
  assert.equal(serializedReport.includes("user:password"), false);
  assert.equal(serializedReport.includes("must-not-persist"), false);
  assert.deepEqual(report.manifest.modelConfiguration, {
    provider: "openai-compatible",
    endpointType: "OPENAI_COMPATIBLE_CHAT_COMPLETIONS",
    baseUrl: "https://example.test/v1/chat/completions",
    model: "stub-model",
    temperature: 0.1,
    topP: "PROVIDER_DEFAULT",
    maxOutputTokens: 5000,
    reasoningConfig: "PROVIDER_DEFAULT",
    maxModelCalls: 20,
    toolBudget: 10,
    maxIterations: 16,
    timeoutMs: 75_000,
    schemaRepairMax: 1,
    transportRetry: 0,
    concurrency: 1,
    credentialPresent: true,
  });
});

test("OpenAI-compatible client redacts a credential echoed by provider or transport errors", async () => {
  for (const transport of [
    async () => new Response(`provider echoed ${SECRET}`, { status: 401 }),
    async () => { throw new Error(`transport echoed ${SECRET}`); },
  ] as Array<typeof fetch>) {
    await assert.rejects(
      callModel(config(transport), [{ role: "user", content: "PREFLIGHT_TEST_ONLY" }]),
      (error) => error instanceof Error
        && error.message.includes("[redacted]")
        && !error.message.includes(SECRET),
    );
  }
});

test("Live configuration is explicit and provider-agnostic without deterministic fallback", () => {
  const transport: typeof fetch = async () => response({});
  const valid = config(transport);
  for (const [field, code] of [
    ["provider", "LIVE_PROVIDER_REQUIRED"],
    ["baseUrl", "LIVE_BASE_URL_REQUIRED"],
    ["apiKey", "LIVE_API_KEY_REQUIRED"],
    ["model", "LIVE_MODEL_REQUIRED"],
  ] as const) {
    const candidate = { ...valid, [field]: "" };
    assert.throws(
      () => createLiveLLMHarnessProviderFactory(candidate),
      (error) => error instanceof LiveHarnessConfigurationError && error.code === code,
    );
  }
  assert.throws(
    () => createLiveLLMHarnessProviderFactory({ ...valid, provider: "other" as never }),
    (error) => error instanceof LiveHarnessConfigurationError
      && error.code === "LIVE_PROVIDER_INVALID",
  );
  assert.doesNotThrow(() => createLiveLLMHarnessProviderFactory({ ...valid, provider: "deepseek" }));
  assert.doesNotThrow(() => createLiveLLMHarnessProviderFactory({
    ...valid,
    provider: "openai-compatible",
  }));
});

test("Live provider redacts secrets and classifies provider failures with zero transport retries", async () => {
  const fixture = (await testDataset()).fixtures[0];
  const request: HarnessAgentRequest = __testOnly.observationRequest(fixture);
  const cases: Array<{
    expected: string;
    timeout?: number;
    transport: (count: { value: number }) => typeof fetch;
    calls: number;
  }> = [
    {
      expected: "PROVIDER_AUTHENTICATION_FAILED",
      calls: 1,
      transport: (count) => async () => {
        count.value += 1;
        return new Response(`credential ${SECRET}`, { status: 401 });
      },
    },
    {
      expected: "PROVIDER_RATE_LIMITED",
      calls: 1,
      transport: (count) => async () => {
        count.value += 1;
        return new Response("rate limited", { status: 429 });
      },
    },
    {
      expected: "PROVIDER_TIMEOUT",
      timeout: 5,
      calls: 1,
      transport: (count) => async (_input, init) => {
        count.value += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    },
    {
      expected: "PROVIDER_MALFORMED_RESPONSE",
      calls: 2,
      transport: (count) => async () => {
        count.value += 1;
        return Response.json({ choices: [] });
      },
    },
  ];

  for (const scenario of cases) {
    const count = { value: 0 };
    const provider = new LiveLLMHarnessProvider({
      ...config(scenario.transport(count)),
      ...(scenario.timeout ? { requestTimeoutMs: scenario.timeout } : {}),
    });
    const outcome = await provider.execute(request);
    assert.equal(outcome.status, "FAIL");
    assert.equal(outcome.error, scenario.expected);
    assert.equal(count.value, scenario.calls);
    assert.equal(JSON.stringify({ provider, outcome }).includes(SECRET), false);
  }
});

test("Live CLI requires explicit opt-in and is absent from default test, eval, and build scripts", async () => {
  const [source, packageSource] = await Promise.all([
    readFile(resolve("scripts/run-investigation-benchmark-live.mjs"), "utf8"),
    readFile(resolve("package.json"), "utf8"),
  ]);
  assert.match(source, /--provider=live/);
  assert.ok(source.indexOf("--provider=live") < source.indexOf("LIVE_EVAL_API_KEY"));
  const scripts = (JSON.parse(packageSource) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["eval:investigation-live"],
    "node scripts/run-investigation-benchmark-live.mjs");
  for (const name of ["test", "eval", "build"]) {
    assert.equal(scripts[name].includes("run-investigation-benchmark-live"), false);
  }
});
