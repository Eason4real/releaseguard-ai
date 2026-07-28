import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { phase4ScenarioInputs } from "../eval/fixtures/phase4-scenario-inputs";
import { liveEvalExitCode } from "../eval/live-eval-cli";
import { attachModelObservations, runLiveScenarioRuntime } from "../eval/live-phase4-runtime";
import {
  classifyLiveRuntimeFailure,
  summarizePlannerReliability,
} from "../eval/live-phase4-scorer";
import { LLMInvestigationPlanner } from "../lib/investigation/llm-planner";
import type { ModelResponseObservation } from "../lib/investigation/model";
import type { InvestigationPlanner } from "../lib/investigation/planner";

const forbiddenKeys = /^(expected|acceptable|failureConditions|hypotheses$|relations$|benchmark)/i;
const walkKeys = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(walkKeys);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [key, ...walkKeys(item)]);
};

test("Live scenario input is physically free of ground truth fields", () => {
  assert.equal(walkKeys(phase4ScenarioInputs).filter((key) => forbiddenKeys.test(key)).length, 0);
});

test("Live runtime imports scenario input and shared AgentLoop, never ground truth", async () => {
  const source = await readFile("eval/live-phase4-runtime.ts", "utf8");
  assert.match(source, /runAgentLoop/);
  assert.doesNotMatch(source, /phase4ScenarioGroundTruth|acceptableSelectedHypotheses|expectedDisposition/);
  assert.doesNotMatch(source, /DeterministicInvestigationPlanner/);
  const entry = await readFile("eval/live-phase4-eval.ts", "utf8");
  assert.ok(entry.indexOf("runLiveScenarioRuntime") < entry.indexOf("import(\"./live-phase4-scorer\")"));
});

