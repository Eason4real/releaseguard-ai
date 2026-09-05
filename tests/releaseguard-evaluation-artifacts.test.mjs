import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));

test("frozen evaluation artifacts retain the governed dataset identity and scoring contract", async () => {
  const dataset = await readJson("evaluation/dataset/frozen-cases.json");
  const scoring = await readJson("evaluation/config/scoring.json");
  const model = await readJson("evaluation/config/model.json");
  assert.equal(dataset.cases.length, 22);
  assert.equal(dataset.source_dataset.version, "0.2.0");
  assert.equal(dataset.source_dataset.expectedDatasetHash,
    "c07959702947f821eaf635b68ec2a2d162dee403c3c9ebc3fea2b4689c4fb073");
  assert.deepEqual(scoring.root_cause.strict_correct_scores, [2]);
  assert.deepEqual(scoring.root_cause.lenient_hit_scores, [1, 2]);
  assert.equal(scoring.stability.runs_per_case_per_system, 3);
  assert.equal(model.current_agent.max_model_calls, 20);
  assert.equal(model.current_agent.max_tool_calls, 10);
  assert.equal(model.current_agent.max_iterations, 16);
});

test("benchmark UI fetches the latest generated summary and contains no hand-maintained result values", async () => {
  const source = await readFile(new URL("app/benchmark/page.tsx", root), "utf8");
  assert.match(source, /fetch\("\/evaluation\/summary-v7\.json"/);
  assert.match(source, /HARNESS_V7: "Harness v7"/);
  assert.match(source, /summary\.systems\.length/);
  assert.doesNotMatch(source, /strictAccuracy\s*[:=]\s*\d/);
  assert.doesNotMatch(source, /technicalCompletion\s*[:=]\s*\d/);
  assert.match(source, /16 个合成案例和 6 个仓库原生案例/);
  assert.match(source, /非独立 LLM 评审/);
});

test("Harness v2 artifacts stay versioned and require three anonymous outputs per case", async () => {
  const judge = await readFile(new URL("eval/releaseguard-evaluation/blind-judge.ts", root), "utf8");
  const runner = await readFile(new URL("scripts/run-releaseguard-blind-judge-v2.mjs", root), "utf8");
  assert.match(judge, /predictionSet === "V1" \? 9 : 3/);
  assert.match(judge, /type HarnessPredictionSet = "HARNESS_V2" \| "HARNESS_V3"/);
  assert.match(judge, /if \(predictionSet !== "V1"\)/);
  assert.match(runner, /evaluation\/results\/v2\/judge/);
  assert.match(runner, /skipCaseIds: completedCaseIds/);
  assert.match(runner, /PROVIDER_QUOTA_EXHAUSTED/);
});

test("Harness v3 uses isolated run and blind-judge artifacts", async () => {
  const judge = await readFile(new URL("eval/releaseguard-evaluation/blind-judge.ts", root), "utf8");
  const runner = await readFile(new URL("scripts/run-releaseguard-blind-judge-v3.mjs", root), "utf8");
  const series = await readFile(new URL("scripts/run-harness-v3-series.sh", root), "utf8");
  assert.match(judge, /predictionSet === "V1" \? 9 : 3/);
  assert.match(judge, /evaluation\/results\/\$\{version\}\/raw\/harness-\$\{version\}-run-/);
  assert.match(runner, /evaluation\/results\/v3\/judge/);
  assert.match(runner, /predictionSet: "HARNESS_V3"/);
  assert.match(series, /evaluation\/results\/v3/);
  assert.match(series, /LIVE_EVAL_SOURCE_IDENTITY/);
  assert.doesNotMatch(series, /evaluation\/results\/v2/);
});

test("Harness v3 summary is reproducible and includes all versioned slices", async () => {
  const summary = await readJson("evaluation/results/v3/summary.json");
  const script = await readFile(new URL("scripts/generate-releaseguard-v3-comparison.mjs", root), "utf8");
  assert.equal(summary.systems.at(-1).system, "HARNESS_V3");
  assert.equal(summary.systems.at(-1).trials, 66);
  assert.equal(summary.judge.scoredOutputs, 66);
  for (const values of Object.values(summary.slices.category)) assert.ok(values.HARNESS_V3);
  assert.match(script, /V3_RUN_IDENTITY_OR_COVERAGE_INVALID/);
  assert.match(script, /EXPERIMENTAL_DEV_NOT_HOLDOUT/);
});

test("Harness v7 uses isolated run and resumable blind-judge artifacts", async () => {
  const judge = await readFile(new URL("eval/releaseguard-evaluation/blind-judge.ts", root), "utf8");
  const runner = await readFile(new URL("scripts/run-releaseguard-blind-judge-v7.mjs", root), "utf8");
  const series = await readFile(new URL("scripts/run-harness-v7-series.sh", root), "utf8");
  assert.match(judge, /"HARNESS_V7"/);
  assert.match(runner, /evaluation\/results\/v7\/judge/);
  assert.match(runner, /predictionSet: "HARNESS_V7"/);
  assert.match(runner, /skipCaseIds: completedCaseIds/);
  assert.match(runner, /PROVIDER_QUOTA_EXHAUSTED/);
  assert.match(series, /evaluation\/results\/v7/);
  assert.match(series, /LIVE_EVAL_SOURCE_IDENTITY/);
  assert.doesNotMatch(series, /evaluation\/results\/v[1-6]\//);
});

test("Harness v7 offline ablation is frozen-trajectory-only and does not access Gold", async () => {
  const script = await readFile(new URL("scripts/run-releaseguard-v7-offline-ablation.mjs", root), "utf8");
  assert.match(script, /FROZEN_V7_TRAJECTORIES_ONLY/);
  assert.match(script, /goldAccess: "NONE"/);
  assert.match(script, /modelCalls: 0/);
  assert.doesNotMatch(script, /frozen-cases/);
});

test("Harness v7 synthesis probe reuses frozen evidence without tools or Gold", async () => {
  const script = await readFile(new URL("scripts/run-releaseguard-v7-synthesis-repair-probe.mjs", root), "utf8");
  assert.match(script, /FROZEN_EVIDENCE_PACKET_NO_TOOLS_NO_GOLD/);
  assert.match(script, /remainingToolCalls: 0/);
  assert.match(script, /if \(ordinal >= 2\)/);
  assert.doesNotMatch(script, /frozen-cases|gold_root_cause|scoreInvestigationCase/);
});

test("Harness v7 synthesis probe scoring is a separate post-model boundary", async () => {
  const script = await readFile(new URL("scripts/score-releaseguard-v7-synthesis-repair-probe.mjs", root), "utf8");
  assert.match(script, /SCORING_RUN_AFTER_MODEL_OUTPUTS; GOLD_WAS_NOT_MODEL_VISIBLE/);
  assert.match(script, /scoreInvestigationCase/);
  assert.doesNotMatch(script, /callModel|LIVE_EVAL_API_KEY/);
});

test("Harness v7 probe judge keeps Gold in a judge-only post-synthesis process", async () => {
  const script = await readFile(new URL("scripts/run-releaseguard-v7-probe-blind-judge.mjs", root), "utf8");
  assert.match(script, /JUDGE_ONLY; GOLD_NOT_VISIBLE_TO_SYNTHESIZER/);
  assert.match(script, /anonymous_output/);
  assert.doesNotMatch(script, /LLMInvestigationSynthesizer|buildEvidencePacket/);
});

test("Harness v8 smoke input enforces a file-level Agent and evaluator boundary", async () => {
  const generator = await import("../scripts/generate-releaseguard-v8-offline-smoke-input.mjs");
  const dataset = await readJson("evaluation/dataset/frozen-cases.json");
  const ablation = await readJson("evaluation/results/v7/ablation.json");
  const sourceReports = new Map();
  for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
    const report = await readJson(`evaluation/results/v7/raw/harness-v7-run-${runIndex}.json`);
    for (const item of report.cases) sourceReports.set(`${runIndex}:${item.caseId}`, item);
  }
  const { agentInput, evaluatorManifest } = generator.buildSanitizedSmokeArtifacts({
    dataset,
    ablation,
    sourceReports,
  });
  const serialized = JSON.stringify(agentInput);
  assert.equal(agentInput.samples.length, 17);
  assert.doesNotMatch(serialized, /CASE-\d+/);
  assert.doesNotMatch(serialized, /gold_root_cause|critical_evidence_ids|acceptable_equivalents/i);
  assert.doesNotMatch(serialized, /unacceptable_statements|review_status|difficulty_score/i);
  assert.equal(evaluatorManifest.samples.length, 17);
  assert.match(JSON.stringify(evaluatorManifest), /CASE-201/);
  for (const sample of agentInput.samples) {
    assert.ok(sample.aggregate.toolCalls.length > 0);
    assert.ok(sample.aggregate.toolCalls.every((call) => call.result?.output));
  }
});

test("Harness v8 smoke model runner cannot load dataset or evaluator-only mapping", async () => {
  const runner = await readFile(new URL("scripts/run-releaseguard-v8-offline-smoke.mjs", root), "utf8");
  const validator = await readFile(new URL("scripts/validate-releaseguard-v8-offline-smoke-input.mjs", root), "utf8");
  const scorer = await readFile(new URL("scripts/score-releaseguard-v8-offline-smoke.mjs", root), "utf8");
  assert.match(runner, /input\/agent-input\.json/);
  assert.match(runner, /remainingToolCalls: 0/);
  assert.match(runner, /if \(ordinal >= 2\)/);
  assert.doesNotMatch(runner, /frozen-cases|evaluator-manifest|scoreInvestigationCase|caseId/);
  assert.match(scorer, /EVALUATOR_MANIFEST_AND_GOLD_NOT_MODEL_VISIBLE/);
  assert.match(scorer, /scoreInvestigationCase/);
  assert.doesNotMatch(scorer, /LLMInvestigationSynthesizer|LIVE_EVAL_API_KEY|callModel/);
  assert.match(validator, /V8_SMOKE_AGENT_INPUT_LEAKAGE_DETECTED/);
  assert.match(validator, /V8_SMOKE_PACKET_FACTS_INVALID/);
  assert.match(validator, /V8_SMOKE_SOURCE_IDENTITY_MISMATCH/);
});

test("Harness v8 smoke blind judge is post-synthesis and system-anonymous", async () => {
  const judge = await readFile(new URL("scripts/run-releaseguard-v8-smoke-blind-judge.mjs", root), "utf8");
  assert.match(judge, /JUDGE_ONLY; ANSWER_NOT_VISIBLE_TO_SYNTHESIZER; SYSTEM_IDENTITY_HIDDEN/);
  const inputBlock = judge.slice(judge.indexOf("const input ="), judge.indexOf("let judged"));
  assert.doesNotMatch(inputBlock, /caseId|seriesId|HARNESS_V8/);
  assert.match(inputBlock, /anonymous_output/);
  assert.doesNotMatch(judge, /LLMInvestigationSynthesizer|buildEvidencePacketV2/);
});

test("Harness v8 Collector policy audit stays on sanitized Agent-plane data", async () => {
  const audit = await readFile(new URL("scripts/audit-releaseguard-v8-collector-policy.mjs", root), "utf8");
  assert.match(audit, /OFFLINE_AUDIT_OF_SANITIZED_AGENT_PLANE/);
  assert.match(audit, /releaseOnlySupportCases/);
  assert.match(audit, /explanationRelationMismatchCases/);
  assert.match(audit, /agent-input\.json/);
  assert.doesNotMatch(audit, /frozen-cases|gold_root_cause|scoreInvestigationCase|LIVE_EVAL_API_KEY/);
});

test("blind judge hides system identity from its model input and randomizes anonymous output order", async () => {
  const source = await readFile(new URL("eval/releaseguard-evaluation/blind-judge.ts", root), "utf8");
  assert.match(source, /deterministicShuffle/);
  assert.match(source, /anonymous_outputs/);
  assert.match(source, /System identities are hidden/);
  const judgeInputBlock = source.slice(source.indexOf("const judgeInput"), source.indexOf("const observations"));
  assert.doesNotMatch(judgeInputBlock, /system:/);
  assert.doesNotMatch(judgeInputBlock, /runIndex/);
});
