import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("../", import.meta.url).pathname);
const resultsRoot = resolve(root, "evaluation/results/v7");
const outputPath = resolve(resultsRoot, "ablation.json");
const reportPath = resolve(root, "docs/evaluation/releaseguard-harness-v7-offline-ablation.zh-CN.md");

const currentCategories = new Set(["RELEASE_CHANGE", "PRODUCT_METRIC", "SEGMENT_METRIC", "USER_FEEDBACK"]);

function classifyCase(item, runIndex) {
  const telemetry = item.telemetry ?? {};
  const execution = item.execution ?? {};
  const persistence = Array.isArray(telemetry.evidencePersistenceEvents)
    ? telemetry.evidencePersistenceEvents : [];
  const categories = [...new Set(persistence.map((entry) => entry.category).filter(Boolean))].sort();
  const current = persistence.filter((entry) => currentCategories.has(entry.category));
  const independentSources = new Set(current.map((entry) => `${entry.category}:${entry.toolCallId ?? entry.evidenceId}`)).size;
  const hypotheses = Array.isArray(telemetry.competingHypothesisState)
    ? telemetry.competingHypothesisState : [];
  const supported = hypotheses.filter((entry) =>
    ["SUPPORTED", "CONFIRMED"].includes(entry.status)
    && ["MEDIUM", "HIGH"].includes(entry.confidence));
  const stopReason = String(telemetry.plannerStopDecision?.reason ?? "");
  const terminal = String(execution.terminalInvestigationState ?? telemetry.terminalState ?? "");
  const hasDiagnosisAttempt = Array.isArray(telemetry.diagnosisAttempts) && telemetry.diagnosisAttempts.length > 0;
  const collectionSchemaFailure = stopReason.includes("证据收集阶段");
  const synthesisSchemaFailure = stopReason.includes("综合阶段");
  const missingCategories = [];
  if (!categories.includes("RELEASE_CHANGE")) missingCategories.push("RELEASE_CONTEXT");
  if (!categories.includes("PRODUCT_METRIC") && !categories.includes("SEGMENT_METRIC")) missingCategories.push("CURRENT_IMPACT");
  const gateWouldBeReady = missingCategories.length === 0 && independentSources >= 2 && supported.length > 0;
  let bottleneck;
  if (collectionSchemaFailure) bottleneck = "COLLECTOR_SCHEMA_FAILURE";
  else if (terminal === "FINALIZED") bottleneck = "NO_TERMINAL_BLOCKER";
  else if (synthesisSchemaFailure || hasDiagnosisAttempt) bottleneck = "SYNTHESIZER_FAILURE_OR_VALIDATION";
  else if (gateWouldBeReady) bottleneck = "SYNTHESIZER_EXPLICIT_ABSTENTION";
  else if (persistence.length === 0) bottleneck = "COLLECTOR_NO_EVIDENCE";
  else bottleneck = "COLLECTOR_OR_GATE_EVIDENCE_INSUFFICIENT";
  return {
    runIndex,
    caseId: String(item.caseId),
    terminal,
    modelCalls: Number(item.normalizedPrediction?.modelCallCount ?? execution.modelCallCount ?? 0),
    toolCalls: Number(item.normalizedPrediction?.toolCallCount ?? execution.toolCallCount ?? 0),
    evidenceCount: persistence.length,
    categories,
    independentCurrentSources: independentSources,
    supportedHypotheses: supported.length,
    missingCategories,
    gateWouldBeReady,
    collectionSchemaFailure,
    synthesisSchemaFailure,
    hasDiagnosisAttempt,
    bottleneck,
  };
}

const cases = [];
for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
  const path = resolve(resultsRoot, `raw/harness-v7-run-${runIndex}.json`);
  const report = JSON.parse(await readFile(path, "utf8"));
  if (report.reportStatus !== "COMPLETE" || report.cases?.length !== 22) {
    throw new Error(`V7_ABLATION_INPUT_INVALID:RUN_${runIndex}`);
  }
  for (const item of report.cases) cases.push(classifyCase(item, runIndex));
}
if (cases.length !== 66) throw new Error("V7_ABLATION_CASE_COUNT_INVALID");

const counts = Object.fromEntries([...new Set(cases.map((item) => item.bottleneck))]
  .sort().map((key) => [key, cases.filter((item) => item.bottleneck === key).length]));
