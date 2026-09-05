import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pathOf = (relative) => new URL(relative, root).pathname;
const readJson = async (relative) => JSON.parse(await readFile(pathOf(relative), "utf8"));
const readJsonl = async (relative) => (await readFile(pathOf(relative), "utf8"))
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);
const mean = (values) => values.length ? sum(values) / values.length : null;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction;
};
const wilson = (successes, total) => {
  if (!total) return { successes, total, proportion: null, lower: null, upper: null };
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return {
    successes, total, proportion: round(p),
    lower: round(Math.max(0, center - margin)), upper: round(Math.min(1, center + margin)),
  };
};
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const rateText = (rate) => `${rate.successes}/${rate.total} (${pct(rate.proportion)})`;
const delta = (after, before) => after === null || before === null ? null : round(after - before);
const deltaText = (value) => value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} 个百分点`;

const base = await readJson("evaluation/results/v2/summary.json");
const v2 = base.systems.find((system) => system.system === "HARNESS_V2");
if (!v2) throw new Error("V2_BASELINE_MISSING");
const frozen = await readJson("evaluation/dataset/frozen-cases.json");
const frozenById = new Map(frozen.cases.map((item) => [item.case_id, item]));
const judgeRecords = await readJsonl("evaluation/results/v3/judge/blind-judge-v3.jsonl");
if (judgeRecords.length !== 22 || judgeRecords.some((record) => record.error)) {
  throw new Error("V3_JUDGE_NOT_COMPLETE");
}
const judgeByKey = new Map();
for (const record of judgeRecords) {
  for (const score of record.scores ?? []) judgeByKey.set(`${score.runIndex}|${record.case_id}`, score);
}

const reports = await Promise.all([1, 2, 3].map((index) =>
  readJson(`evaluation/results/v3/raw/harness-v3-run-${index}.json`)));
const identities = reports.map((report) => ({
  datasetHash: report.manifest.datasetHash,
  sourceCommit: report.manifest.sourceCommit,
  modelConfiguration: report.manifest.modelConfiguration,
}));
if (reports.some((report) => report.reportStatus !== "COMPLETE" || report.cases.length !== 22)
  || new Set(identities.map(JSON.stringify)).size !== 1) {
  throw new Error("V3_RUN_IDENTITY_OR_COVERAGE_INVALID");
}

const items = [];
for (const [offset, report] of reports.entries()) {
  const runIndex = offset + 1;
  for (const item of report.cases) {
    const gold = frozenById.get(item.caseId);
    if (!gold) throw new Error(`GOLD_CASE_MISSING:${item.caseId}`);
    const cited = item.normalizedPrediction?.citedEvidenceIds ?? [];
    const observed = new Set([
      ...cited,
      ...(item.telemetry?.evidencePersistenceEvents ?? []).map((event) => event.evidenceId),
    ]);
    const critical = gold.critical_evidence_ids ?? [];
    const technical = item.execution.status === "PASS";
    const judge = judgeByKey.get(`${runIndex}|${item.caseId}`);
    items.push({
      runIndex, caseId: item.caseId, category: gold.incident_type, difficulty: gold.difficulty,
      technical, terminal: technical ? item.execution.terminalInvestigationState : "FAILED",
      diagnosis: item.normalizedPrediction?.predictedRootCause ?? null, cited, observed, critical, judge,
      business: technical && Boolean(item.normalizedPrediction?.predictedRootCause)
        && critical.every((id) => observed.has(id)),
      criticalEvidenceRecall: critical.length
        ? critical.filter((id) => observed.has(id)).length / critical.length : null,
      durationMs: item.normalizedPrediction?.durationMs ?? item.scoring?.cost?.durationMs ?? null,
      modelCalls: item.telemetry?.modelCallCount ?? item.execution.modelCallCount,
      toolCalls: item.telemetry?.toolCallCount ?? item.execution.toolCallCount,
      tokens: item.normalizedPrediction?.tokenUsage ?? item.scoring?.cost?.tokenUsage ?? {},
      retries: item.telemetry?.schemaRepairCount ?? 0,
      error: item.execution.error ?? item.execution.errorCategory ?? null,
      scoring: item.scoring, telemetry: item.telemetry,
      rawRef: `raw/harness-v3-run-${runIndex}.json`,
    });
  }
}
if (items.length !== 66 || items.some((item) => !item.judge)) throw new Error("V3_TRIAL_COVERAGE_INVALID");

const scoreNumber = (score) => ["0", "1", "2"].includes(score) ? Number(score) : null;
const numericScores = items.map((item) => scoreNumber(item.judge.score)).filter(Number.isFinite);
const calls = items.flatMap((item) => item.telemetry?.toolTrajectory ?? item.telemetry?.toolCalls ?? []);
const citations = items.flatMap((item) => item.cited);
const validEvidenceIds = new Set(frozen.cases.flatMap((item) =>
  (item.agent_accessible_observations ?? []).map((observation) => observation.evidenceId)));
const errors = {};
const terminals = {};
for (const item of items) {
  if (item.error) errors[item.error] = (errors[item.error] ?? 0) + 1;
  terminals[item.terminal] = (terminals[item.terminal] ?? 0) + 1;
}
const groups = frozen.cases.map((gold) => items.filter((item) => item.caseId === gold.case_id));
const pricing = base.model.pricing;
const cost = (band) => {
  const inputTokens = sum(items.map((item) => item.tokens.inputTokens ?? item.tokens.promptTokens));
  const outputTokens = sum(items.map((item) => item.tokens.outputTokens ?? item.tokens.completionTokens));
  return {
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    estimatedUsd: round((inputTokens * pricing[band].input_cache_miss
      + outputTokens * pricing[band].output) / pricing.unit_tokens, 6),
    assumption: "All input tokens priced as cache misses; actual billing may differ.",
  };
};
const v3 = {
  system: "HARNESS_V3", trials: 66, cases: 22,
  technicalCompletion: wilson(items.filter((item) => item.technical).length, 66),
  businessCompletion: wilson(items.filter((item) => item.business).length, 66),
  rootCause: {
    score2Strict: wilson(items.filter((item) => item.judge.score === "2").length, numericScores.length),
    score1Or2Lenient: wilson(items.filter((item) => ["1", "2"].includes(item.judge.score)).length, numericScores.length),
    meanScore: round(mean(numericScores)), numericDenominator: numericScores.length,
    notApplicable: items.filter((item) => item.judge.score === "N/A").length, judgeErrors: 0,
    judgeDisclosure: "Non-independent same-model blind LLM review; v3 identity hidden and run order deterministically randomized.",
  },
  evidence: {
    citationValidity: wilson(citations.filter((id) => validEvidenceIds.has(id)).length, citations.length),
    meanCitationSupport: round(mean(items.map((item) => item.scoring?.evidence?.precision).filter(Number.isFinite))),
    meanUnsupportedClaimRate: round(mean(items.map((item) => item.scoring?.grounding?.unsupportedClaimRate).filter(Number.isFinite))),
    groundingEvaluableTrials: items.filter((item) => Number.isFinite(item.scoring?.grounding?.unsupportedClaimRate)).length,
    meanCriticalEvidenceRecall: round(mean(items.map((item) => item.criticalEvidenceRecall).filter(Number.isFinite))),
    supportAndContradictionHandled: wilson(items.filter((item) => {
      const relations = new Set((item.telemetry?.evidenceAssessments ?? []).map((event) => event.relation));
      return relations.has("SUPPORTS") && relations.has("CONTRADICTS");
    }).length, 66),
  },
  tools: {
    calls: calls.length,
    success: wilson(calls.filter((call) => call.status === "COMPLETED" && call.resultStatus !== "ERROR").length, calls.length),
    empty: wilson(calls.filter((call) => call.resultStatus === "EMPTY").length, calls.length),
    meanCallsPerTrial: round(calls.length / 66),
    disclosure: "EMPTY is a valid no-information result, not a transport failure.",
  },
  stability: {
    passAt1Technical: wilson(groups.filter((group) => group[0]?.technical).length, 22),
    allThreeTechnical: wilson(groups.filter((group) => group.length === 3 && group.every((item) => item.technical)).length, 22),
    terminalStateConsistency: wilson(groups.filter((group) => group.length === 3
      && new Set(group.map((item) => item.terminal)).size === 1).length, 22),
    rootScoreConsistency: wilson(groups.filter((group) => group.length === 3
      && new Set(group.map((item) => item.judge.score)).size === 1).length, 22),
    interventionFreeTrials: wilson(66, 66),
  },
  performance: {
    durationMsP50: round(percentile(items.map((item) => item.durationMs).filter(Number.isFinite), 0.5), 1),
    durationMsP95: round(percentile(items.map((item) => item.durationMs).filter(Number.isFinite), 0.95), 1),
    durationMsTotal: round(sum(items.map((item) => item.durationMs).filter(Number.isFinite)), 1),
    durationAvailableTrials: items.filter((item) => Number.isFinite(item.durationMs)).length,
    modelCallsTotal: sum(items.map((item) => item.modelCalls)), modelCallsMean: round(mean(items.map((item) => item.modelCalls))),
    toolCallsTotal: sum(items.map((item) => item.toolCalls)), toolCallsMean: round(mean(items.map((item) => item.toolCalls))),
    schemaRepairsOrRetriesTotal: sum(items.map((item) => item.retries)),
    timeoutRate: wilson(items.filter((item) => /TIMEOUT/i.test(item.error ?? "")).length, 66),
    peakCost: cost("peak"), offPeakCost: cost("off_peak"),
  },
  terminalStates: terminals, errors,
};

const comparison = {
  technicalCompletion: delta(v3.technicalCompletion.proportion, v2.technicalCompletion.proportion),
  businessCompletion: delta(v3.businessCompletion.proportion, v2.businessCompletion.proportion),
  strictRootCause: delta(v3.rootCause.score2Strict.proportion, v2.rootCause.score2Strict.proportion),
  lenientRootCause: delta(v3.rootCause.score1Or2Lenient.proportion, v2.rootCause.score1Or2Lenient.proportion),
  criticalEvidenceRecall: delta(v3.evidence.meanCriticalEvidenceRecall, v2.evidence.meanCriticalEvidenceRecall),
  emptyToolRate: delta(v3.tools.empty.proportion, v2.tools.empty.proportion),
  terminalConsistency: delta(v3.stability.terminalStateConsistency.proportion, v2.stability.terminalStateConsistency.proportion),
  p95DurationMs: round(v3.performance.durationMsP95 - v2.performance.durationMsP95, 1),
};
const reviewRows = items.filter((item) => item.judge.confidence === "LOW" || ["1", "N/A"].includes(item.judge.score));
const reviewHeader = ["case_id", "system", "run_index", "judge_score", "judge_confidence", "judge_reason", "diagnosis", "raw_result"];
const reviewCsv = [reviewHeader.map(csv).join(","), ...reviewRows.map((item) => [
  item.caseId, "HARNESS_V3", item.runIndex, item.judge.score, item.judge.confidence,
  item.judge.reason, item.diagnosis, item.rawRef,
].map(csv).join(","))].join("\n") + "\n";
const slices = structuredClone(base.slices);
for (const dimension of ["category", "difficulty"]) {
  for (const value of [...new Set(items.map((item) => item[dimension]))]) {
    const selected = items.filter((item) => item[dimension] === value);
    const numeric = selected.map((item) => scoreNumber(item.judge.score)).filter(Number.isFinite);
    slices[dimension][value].HARNESS_V3 = {
      trials: selected.length,
      technical: wilson(selected.filter((item) => item.technical).length, selected.length),
      score2: wilson(selected.filter((item) => item.judge.score === "2").length, numeric.length),
      meanScore: round(mean(numeric)),
    };
  }
}
const typical = items.find((item) => item.judge.score === "2" && item.telemetry && item.diagnosis);

const summary = {
  ...base,
  schemaVersion: "releaseguard-v2-v3-comparison-summary-v1",
  generatedAt: new Date().toISOString(), evaluationVersion: "0.2.0-harness-v3",
  systems: [...base.systems.filter((system) => system.system !== "HARNESS_V3"), v3],
  slices,
  judge: {
    type: "NON_INDEPENDENT_SAME_MODEL", cases: 22, failedCases: 0, status: "COMPLETE",
    scoredOutputs: numericScores.length, notApplicableOutputs: v3.rootCause.notApplicable,
    reviewQueueRows: reviewRows.length, rawResults: "judge/blind-judge-v3.jsonl",
  },
  latestEvaluationCompletedAt: reports.map((report) => report.manifest.completedAt).sort().at(-1),
  typicalTrace: typical ? {
    system: "HARNESS_V3", caseId: typical.caseId, runIndex: typical.runIndex,
    diagnosis: typical.diagnosis, rootCauseScore: typical.judge.score,
    actions: (typical.telemetry.iterations ?? []).map((event) => ({
      sequence: event.sequence, decisionType: event.decisionType, rationale: event.publicRationale,
    })),
    tools: (typical.telemetry.toolTrajectory ?? []).map((call) => ({
      toolName: call.toolName, resultStatus: call.resultStatus, evidenceIds: call.evidenceIds,
    })),
  } : null,
  harnessV3: {
    status: "EXPERIMENTAL_DEV_NOT_HOLDOUT", comparisonAgainst: "HARNESS_V2",
    manifestIdentity: identities[0], sourceContentSha256: identities[0].modelConfiguration.sourceIdentity,
    deltas: comparison,
    changes: [
      "Actionable capability contracts with availability, required arguments, query shapes, and argument sources.",
      "Canonical tool arguments and explicit EMPTY reason classes.",
      "Cumulative and consecutive no-information budgets exposed to the planner.",
      "Evidence-readiness, convergence, and unsupported-query prompt rules.",
    ],
    sideEffects: [
      "Richer capability metadata increases prompt size and depends on production schema/catalog parity.",
      "More conservative evidence gates can increase INCONCLUSIVE outcomes when fixtures lack discriminating observations.",
      "AgentLoop, approval, grounding, and external-write boundaries were not relaxed.",
    ],
  },
  limitations: [
    ...base.limitations,
    "Harness v3 is a Dev experiment on the same governed cases, not a Holdout or production accuracy claim.",
    "The v3 blind judge uses the same model family and is not independent human review.",
  ],
  artifacts: {
    ...base.artifacts,
    report: "docs/evaluation/releaseguard-harness-v3-ai-pm-report.zh-CN.md",
    technicalAppendix: "docs/evaluation/releaseguard-harness-v3-technical-appendix.zh-CN.md",
    reviewQueue: "evaluation/results/v3/review_queue.csv", rawDirectory: "evaluation/results/v3/raw/",
  },
};

const metricRows = [
  ["技术完成率", v2.technicalCompletion, v3.technicalCompletion, comparison.technicalCompletion],
  ["业务完成率", v2.businessCompletion, v3.businessCompletion, comparison.businessCompletion],
  ["严格根因得分", v2.rootCause.score2Strict, v3.rootCause.score2Strict, comparison.strictRootCause],
  ["宽松根因得分", v2.rootCause.score1Or2Lenient, v3.rootCause.score1Or2Lenient, comparison.lenientRootCause],
];
const verdict = comparison.businessCompletion >= 0 && comparison.strictRootCause >= 0
  ? "v3 的调查决策质量较 v2 改善，但仍需依据绝对指标判断能否扩大试用。"
  : "v3 没有同时改善业务完成率与严格根因质量，不能因为流程升级就认定产品效果提升。";
const productReport = [
  "# ReleaseGuard AI Harness v3 产品评测报告", "",
  "> 面向 AI 产品经理和产品负责人。结果来自同一套可见 Dev 案例，不是 Holdout、生产准确率或人工评审。", "",
  "## 一句话结论", "", verdict, "",
  "## 核心业务结果", "",
  "| 指标 | Harness v2 | Harness v3 | 变化 |", "| --- | ---: | ---: | ---: |",
  ...metricRows.map(([name, before, after, change]) => `| ${name} | ${rateText(before)} | ${rateText(after)} | ${deltaText(change)} |`),
  `| 关键证据召回 | ${pct(v2.evidence.meanCriticalEvidenceRecall)} | ${pct(v3.evidence.meanCriticalEvidenceRecall)} | ${deltaText(comparison.criticalEvidenceRecall)} |`,
  `| EMPTY 工具调用 | ${rateText(v2.tools.empty)} | ${rateText(v3.tools.empty)} | ${deltaText(comparison.emptyToolRate)} |`,
  `| 三轮终态一致性 | ${rateText(v2.stability.terminalStateConsistency)} | ${rateText(v3.stability.terminalStateConsistency)} | ${deltaText(comparison.terminalConsistency)} |`, "",
  "## 用户实际会感受到什么", "",
  `- 66 次调查中，${v3.technicalCompletion.successes} 次技术上正常完成，${v3.businessCompletion.successes} 次同时形成诊断并覆盖关键证据。`,
  `- 最终状态分布：${Object.entries(v3.terminalStates).map(([state, count]) => `${state} ${count} 次`).join("、")}。`,
  `- 工具调用共 ${v3.tools.calls} 次，其中 ${v3.tools.empty.successes} 次没有信息增益。`,
  `- 单次调查中位耗时 ${(v3.performance.durationMsP50 / 1000).toFixed(1)} 秒，P95 ${(v3.performance.durationMsP95 / 1000).toFixed(1)} 秒。`, "",
  "## v3 解决了什么", "",
  "v3 让 Agent 在调用工具前看到更具体的能力契约，包括当前案例能否调用、必填参数、可匹配查询形状和参数来源；同时把空结果分成不同原因，并设置连续与累计无信息预算。它的目标不是让 Agent 多查，而是减少无效查询并更早判断证据是否足够。", "",
  "## 产品判断", "",
  `- 严格根因得分为 ${pct(v3.rootCause.score2Strict.proportion)}，宽松得分为 ${pct(v3.rootCause.score1Or2Lenient.proportion)}。这些才反映答案质量，不能用 ${pct(v3.technicalCompletion.proportion)} 的技术完成率替代。`,
  `- 关键证据召回为 ${pct(v3.evidence.meanCriticalEvidenceRecall)}，EMPTY 比例为 ${pct(v3.tools.empty.proportion)}。`,
  `- 三轮终态一致性为 ${pct(v3.stability.terminalStateConsistency.proportion)}，根因评分一致性为 ${pct(v3.stability.rootScoreConsistency.proportion)}。`,
  "- 当前结果只支持内部 Alpha/设计合作伙伴范围的人工确认式调查，不支持自动归因、自动回滚或 80-90% 准确率宣传。", "",
  "## 下一步决策", "",
  "1. 对 review queue 中的边界案例做独立模型或人工复核，重点区分合理 abstain 与过度 INCONCLUSIVE。",
  "2. 新建不可见 Holdout，再验证查询策略是否泛化；Dev 提升不能直接当成生产提升。",
  "3. 保留 Direct LLM 对照，评估 Agent 编排带来的可审计价值是否抵消质量、耗时和成本差距。",
  "4. 继续保持人工审批、证据 grounding 和外部写入边界，不用放宽安全约束换分。", "",
  "## 评测边界", "",
  "- 22 个受治理离线案例，每案 3 轮，共 66 次；所有失败保留在分母。",
  "- Gold 只用于评分与盲评，未提供给 Agent；没有按案例 ID 硬编码或删除失败案例。",
  "- 盲评隐藏版本身份并打乱三轮顺序，但使用同一模型家族，不等同独立人类评审。",
  `- 数据集哈希：\`${identities[0].datasetHash}\`；源码提交：\`${identities[0].sourceCommit}\`；源码内容身份：\`${identities[0].modelConfiguration.sourceIdentity}\`。`, "",
].join("\n");

