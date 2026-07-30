import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { callModel } from "../lib/investigation/model";
import { loadInvestigationBenchmarkDevDataset } from
  "../eval/investigation-benchmark/dataset/dev";
import {
  LiveHarnessConfigurationError,
  LiveLLMHarnessProvider,
  assertLivePreflightIsolation,
  createLiveLLMHarnessProviderFactory,
  loadLivePreflightFixture,
  resolveLiveHarnessCommand,
  runLivePreflight,
  type LiveHarnessModelConfig,
} from "../eval/investigation-benchmark/harness";

const SECRET = "PREFLIGHT_TEST_ONLY_NOT_A_REAL_SECRET";
const ROOT_CAUSE = "The test-only release changed receipt rendering behavior.";

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

test("isolated preflight executes the Live adapter without scorer or benchmark aggregate", async () => {
  const requests: Array<{ url: string; context: string }> = [];
  const report = await runLivePreflight({
    sourceCommit: "PREFLIGHT_TEST_ONLY",
    providerFactory: createLiveLLMHarnessProviderFactory(config(successfulTransport(requests))),
  });

  assert.equal(report.label, "Live Agent Preflight");
  assert.equal(report.executionPurpose, "PREFLIGHT_ONLY");
  assert.equal(report.benchmarkEligible, false);
  assert.equal(report.caseId, "CASE-901");
  assert.equal(report.executionProvider, "LIVE_LLM_PROVIDER");
  assert.equal(report.terminalState, "FINALIZED");
  assert.equal(report.modelCallCount, 4);
  assert.equal(report.toolCallCount, 1);
  assert.deepEqual(report.tokenUsage, {
    inputTokens: 40,
    outputTokens: 20,
    totalTokens: 60,
    completeness: "COMPLETE",
  });
  assert.deepEqual(report.plannerActions,
    ["CREATE_HYPOTHESES", "CALL_TOOL", "ASSESS_EVIDENCE", "FINALIZE"]);
  assert.equal(report.schemaRepairCount, 0);
  assert.deepEqual(report.toolTrajectory, [{
    order: 1,
    iteration: 2,
    toolCallId: "TOOL_CALL-001",
    toolName: "get_release",
    arguments: { release_id: "REL-901" },
    status: "COMPLETED",
    resultStatus: "SUCCESS",
    observationMetadata: {
      valueType: "object",
      topLevelKeys: ["data", "schema_version"],
      itemCount: null,
    },
    evidenceIds: ["EV-14030"],
    error: null,
  }]);
  assert.equal("aggregate" in report, false);
  assert.equal("breakdown" in report, false);
  assert.equal("scoring" in report, false);
  assert.equal("datasetHash" in report, false);
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
  assert.equal(report.provider, "openai-compatible");
  assert.equal(report.endpoint, "https://example.test/v1/chat/completions");
  assert.equal(report.model, "stub-model");
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

test("preflight fixture is physically isolated from the governed Dev dataset", () => {
  const fixture = loadLivePreflightFixture();
  const dataset = loadInvestigationBenchmarkDevDataset();
  const caseIds = dataset.manifest.caseEntries.map((entry) => entry.caseId);
  assert.equal(fixture.executionPurpose, "PREFLIGHT_ONLY");
  assert.equal(fixture.benchmarkEligible, false);
  assert.equal(fixture.caseId, "CASE-901");
  assert.equal(caseIds.includes(fixture.caseId), false);
  assert.equal(dataset.fixtures.some((item) => item.benchmarkCase.caseId === fixture.caseId), false);
  assert.doesNotThrow(() => assertLivePreflightIsolation(fixture, caseIds));
  assert.throws(
    () => assertLivePreflightIsolation(fixture, [...caseIds, fixture.caseId]),
    /PREFLIGHT_CASE_COLLIDES_WITH_GOVERNED_DEV/,
  );
  const serialized = JSON.stringify(fixture);
  for (const forbidden of [
    "groundTruth", "canonicalRootCause", "acceptableAliases", "requiredEvidenceIds",
    "supportingEvidenceIds", "distractorEvidenceIds", "category", "difficulty", "split",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("Live command resolver makes preflight explicit and rejects every case argument", () => {
  assert.deepEqual(resolveLiveHarnessCommand(["--provider=live", "--preflight"]), {
    mode: "PREFLIGHT",
  });
  assert.throws(
    () => resolveLiveHarnessCommand(["--provider=live", "--preflight", "--case=CASE-201"]),
    /PREFLIGHT_CASE_ARGUMENT_FORBIDDEN/,
  );
  assert.throws(
    () => resolveLiveHarnessCommand(["--provider=live", "--preflight", "--case=CASE-901"]),
    /PREFLIGHT_CASE_ARGUMENT_FORBIDDEN/,
  );
  assert.deepEqual(resolveLiveHarnessCommand(["--provider=live", "--case=CASE-201"]), {
    mode: "DEV",
    caseId: "CASE-201",
  });
  assert.throws(() => resolveLiveHarnessCommand(["--preflight"]),
    /LIVE_BENCHMARK_EXPLICIT_OPT_IN_REQUIRED/);
});

test("Live provider redacts secrets and classifies provider failures with zero transport retries", async () => {
  const request = loadLivePreflightFixture().request;
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
    assert.equal(outcome.telemetry?.terminalState, "FAILED");
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
  assert.ok(source.indexOf("resolveLiveHarnessCommand") < source.indexOf("LIVE_EVAL_API_KEY"));
  assert.match(source, /command\.mode === "PREFLIGHT"/);
  assert.match(source, /runLivePreflight/);
  const scripts = (JSON.parse(packageSource) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["eval:investigation-live"],
    "node scripts/run-investigation-benchmark-live.mjs");
  for (const name of ["test", "eval", "build"]) {
    assert.equal(scripts[name].includes("run-investigation-benchmark-live"), false);
  }
});