test("mocked OpenAI-compatible planner runs the formal multi-iteration full chain", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  let malformedAssessmentSent = false;
  globalThis.fetch = async (_input, init) => {
    modelCalls += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find((item) => item.role === "user")!.content;
    const context = JSON.parse(user.slice(user.indexOf("调查上下文：") + "调查上下文：".length)) as {
      hypotheses: Array<{ id: string; statement: string; status: string }>;
      pendingEvidenceIds: string[];
      evidence: Array<{ id: string; category: string }>;
      toolResults: Array<{ tool: string }>;
    };
    let decision: Record<string, unknown>;
    if (context.hypotheses.length === 0) {
      decision = { type: "CREATE_HYPOTHESES", hypotheses: [
        { statement: "Android 8.4.0 发布变更导致领券失败", supportIf: "版本分群和反馈一致",
          refuteIf: "旧版本同步下降" },
        { statement: "第三方依赖故障导致领券失败", supportIf: "跨版本同步失败", refuteIf: "仅新版本失败" },
      ], rationale: "建立竞争假设" };
    } else if (context.pendingEvidenceIds.length > 0) {
      if (!malformedAssessmentSent) {
        malformedAssessmentSent = true;
        decision = { type: "ASSESS_EVIDENCE", rationale: "First response intentionally omits assessments." };
      } else decision = { type: "ASSESS_EVIDENCE", assessments: context.pendingEvidenceIds.map((evidenceId) => ({
        evidenceId, relations: context.hypotheses.filter((item) => item.status !== "REJECTED")
          .map((hypothesis, index) => ({
          targetHypothesisId: hypothesis.id, relation: index === 0 ? "SUPPORTS" : "CONTRADICTS",
          explanation: "当前事件证据显式区分两个假设",
        })),
      })), rationale: "批量评价全部新证据" };
    } else if (context.toolResults.length === 0) {
      decision = { type: "CALL_TOOL", toolName: "query_metric", arguments: {
        metric_key: "coupon_claim_success_rate", start_time: "2026-07-28T00:00:00.000Z",
        end_time: "2026-07-28T01:00:00.000Z", granularity_minutes: 5, filters: {},
      }, targetHypothesisIds: context.hypotheses.filter((item) => item.status !== "REJECTED").map((item) => item.id),
      testIntent: "SUPPORT",
      rationale: "先检查当前指标" };
    } else if (context.toolResults.length === 1) {
      decision = { type: "CALL_TOOL", toolName: "search_user_feedback", arguments: { query: "领券失败" },
        targetHypothesisIds: context.hypotheses.filter((item) => item.status !== "REJECTED").map((item) => item.id),
        testIntent: "SUPPORT",
        rationale: "交叉检查用户反馈" };
    } else {
      const selected = context.hypotheses[0];
      const metric = context.evidence.find((item) => item.category === "PRODUCT_METRIC")!;
      decision = { type: "FINALIZE", selectedHypothesisId: selected.id, diagnosis: {
        summary: "当前发布与领券失败有关", claims: [
          { type: "ROOT_CAUSE", statement: selected.statement,
            evidenceIds: context.evidence.map((item) => item.id) },
          { type: "AFFECTED_METRIC", statement: "领券成功率显著下降", evidenceIds: [metric.id] },
        ],
      }, disposition: "FIX", rationale: "两个当前事件来源支持结论" };
    }
    return Response.json({ model: "mock-live-model", choices: [{ message: { role: "assistant",
      content: JSON.stringify(decision) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  try {
    const observations: ModelResponseObservation[] = [];
    const result = await runLiveScenarioRuntime(phase4ScenarioInputs[0], new LLMInvestigationPlanner({
      provider: "openai-compatible", baseUrl: "https://example.invalid/v1", apiKey: "test-only",
      model: "mock-live-model", responseObserver: (value) => observations.push(value),
    }));
    attachModelObservations(result.plannerCalls, observations);
    assert.equal(result.runtimeError, null);
    assert.ok(modelCalls >= 6);
    assert.ok(result.plannerCalls.length >= 6);
    assert.deepEqual(result.plannerCalls.slice(0, 4).map((item) => item.decision?.type),
      ["CREATE_HYPOTHESES", "CALL_TOOL", "ASSESS_EVIDENCE", "CALL_TOOL"]);
    assert.equal(result.aggregate.diagnosis?.groundingStatus, "GROUNDED");
    assert.ok(result.aggregate.hypothesisEvidenceLinks.length >= 3);
    assert.equal(result.plannerCalls.filter((item) => item.decision?.type === "ASSESS_EVIDENCE").length, 2);
    assert.equal(result.aggregate.approval?.decision, "APPROVE");
    assert.equal(result.aggregate.actionCompletions[0]?.changeReference,
      phase4ScenarioInputs[0].actionCompletion.changeReference);
    assert.equal(result.safeActionAdapterCalls, 2);
    assert.equal(result.aggregate.verificationEvaluations[0]?.outcome, "RESOLVED");
    assert.equal(result.aggregate.run.status, "RESOLVED");
    assert.equal(observations.length, modelCalls);
    assert.equal(result.plannerCalls.filter((item) => item.modelCallCount === 2).length, 1);
    assert.equal(result.plannerCalls.find((item) => item.modelCallCount === 2)?.decisionRepairAttempts, 1);
    assert.equal(result.plannerCalls.find((item) => item.modelCallCount === 2)?.tokenUsage?.totalTokens, 30);
    assert.equal(result.aggregate.auditEvents.filter((item) =>
      item.type === "PLANNER_DECISION_REPAIR_ATTEMPTED").length, 1);
    assert.equal(result.aggregate.auditEvents.filter((item) =>
      item.type === "PLANNER_DECISION_REPAIRED").length, 1);
    assert.deepEqual(summarizePlannerReliability([result]), {
      plannerDecisionCount: result.plannerCalls.length,
      invalidPlannerDecisionCount: 1,
      repairedPlannerDecisionCount: 1,
      decisionRepairCount: 1,
      decisionRepairRate: 1,
    });
    assert.equal(classifyLiveRuntimeFailure(result), null);
    const schemaFailure = structuredClone(result);
    schemaFailure.runtimeError = "Planner decision invalid";
    schemaFailure.runtimeErrorCategory = "PLANNER_SCHEMA_ERROR";
    assert.equal(classifyLiveRuntimeFailure(schemaFailure), "PLANNER_SCHEMA_ERROR");
    assert.ok(result.plannerCalls.every((item) => item.latencyMs >= 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Live runtime classifies exhausted typed Planner schema repair separately from runtime errors", async (t) => {
  for (const malformed of [
    { type: "ASSESS_EVIDENCE", rationale: "Missing required assessments." },
    { type: "CALL_TOOL", toolName: "get_release", arguments: {}, targetHypothesisIds: ["H-1"],
      testIntent: 7, rationale: "Invalid tool intent type." },
  ]) await t.test(String(malformed.type), async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: JSON.stringify(malformed) } }],
    });
    try {
      const result = await runLiveScenarioRuntime(phase4ScenarioInputs[0], new LLMInvestigationPlanner({
        provider: "openai-compatible", baseUrl: "https://example.invalid/v1", apiKey: "test-only",
        model: "mock-live-model",
      }));
      assert.equal(result.runtimeErrorCategory, "PLANNER_SCHEMA_ERROR");
      assert.equal(classifyLiveRuntimeFailure(result), "PLANNER_SCHEMA_ERROR");
      assert.equal(result.aggregate.auditEvents.filter((event) =>
        event.type === "PLANNER_DECISION_REPAIR_FAILED").length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("ordinary runtime failure", async () => {
    const planner: InvestigationPlanner = {
      type: "LLM",
      async plan() { throw new Error("Synthetic store or tool runtime failure"); },
    };
    const result = await runLiveScenarioRuntime(phase4ScenarioInputs[0], planner);
    assert.equal(result.runtimeErrorCategory, "RUNTIME_ERROR");
    assert.equal(classifyLiveRuntimeFailure(result), "RUNTIME_ERROR");
  });
});

test("missing scenario data reaches INCONCLUSIVE without harness repair", async () => {
  let step = 0;
  const planner: InvestigationPlanner = { type: "LLM", async plan(context) {
    if (step++ === 0) return { type: "CREATE_HYPOTHESES", hypotheses: [
      { statement: "发布回归", supportIf: "版本证据", refuteIf: "跨版本异常" },
      { statement: "外部依赖故障", supportIf: "依赖证据", refuteIf: "仅当前版本" },
    ], rationale: "建立待验证假设" };
    const tools = ["query_metric", "segment_metric", "search_user_feedback"] as const;
    const index = context.aggregate.toolCalls.filter((item) => item.proposedActionId === null).length;
    const toolName = tools[Math.min(index, tools.length - 1)];
    const common = { metric_key: "checkout_success_rate", start_time: "2026-07-28T00:00:00.000Z",
      end_time: "2026-07-28T01:00:00.000Z" };
    const args = toolName === "query_metric" ? { ...common, granularity_minutes: 5 }
      : toolName === "segment_metric" ? { ...common, dimension: "app_version" }
        : { query: "checkout failure" };
    return { type: "CALL_TOOL", toolName, arguments: args,
      targetHypothesisIds: context.aggregate.hypotheses.map((item) => item.id),
      testIntent: "DISCRIMINATE", rationale: "尝试获取缺失数据" };
  } };
  const result = await runLiveScenarioRuntime(phase4ScenarioInputs[3], planner);
  assert.equal(result.runtimeError, null);
  assert.equal(result.aggregate.run.status, "INCONCLUSIVE");
  assert.equal(result.aggregate.diagnosis, null);
  assert.equal(result.aggregate.proposedAction, null);
  assert.equal(result.aggregate.run.stopReason, "NO_NEW_EVIDENCE");
});

test("OBSERVE follows formal verification without creating action artifacts", async () => {
  let step = 0;
  const planner: InvestigationPlanner = { type: "LLM", async plan(context) {
    if (step++ === 0) return { type: "CREATE_HYPOTHESES", hypotheses: [
      { statement: "营销活动带来自然流量增长", supportIf: "质量指标和反馈稳定", refuteIf: "失败率同步上升" },
      { statement: "产品故障导致重复请求", supportIf: "失败反馈上升", refuteIf: "用户体验稳定" },
    ], rationale: "区分活动流量和产品故障" };
    const active = context.aggregate.hypotheses.filter((item) => item.status !== "REJECTED");
    const pending = context.aggregate.evidence.filter((evidence) => active.some((hypothesis) =>
      !context.aggregate.hypothesisEvidenceLinks.some((link) => link.evidenceId === evidence.id
        && link.hypothesisId === hypothesis.id)));
    if (pending.length) return { type: "ASSESS_EVIDENCE", assessments: pending.map((evidence) => ({
      evidenceId: evidence.id, relations: active.map((hypothesis, index) => ({
        targetHypothesisId: hypothesis.id,
        relation: index === 0 ? "SUPPORTS" as const : "CONTRADICTS" as const,
        explanation: "当前数据支持自然变化并反驳故障",
      })),
    })), rationale: "显式评价当前证据" };
    const toolCount = context.aggregate.toolCalls.filter((item) => item.proposedActionId === null).length;
    if (toolCount === 0) return { type: "CALL_TOOL", toolName: "query_metric", arguments: {
      metric_key: "coupon_claim_request_count", start_time: "2026-07-28T00:00:00.000Z",
      end_time: "2026-07-28T01:00:00.000Z", granularity_minutes: 5, filters: { region: "AU" },
    }, targetHypothesisIds: active.map((item) => item.id), testIntent: "DISCRIMINATE",
    rationale: "检查活动窗口指标" };
    if (toolCount === 1) return { type: "CALL_TOOL", toolName: "search_user_feedback",
      arguments: { query: "营销活动" }, targetHypothesisIds: active.map((item) => item.id),
      testIntent: "SUPPORT", rationale: "检查用户反馈" };
    const selected = active[0];
    const metric = context.aggregate.evidence.find((item) => item.category === "PRODUCT_METRIC")!;
    return { type: "FINALIZE", selectedHypothesisId: selected.id, diagnosis: {
      summary: "活动流量增长且质量稳定", claims: [
        { type: "ROOT_CAUSE", statement: selected.statement,
          evidenceIds: context.aggregate.evidence.map((item) => item.id) },
        { type: "AFFECTED_METRIC", statement: "领券请求量上升", evidenceIds: [metric.id] },
      ],
    }, disposition: "OBSERVE", rationale: "无需外部修复，进入观察验证" };
  } };
  const result = await runLiveScenarioRuntime(phase4ScenarioInputs[2], planner);
  assert.equal(result.runtimeError, null);
  assert.equal(result.aggregate.diagnosis?.disposition, "OBSERVE");
  assert.equal(result.aggregate.proposedActions.length, 0);
  assert.equal(result.aggregate.approvals.length, 0);
  assert.equal(result.aggregate.actionCompletions.length, 0);
  assert.equal(result.safeActionAdapterCalls, 0);
  assert.equal(result.aggregate.verificationEvaluations[0]?.outcome, "RESOLVED");
  assert.equal(result.aggregate.run.status, "RESOLVED");
});

test("live eval missing credentials skips with exit zero and no model call", () => {
  const result = spawnSync(process.execPath, ["scripts/run-live-eval.mjs"], {
    cwd: process.cwd(), encoding: "utf8", env: {
      ...process.env, LIVE_EVAL_PROVIDER: "", LIVE_EVAL_BASE_URL: "",
      LIVE_EVAL_API_KEY: "", LIVE_EVAL_MODEL: "",
    },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /LIVE_EVAL_SKIPPED/);
  assert.match(result.stdout, /reason = missing credentials/);
});

test("live reports and source never serialize credentials or authorization headers", async () => {
  const sources = await Promise.all(["eval/live-phase4-eval.ts", "eval/live-phase4-runtime.ts"]
    .map((file) => readFile(file, "utf8")));
  assert.doesNotMatch(sources[0], /apiKey\s*[:,]\s*report|Authorization/);
  assert.doesNotMatch(sources[1], /Authorization/);
  assert.match(sources[0], /process\.exitCode = liveEvalExitCode\(scored\.pass\)/);
});

test("configured live scenario failure maps to a non-zero process exit", () => {
  assert.equal(liveEvalExitCode(false), 1);
  assert.equal(liveEvalExitCode(true), 0);
});

test("missing provider usage remains null without token estimation", () => {
  const calls = attachModelObservations([{
    sequence: 1, latencyMs: 1, decision: null, error: null, hypotheses: [], evidence: [],
    evidenceRelations: [], tokenUsage: { promptTokens: 999, completionTokens: 999, totalTokens: 999 },
    tokenUsageStatus: "PROVIDED", responseModel: "stale", modelCallCount: 99,
    modelLatencyMs: 99, decisionRepairAttempts: 99,
  }], []);
  assert.equal(calls[0].tokenUsage, null);
  assert.equal(calls[0].tokenUsageStatus, "NOT_PROVIDED");
  assert.equal(calls[0].responseModel, null);
  assert.equal(calls[0].modelCallCount, 0);
  assert.equal(calls[0].decisionRepairAttempts, 0);
});