const technicalAppendix = [
  "# ReleaseGuard AI Harness v3 技术附录", "",
  "> v3 正式 Dev 三轮评测与同模型盲评的可审计统计。", "",
  "## 完整性", "",
  `- 原始运行：3 × 22 = ${items.length}；盲评请求：${judgeRecords.length}；数值评分：${numericScores.length}；N/A：${v3.rootCause.notApplicable}；盲评错误：0。`,
  `- 技术完成：${rateText(v3.technicalCompletion)}；业务完成：${rateText(v3.businessCompletion)}。`,
  `- 终态：${JSON.stringify(v3.terminalStates)}；执行错误：${JSON.stringify(v3.errors)}。`, "",
  "## 工具与证据", "",
  `- 工具非错误完成：${rateText(v3.tools.success)}；EMPTY：${rateText(v3.tools.empty)}；总调用：${v3.tools.calls}。`,
  `- 引用有效率：${rateText(v3.evidence.citationValidity)}；关键证据召回：${pct(v3.evidence.meanCriticalEvidenceRecall)}。`,
  `- 同时处理支持与反证：${rateText(v3.evidence.supportAndContradictionHandled)}。`, "",
  "## 稳定性、延迟与成本", "",
  `- Pass@1：${rateText(v3.stability.passAt1Technical)}；三轮全通过：${rateText(v3.stability.allThreeTechnical)}。`,
  `- 终态一致性：${rateText(v3.stability.terminalStateConsistency)}；根因评分一致性：${rateText(v3.stability.rootScoreConsistency)}。`,
  `- P50/P95：${(v3.performance.durationMsP50 / 1000).toFixed(1)}s / ${(v3.performance.durationMsP95 / 1000).toFixed(1)}s；总耗时 ${(v3.performance.durationMsTotal / 3600000).toFixed(2)}h。`,
  `- 模型调用 ${v3.performance.modelCallsTotal}；工具调用 ${v3.performance.toolCallsTotal}；schema repair ${v3.performance.schemaRepairsOrRetriesTotal}。`,
  `- Tokens：input ${v3.performance.peakCost.inputTokens.toLocaleString()} / output ${v3.performance.peakCost.outputTokens.toLocaleString()}；峰时估算 $${v3.performance.peakCost.estimatedUsd.toFixed(4)}，非账单。`, "",
  "## 限制与副作用", "",
  ...summary.harnessV3.sideEffects.map((item) => `- ${item}`),
  "- 同数据集持续开发存在调参过拟合风险，必须用 Holdout 验证。", "",
].join("\n");

await mkdir(pathOf("evaluation/results/v3/"), { recursive: true });
await mkdir(pathOf("public/evaluation/"), { recursive: true });
await writeFile(pathOf("evaluation/results/v3/summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(pathOf("public/evaluation/summary-v3.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(pathOf("evaluation/results/v3/review_queue.csv"), reviewCsv);
await writeFile(pathOf("docs/evaluation/releaseguard-harness-v3-ai-pm-report.zh-CN.md"), productReport);
await writeFile(pathOf("docs/evaluation/releaseguard-harness-v3-technical-appendix.zh-CN.md"), technicalAppendix);
console.log(JSON.stringify({ summary: "evaluation/results/v3/summary.json", reviewQueueRows: reviewRows.length, v3, comparison }, null, 2));