const aggregate = {
  cases: cases.length,
  terminalFinalized: cases.filter((item) => item.terminal === "FINALIZED").length,
  terminalInconclusive: cases.filter((item) => item.terminal === "INCONCLUSIVE").length,
  gateWouldBeReady: cases.filter((item) => item.gateWouldBeReady).length,
  collectorSchemaFailures: cases.filter((item) => item.collectionSchemaFailure).length,
  synthesizerFailures: cases.filter((item) => item.synthesisSchemaFailure || item.hasDiagnosisAttempt).length,
  noEvidence: cases.filter((item) => item.evidenceCount === 0).length,
};
const result = {
  schemaVersion: "releaseguard-v7-offline-ablation-v1",
  mode: "FROZEN_V7_TRAJECTORIES_ONLY",
  goldAccess: "NONE",
  modelCalls: 0,
  toolCalls: 0,
  aggregate,
  bottleneckCounts: counts,
  cases,
};
await mkdir(resolve(resultsRoot), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }).catch(async (error) => {
  if (error.code !== "EEXIST") throw error;
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
});
const pct = (value) => `${(value / aggregate.cases * 100).toFixed(1)}%`;
const lines = [
  "# ReleaseGuard Harness v7 离线分阶段消融报告",
  "",
  "> 本报告只读取已冻结的 v7 运行轨迹；不读取 Gold，不调用模型或工具，不改变正式评测结果。分类用于定位损失，不是新的业务准确率。",
  "",
  "## 汇总",
  "",
  `- 覆盖：${aggregate.cases} 条轨迹（3 轮 × 22 案例）`,
  `- 技术终态：${aggregate.terminalFinalized} FINALIZED，${aggregate.terminalInconclusive} INCONCLUSIVE`,
  `- 按当前 Gate 条件重建后具备综合条件：${aggregate.gateWouldBeReady}（${pct(aggregate.gateWouldBeReady)}）`,
  `- 证据收集结构化失败：${aggregate.collectorSchemaFailures}（${pct(aggregate.collectorSchemaFailures)}）`,
  `- 综合/诊断阶段失败迹象：${aggregate.synthesizerFailures}（${pct(aggregate.synthesizerFailures)}）`,
  `- 完全没有持久化 Evidence：${aggregate.noEvidence}（${pct(aggregate.noEvidence)}）`,
  "",
  "## 瓶颈分类",
  "",
  ...Object.entries(counts).map(([key, value]) => `- ${key}：${value}（${pct(value)}）`),
  "",
  "## 解释与边界",
  "",
  "- `SYNTHESIZER_EXPLICIT_ABSTENTION` 表示 Gate 已具备综合条件，Synthesizer 正常返回了拒答；它不同于结构化失败，需要判断拒答是否合理。",
  "- `COLLECTOR_OR_GATE_EVIDENCE_INSUFFICIENT` 表示当前轨迹无法区分是工具没有找到信息，还是 Gate 判断证据不足；不能把它归咎于模型能力。",
  "- `SYNTHESIZER_FAILURE_OR_VALIDATION` 表示综合阶段出现失败迹象；后续应检查输入包和结构化输出，而不是增加无界重试。",
  "- 本报告没有使用 Gold，因此不报告根因准确率，也不把重建的 Gate 条件当作真实标签。",
  "",
  "## 下一步决策门",
  "",
  "1. 对 `SYNTHESIZER_FAILURE_OR_VALIDATION` 的代表轨迹运行一次无工具 Synthesizer 修复实验，保留相同 Evidence Packet。",
  "2. 若改进后的契约反馈能稳定产生有界、可引用诊断，优先修复 Synthesizer 与服务端校验的接口；若仍失败，再做模型对照。",
  "3. 对其余轨迹按 Collector 证据缺口拆分，只有工具可观测性不足时才扩充工具。",
  "4. 消融通过后先跑小规模 smoke set，再决定是否创建独立 v8。",
  "",
  `原始机器可读结果：\`evaluation/results/v7/ablation.json\`。`,
].join("\n");
await mkdir(resolve(root, "docs/evaluation"), { recursive: true });
await writeFile(reportPath, `${lines}\n`);
console.log(JSON.stringify({ output: outputPath, report: reportPath, aggregate, bottleneckCounts: counts }, null, 2));
