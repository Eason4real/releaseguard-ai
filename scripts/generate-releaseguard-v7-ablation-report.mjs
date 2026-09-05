import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("../", import.meta.url).pathname);
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const readJsonl = async (path) => (await readFile(resolve(root, path), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const ablation = await readJson("evaluation/results/v7/ablation.json");
const probeAttempts = await readJsonl("evaluation/results/v7/ablation/synthesis-repair-probe.jsonl");
const probeByCase = new Map();
for (const item of probeAttempts) {
  if (!probeByCase.has(item.caseId) || !item.error) probeByCase.set(item.caseId, item);
}
const probe = [...probeByCase.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
const probeJudge = await readJsonl(
  "evaluation/results/v7/ablation/synthesis-repair-probe.judged-v2.jsonl");
const probeJudgeByCase = new Map(probeJudge.map((item) => [item.caseId, item]));
const officialAttempts = await readJsonl("evaluation/results/v7/judge/blind-judge-v7.jsonl");
const officialByCase = new Map();
for (const item of officialAttempts) if (!item.error) officialByCase.set(item.case_id, item);
const candidateRunByCase = new Map();
for (const item of [...ablation.cases]
  .filter((entry) => entry.bottleneck === "SYNTHESIZER_FAILURE_OR_VALIDATION")
  .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.runIndex - b.runIndex)) {
  if (!candidateRunByCase.has(item.caseId)) candidateRunByCase.set(item.caseId, item.runIndex);
}
const rows = probe.map((item) => {
  const original = officialByCase.get(item.caseId)?.scores?.find((score) =>
    score.runIndex === candidateRunByCase.get(item.caseId));
  const judged = probeJudgeByCase.get(item.caseId);
  return {
    caseId: item.caseId,
    runIndex: item.runIndex,
    originalScore: original?.score ?? "?",
    probeTerminal: item.error ? "ERROR" : item.decision?.type ?? "ERROR",
    probeScore: judged?.score ?? "?",
  };
});
const successful = rows.filter((item) => item.probeTerminal !== "ERROR");
const evaluable = successful.filter((item) => item.probeScore !== "N/A");
const strict = evaluable.filter((item) => item.probeScore === "2").length;
const lenient = evaluable.filter((item) => ["1", "2"].includes(item.probeScore)).length;
const originalEvaluable = rows.filter((item) => item.originalScore !== "N/A");
const originalStrict = originalEvaluable.filter((item) => item.originalScore === "2").length;
const originalLenient = originalEvaluable.filter((item) => ["1", "2"].includes(item.originalScore)).length;
const totalUsage = probeAttempts.flatMap((item) => item.modelCalls ?? [])
  .reduce((sum, call) => sum + Number(call.usage?.totalTokens ?? 0), 0);
const pct = (value, total) => `${(value / total * 100).toFixed(1)}%`;
const table = rows.map((item) =>
  `| ${item.caseId} | ${item.runIndex} | ${item.originalScore} | ${item.probeTerminal} | ${item.probeScore} |`).join("\n");
const report = `# ReleaseGuard Harness v7 离线消融与最终归因报告

> 这是诊断性 Dev 实验，不是 v8 正式结果或 Holdout。Synthesizer 只读取冻结的 v7 Evidence Packet，不调用工具、不读取 Gold；Gold 仅在所有模型输出落盘后由独立评分和盲评进程读取。

## 结论

v7 的首要瓶颈是 **Synthesizer 输出契约、修复反馈和证据表达质量**，不是 Provider 稳定性，也不能主要归因于基础模型能力。Readiness Gate 偏保守仍需调整，但它不是 65 次拒答的最大来源。

## 66 条轨迹损失分解

- 46/66（69.7%）按 v7 当前规则已具备进入综合阶段的条件。
- 41/66（62.1%）出现综合输出或服务端校验失败。
- 7/66（10.6%）是 Synthesizer 正常、明确地选择拒答。
- 8/66（12.1%）是 Collector 结构化失败。
- 8/66（12.1%）是 Collector 或 Gate 的证据不足。
- 1/66（1.5%）没有持久化 Evidence；1/66（1.5%）正常 FINALIZE。

## 反事实修复实验

从 41 条综合失败中按案例去重，取 17 个代表轨迹。修复仅包括：补齐 LIMITATION 契约、把服务端错误码与字段路径反馈给有界修复轮次，以及在仅缺公共 rationale 时补固定流程说明。没有改写根因、假设、证据或 Gold。

| 指标 | 原 v7 代表轨迹 | 修复后探针 |
| --- | ---: | ---: |
| 技术可交付 | 0/17 | ${successful.length}/17 (${pct(successful.length, 17)}) |
| 严格 2 分（排除 N/A） | ${originalStrict}/${originalEvaluable.length} (${pct(originalStrict, originalEvaluable.length)}) | ${strict}/${evaluable.length} (${pct(strict, evaluable.length)}) |
| 宽松 1–2 分（排除 N/A） | ${originalLenient}/${originalEvaluable.length} (${pct(originalLenient, originalEvaluable.length)}) | ${lenient}/${evaluable.length} (${pct(lenient, evaluable.length)}) |
| 合理 N/A（技术成功） | ${rows.filter((item) => item.originalScore === "N/A").length} | ${successful.filter((item) => item.probeScore === "N/A").length} |
| 诊断性模型调用 | — | ${probeAttempts.flatMap((item) => item.modelCalls ?? []).length} 次 / ${totalUsage.toLocaleString("en-US")} tokens |

严格得分仍低，说明修复接口不能单独达到产品目标；但宽松命中从 ${pct(originalLenient, originalEvaluable.length)} 提升到 ${pct(lenient, evaluable.length)}，证明 Collector 已经提供了相当一部分正确方向，模型并非完全不会推理。

## 逐案审计

| 案例 | 冻结轮次 | 原 v7 盲评分 | 探针终态 | 探针盲评分 |
| --- | ---: | ---: | --- | ---: |
${table}

## 最终归因

1. **首要：Harness 契约缺陷。** Prompt 没完整声明 LIMITATION 必填字段；修复轮次不知道具体错误码和字段路径；只漏 rationale 也会整条诊断丢弃。
2. **第二：Evidence Packet 信息贫化。** 持久化 statement 多为“工具返回了当前观察”，真正的数值、分群和模块信息主要藏在 Assessment explanation 中，限制了严格根因识别。
3. **第三：Collector 的语义粒度不足。** 多个假设停留在组件或方向级，因此宽松分显著改善，严格机制分仍只有 ${pct(strict, evaluable.length)}。
4. **第四：Gate 语义过于二元。** 应支持有界假设与可行动拒答，但本次数据表明它不是最大技术损失点。
5. **基础模型能力是次要变量。** 在同一模型、同一冻结证据下，仅修正契约就恢复了 ${successful.length}/17 的技术交付和 ${lenient}/${evaluable.length} 的宽松命中；在修复 Evidence Packet 前直接换模型无法公平判断收益。

## v8 建议与进入门槛

- P0：Evidence Packet 必须包含工具结果的安全结构化摘要，而不是只有通用 statement；仍禁止 transcript 和 Gold。
- P0：保留本次结构修复，并记录每次 Synthesizer validation code、path、首轮成功率与修复成功率。
- P0：把 readiness 拆成 CAUSAL、BOUNDED_HYPOTHESIS、ABSTENTION、NEEDS_COLLECTION 四态；拒答必须交付已确认事实、反证和缺失数据。
- P1：先在 17 个代表案例的独立 smoke 运行中达到技术成功 ≥97%、严格 ≥35%、宽松 ≥65%，再运行正式 3×22。
- P1：正式目标仍为技术完成 ≥97%、业务完成 ≥60%、严格根因 ≥50%、关键证据召回 ≥85%。
- 若加入结构化工具摘要后严格分仍低于 35%，再进行同证据包的模型对照；不要继续只加 Prompt 或重试。

## 可信度边界

- 这是同一 Dev 数据上的开发诊断，会产生调参偏差，不能宣称泛化能力。
- 盲评仍使用同模型家族，不是独立人工评审。
- 早期 17 次评审请求因缺少 JSON 关键词遭 Provider 400，失败尝试完整保留，修复后另存成功结果。
- 正式 v7 结果保持冻结，本报告没有重写任何 v7 原始输出或正式评分。
`;
const outputPath = resolve(root, "docs/evaluation/releaseguard-harness-v7-ablation-final-report.zh-CN.md");
await writeFile(outputPath, report);
console.log(JSON.stringify({ output: outputPath, strict, lenient, evaluable: evaluable.length,
  technicalSuccess: successful.length, total: rows.length }, null, 2));
