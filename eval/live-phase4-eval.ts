import { mkdir, writeFile } from "node:fs/promises";
import { LLMInvestigationPlanner } from "../lib/investigation/llm-planner";
import type { ModelResponseObservation } from "../lib/investigation/model";
import { phase4ScenarioInputs } from "./fixtures/phase4-scenario-inputs";
import { liveEvalExitCode } from "./live-eval-cli";
import { attachModelObservations, runLiveScenarioRuntime } from "./live-phase4-runtime";

const provider = process.env.LIVE_EVAL_PROVIDER!;
const model = process.env.LIVE_EVAL_MODEL!;
const observations: ModelResponseObservation[] = [];
const runtimeResults = [];
for (const scenario of phase4ScenarioInputs) {
  const scenarioObservations: ModelResponseObservation[] = [];
  const planner = new LLMInvestigationPlanner({
    provider, baseUrl: process.env.LIVE_EVAL_BASE_URL!, apiKey: process.env.LIVE_EVAL_API_KEY!, model,
    responseObserver: (observation) => {
      observations.push(observation);
      scenarioObservations.push(observation);
    },
  }, { maxDecisionRepairAttempts: 2 });
  const result = await runLiveScenarioRuntime(scenario, planner);
  attachModelObservations(result.plannerCalls, scenarioObservations);
  runtimeResults.push(result);
}

// Ground truth is intentionally loaded only after all scenario runtimes have completed.
const { scoreLivePhase4 } = await import("./live-phase4-scorer");
const scored = scoreLivePhase4(runtimeResults);
const usages = observations.map((item) => item.usage).filter((item) => item !== null);
const tokenUsage = usages.length === 0 ? null : {
  promptTokens: usages.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0),
  completionTokens: usages.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0),
  totalTokens: usages.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
};
const report = {
  eval: "Live LLM Agent Eval v2", timestamp: new Date().toISOString(), provider, model,
  deterministicFallback: false, tokenUsage, tokenUsageStatus: tokenUsage ? "PROVIDED" : "NOT_PROVIDED",
  modelCallCount: observations.length,
  plannerCallCount: runtimeResults.reduce((sum, item) => sum + item.plannerCalls.length, 0),
  toolCallCount: runtimeResults.reduce((sum, item) => sum
    + item.aggregate.toolCalls.filter((call) => call.proposedActionId === null).length, 0),
  totalLatencyMs: runtimeResults.reduce((sum, item) => sum + item.totalLatencyMs, 0),
  ...scored,
};
const outputDirectory = new URL("../eval-results/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const outputFile = new URL(`live-phase4-${Date.now()}.json`, outputDirectory);
await writeFile(outputFile, JSON.stringify(report, null, 2), "utf8");
console.table(scored.scenarios.map((item) => ({
  Scenario: item.scenario, RootCause: item.rootCausePass ? "PASS" : "FAIL",
  Grounding: item.groundingPass ? "PASS" : "FAIL",
  Contradiction: item.contradictionPass ? "PASS" : "FAIL", Action: item.actionPass ? "PASS" : "FAIL",
  Verification: item.verificationPass ? "PASS" : "FAIL", Final: item.finalStatePass ? "PASS" : "FAIL",
})));
console.log(JSON.stringify({ metrics: scored.metrics, runtime: {
  plannerCalls: report.plannerCallCount, toolCalls: report.toolCallCount,
  totalLatencyMs: report.totalLatencyMs, tokenUsage: report.tokenUsage,
  tokenUsageStatus: report.tokenUsageStatus }, reportFile: outputFile.pathname }, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = liveEvalExitCode(scored.pass);
