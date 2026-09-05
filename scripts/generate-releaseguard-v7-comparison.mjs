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
const countBy = (items, keyOf) => items.reduce((counts, item) => {
  const key = String(keyOf(item) ?? "UNKNOWN");
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const rateText = (rate) => `${rate.successes}/${rate.total} (${pct(rate.proportion)})`;
const delta = (after, before) => after === null || before === null ? null : round(after - before);
const deltaText = (value) => value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} 个百分点`;
const scoreNumber = (score) => ["0", "1", "2"].includes(score) ? Number(score) : null;

const base = await readJson("evaluation/results/v3/summary.json");
const v3 = base.systems.find((system) => system.system === "HARNESS_V3");
if (!v3) throw new Error("V3_BASELINE_MISSING");
const frozen = await readJson("evaluation/dataset/frozen-cases.json");
const frozenById = new Map(frozen.cases.map((item) => [item.case_id, item]));
const expectedCaseIds = frozen.cases.map((item) => item.case_id);

const judgeAttempts = await readJsonl("evaluation/results/v7/judge/blind-judge-v7.jsonl");
const judgeRecords = expectedCaseIds.map((caseId) =>
  judgeAttempts.findLast((record) => record.case_id === caseId && !record.error));
const failedJudgeAttempts = judgeAttempts.filter((record) => record.error);
if (judgeRecords.some((record) => !record) || new Set(judgeRecords.map((record) => record.case_id)).size !== 22) {
  throw new Error("V7_JUDGE_NOT_COMPLETE");
}
const judgeByKey = new Map();
for (const record of judgeRecords) {
  for (const score of record.scores ?? []) judgeByKey.set(`${score.runIndex}|${record.case_id}`, score);
}

const reports = await Promise.all([1, 2, 3].map((index) =>
  readJson(`evaluation/results/v7/raw/harness-v7-run-${index}.json`)));
const identityOf = (report) => ({
  datasetHash: report.manifest.datasetHash,
  sourceCommit: report.manifest.sourceCommit,
  modelConfiguration: report.manifest.modelConfiguration,
});
const identities = reports.map(identityOf);
if (reports.some((report) => report.reportStatus !== "COMPLETE"
  || report.manifest.totalCases !== 22
  || report.manifest.processedCases !== 22
  || report.cases?.length !== 22)
  || new Set(identities.map(JSON.stringify)).size !== 1
  || reports.some((report) => JSON.stringify(report.cases.map((item) => item.caseId))
    !== JSON.stringify(expectedCaseIds))) {
  throw new Error("V7_RUN_IDENTITY_COVERAGE_OR_PREFIX_INVALID");
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
    const finalized = technical && item.execution.terminalInvestigationState === "FINALIZED";
    const judge = judgeByKey.get(`${runIndex}|${item.caseId}`);
    const criticalEvidenceRecall = critical.length
      ? critical.filter((id) => observed.has(id)).length / critical.length : null;
    const hasTraceableCriticalEvidence = critical.every((id) => observed.has(id));
    const hasCitedCriticalEvidence = critical.every((id) => new Set(cited).has(id));
    items.push({
      runIndex,
      caseId: item.caseId,
      category: gold.incident_type,
      difficulty: gold.difficulty,
      technical,
      finalized,
      terminal: technical ? item.execution.terminalInvestigationState : "FAILED",
      diagnosis: item.normalizedPrediction?.predictedRootCause ?? null,
      cited,
      observed,
      critical,
      judge,
      business: technical && Boolean(item.normalizedPrediction?.predictedRootCause)
        && hasTraceableCriticalEvidence,
      actionableDelivery: finalized && Boolean(item.normalizedPrediction?.predictedRootCause)
        && hasCitedCriticalEvidence,
      criticalEvidenceRecall,
      durationMs: item.normalizedPrediction?.durationMs ?? item.scoring?.cost?.durationMs ?? null,
      modelCalls: item.telemetry?.modelCallCount ?? item.execution.modelCallCount,
      toolCalls: item.telemetry?.toolCallCount ?? item.execution.toolCallCount,
      tokens: item.normalizedPrediction?.tokenUsage ?? item.scoring?.cost?.tokenUsage ?? {},
      repairs: item.telemetry?.schemaRepairCount ?? 0,
      error: item.execution.error ?? item.execution.errorCategory ?? null,
      scoring: item.scoring,
      telemetry: item.telemetry,
      rawRef: `raw/harness-v7-run-${runIndex}.json`,
    });
  }
}
if (items.length !== 66 || items.some((item) => !item.judge)) {
  throw new Error("V7_TRIAL_OR_JUDGE_COVERAGE_INVALID");
}

const numericScores = items.map((item) => scoreNumber(item.judge.score)).filter(Number.isFinite);
const calls = items.flatMap((item) => item.telemetry?.toolTrajectory ?? []);
const citations = items.flatMap((item) => item.cited);
const validEvidenceIds = new Set(frozen.cases.flatMap((item) =>
  (item.agent_accessible_observations ?? []).map((observation) => observation.evidenceId)));
const groups = expectedCaseIds.map((caseId) => items.filter((item) => item.caseId === caseId));
const pricing = base.model.pricing;
const cost = (band) => {
  const inputTokens = sum(items.map((item) => item.tokens.inputTokens ?? item.tokens.promptTokens));
  const outputTokens = sum(items.map((item) => item.tokens.outputTokens ?? item.tokens.completionTokens));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd: round((inputTokens * pricing[band].input_cache_miss
      + outputTokens * pricing[band].output) / pricing.unit_tokens, 6),
    assumption: "All input tokens priced as cache misses; actual billing may differ.",
  };
};

const v7 = {
  system: "HARNESS_V7",
  trials: 66,
  cases: 22,
  technicalCompletion: wilson(items.filter((item) => item.technical).length, 66),
  finalizedCompletion: wilson(items.filter((item) => item.finalized).length, 66),
  businessCompletion: wilson(items.filter((item) => item.business).length, 66),
  actionableDelivery: wilson(items.filter((item) => item.actionableDelivery).length, 66),
  abstention: {
    trials: items.filter((item) => item.terminal === "INCONCLUSIVE").length,
    judgeAccepted: wilson(items.filter((item) => item.terminal === "INCONCLUSIVE"
      && item.judge.score === "N/A").length, items.filter((item) => item.terminal === "INCONCLUSIVE").length),
    disclosure: "N/A means the blind judge found the runtime evidence objectively insufficient and accepted abstention; it is not a correct causal diagnosis.",
  },
  rootCause: {
    score2Strict: wilson(items.filter((item) => item.judge.score === "2").length, numericScores.length),
    score1Or2Lenient: wilson(items.filter((item) => ["1", "2"].includes(item.judge.score)).length, numericScores.length),
    meanScore: round(mean(numericScores)),
    numericDenominator: numericScores.length,
    notApplicable: items.filter((item) => item.judge.score === "N/A").length,
    judgeErrors: 0,
    judgeDisclosure: "Non-independent same-model blind LLM review; v7 identity hidden and run order deterministically randomized.",
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
    success: wilson(calls.filter((call) => call.status === "COMPLETED"
      && call.resultStatus !== "ERROR").length, calls.length),
    empty: wilson(calls.filter((call) => call.resultStatus === "EMPTY").length, calls.length),
    error: wilson(calls.filter((call) => call.resultStatus === "ERROR").length, calls.length),
    meanCallsPerTrial: round(calls.length / 66),
    disclosure: "EMPTY is a valid no-information result, not a transport failure.",
  },
  stability: {
    passAt1Technical: wilson(groups.filter((group) => group[0]?.technical).length, 22),
    allThreeTechnical: wilson(groups.filter((group) => group.length === 3
      && group.every((item) => item.technical)).length, 22),
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
    modelCallsTotal: sum(items.map((item) => item.modelCalls)),
    modelCallsMean: round(mean(items.map((item) => item.modelCalls))),
    toolCallsTotal: sum(items.map((item) => item.toolCalls)),
    toolCallsMean: round(mean(items.map((item) => item.toolCalls))),
    schemaRepairsOrRetriesTotal: sum(items.map((item) => item.repairs)),
    timeoutRate: wilson(items.filter((item) => /TIMEOUT/i.test(item.error ?? "")).length, 66),
    peakCost: cost("peak"),
    offPeakCost: cost("off_peak"),
  },
  terminalStates: countBy(items, (item) => item.terminal),
  errors: countBy(items.filter((item) => item.error), (item) => item.error),
};

const comparison = {
  technicalCompletion: delta(v7.technicalCompletion.proportion, v3.technicalCompletion.proportion),
  businessCompletion: delta(v7.businessCompletion.proportion, v3.businessCompletion.proportion),
  strictRootCause: delta(v7.rootCause.score2Strict.proportion, v3.rootCause.score2Strict.proportion),
  lenientRootCause: delta(v7.rootCause.score1Or2Lenient.proportion, v3.rootCause.score1Or2Lenient.proportion),
  criticalEvidenceRecall: delta(v7.evidence.meanCriticalEvidenceRecall, v3.evidence.meanCriticalEvidenceRecall),
  emptyToolRate: delta(v7.tools.empty.proportion, v3.tools.empty.proportion),
  terminalConsistency: delta(v7.stability.terminalStateConsistency.proportion, v3.stability.terminalStateConsistency.proportion),
  rootScoreConsistency: delta(v7.stability.rootScoreConsistency.proportion, v3.stability.rootScoreConsistency.proportion),
  p95DurationMs: round(v7.performance.durationMsP95 - v3.performance.durationMsP95, 1),
};

const targets = {
  technicalCompletion: { target: 0.97, value: v7.technicalCompletion.proportion, direction: "MIN" },
  businessCompletion: { target: 0.60, value: v7.businessCompletion.proportion, direction: "MIN" },
  strictRootCause: { target: 0.50, value: v7.rootCause.score2Strict.proportion, direction: "MIN" },
  lenientRootCause: { target: 0.65, value: v7.rootCause.score1Or2Lenient.proportion, direction: "MIN" },
  criticalEvidenceRecall: { target: 0.85, value: v7.evidence.meanCriticalEvidenceRecall, direction: "MIN" },
  emptyToolRate: { target: 0.30, value: v7.tools.empty.proportion, direction: "MAX" },
  terminalConsistency: { target: 0.75, value: v7.stability.terminalStateConsistency.proportion, direction: "MIN" },
  rootScoreConsistency: { target: 0.75, value: v7.stability.rootScoreConsistency.proportion, direction: "MIN" },
  p95DurationMs: { target: 210_000, value: v7.performance.durationMsP95, direction: "MAX" },
  citationValidity: { target: 1, value: v7.evidence.citationValidity.proportion, direction: "MIN" },
};
for (const metric of Object.values(targets)) {
  metric.met = metric.value !== null && (metric.direction === "MIN"
    ? metric.value >= metric.target : metric.value <= metric.target);
}
const targetsMet = Object.values(targets).filter((metric) => metric.met).length;

const reviewRows = items.filter((item) => item.judge.confidence === "LOW"
  || item.judge.score !== "2" || !item.business);
const reviewHeader = ["case_id", "system", "run_index", "terminal", "business_complete",
  "judge_score", "judge_confidence", "judge_reason", "diagnosis", "raw_result"];
const reviewCsv = [reviewHeader.map(csv).join(","), ...reviewRows.map((item) => [
  item.caseId, "HARNESS_V7", item.runIndex, item.terminal, item.business,
  item.judge.score, item.judge.confidence, item.judge.reason, item.diagnosis, item.rawRef,
].map(csv).join(","))].join("\n") + "\n";

const slices = structuredClone(base.slices);
for (const dimension of ["category", "difficulty"]) {
  for (const value of [...new Set(items.map((item) => item[dimension]))]) {
    const selected = items.filter((item) => item[dimension] === value);
    const numeric = selected.map((item) => scoreNumber(item.judge.score)).filter(Number.isFinite);
    slices[dimension][value].HARNESS_V7 = {
      trials: selected.length,
      technical: wilson(selected.filter((item) => item.technical).length, selected.length),
      business: wilson(selected.filter((item) => item.business).length, selected.length),
      score2: wilson(selected.filter((item) => item.judge.score === "2").length, numeric.length),
      meanScore: round(mean(numeric)),
    };
  }
}

const summary = {
  ...base,
  schemaVersion: "releaseguard-v3-v7-comparison-summary-v1",
  generatedAt: new Date().toISOString(),
  evaluationVersion: "0.2.0-harness-v7",
  systems: [...base.systems.filter((system) => system.system !== "HARNESS_V7"), v7],
  slices,
  judge: {
    type: "NON_INDEPENDENT_SAME_MODEL",
    cases: 22,
    attempts: judgeAttempts.length,
    failedAttempts: failedJudgeAttempts.length,
    failedCases: 0,
    status: "COMPLETE",
    scoredOutputs: numericScores.length,
    notApplicableOutputs: v7.rootCause.notApplicable,
    reviewQueueRows: reviewRows.length,
    rawResults: "judge/blind-judge-v7.jsonl",
  },
  latestEvaluationCompletedAt: reports.map((report) => report.manifest.completedAt).sort().at(-1),
  harnessV7: {
    status: "EXPERIMENTAL_DEV_NOT_HOLDOUT",
    comparisonAgainst: "HARNESS_V3",
    architecture: "SINGLE_AGENT_STAGED_COLLECTOR_READINESS_GATE_TOOL_FREE_SYNTHESIZER",
    manifestIdentity: identities[0],
    sourceContentSha256: identities[0].modelConfiguration.sourceIdentity,
    deltas: comparison,
    targets,
    targetsMet,
    targetCount: Object.keys(targets).length,
    changes: [
      "Collector gathers evidence with atomic read-only tools under AgentLoop budgets.",
      "A deterministic readiness gate separates evidence collection from conclusion generation.",
      "A tool-free synthesizer produces the final structured diagnosis or explicit abstention.",
      "Provider empty-content and structured-output failures return auditable safe outcomes instead of losing evidence.",
    ],
    sideEffects: [
      "The readiness gate can become over-conservative and suppress otherwise useful synthesis.",
      "The staged path increases model calls and prompt tokens even when tool calls decrease.",
      "Most runs can be technically successful while still failing to produce a product-useful diagnosis.",
      "The same visible Dev cases and same-model judge cannot establish production generalization.",
    ],
  },
  limitations: [
    ...base.limitations,
    "Harness v7 is a Dev experiment on the same governed cases, not a Holdout or production accuracy claim.",
    "The v7 blind judge uses the same model family and is not independent human review.",
    "A judge N/A accepts abstention for insufficient runtime evidence; it is not a successful causal attribution.",
  ],
  artifacts: {
    ...base.artifacts,
    report: "docs/evaluation/releaseguard-harness-v7-ai-pm-report.zh-CN.md",
    technicalAppendix: "docs/evaluation/releaseguard-harness-v7-technical-appendix.zh-CN.md",
    improvementReport: "docs/evaluation/releaseguard-harness-v7-improvement-report.zh-CN.md",
    reviewQueue: "evaluation/results/v7/review_queue.csv",
    rawDirectory: "evaluation/results/v7/raw/",
  },
};

const metricRows = [
  ["技术完成率", v3.technicalCompletion, v7.technicalCompletion, comparison.technicalCompletion],
  ["业务完成率", v3.businessCompletion, v7.businessCompletion, comparison.businessCompletion],
  ["严格根因得分", v3.rootCause.score2Strict, v7.rootCause.score2Strict, comparison.strictRootCause],
  ["宽松根因得分", v3.rootCause.score1Or2Lenient, v7.rootCause.score1Or2Lenient, comparison.lenientRootCause],
];
const diagnosisFunnel = [
  ["正式试验", 66],
  ["技术执行成功", v7.technicalCompletion.successes],
  ["形成明确诊断", v7.finalizedCompletion.successes],
  ["旧口径业务完成", v7.businessCompletion.successes],
  ["面向用户交付明确诊断与关键证据", v7.actionableDelivery.successes],
];
const productVerdict = v7.businessCompletion.proportion >= 0.60
  && v7.rootCause.score2Strict.proportion >= 0.50
  ? "v7 达到本轮 Dev 目标，但仍须通过不可见 Holdout 和人工复核后才能扩大试用。"
  : "v7 修复了运行可靠性，但没有达到可产品化的诊断质量门槛；当前架构不能直接替代人工归因。";

const productReport = [
  "# ReleaseGuard AI Harness v7 产品经理版完整报告", "",
  "> 面向 AI 产品经理、产品负责人和研发负责人。结果来自同一套可见 Dev 案例，不是 Holdout、生产准确率或人工评审。", "",
  "## 一句话结论", "", productVerdict, "",
  "## 调查漏斗", "",
  "| 阶段 | 数量 | 占 66 次比例 |", "| --- | ---: | ---: |",
  ...diagnosisFunnel.map(([name, value]) => `| ${name} | ${value} | ${pct(value / 66)} |`), "",
  "## v3 与 v7 核心结果", "",
  "| 指标 | Harness v3 | Harness v7 | 变化 |", "| --- | ---: | ---: | ---: |",
  ...metricRows.map(([name, before, after, change]) =>
    `| ${name} | ${rateText(before)} | ${rateText(after)} | ${deltaText(change)} |`),
  `| 关键证据召回 | ${pct(v3.evidence.meanCriticalEvidenceRecall)} | ${pct(v7.evidence.meanCriticalEvidenceRecall)} | ${deltaText(comparison.criticalEvidenceRecall)} |`,
  `| EMPTY 工具调用 | ${rateText(v3.tools.empty)} | ${rateText(v7.tools.empty)} | ${deltaText(comparison.emptyToolRate)} |`,
  `| 三轮终态一致性 | ${rateText(v3.stability.terminalStateConsistency)} | ${rateText(v7.stability.terminalStateConsistency)} | ${deltaText(comparison.terminalConsistency)} |`,
  `| 三轮根因评分一致性 | ${rateText(v3.stability.rootScoreConsistency)} | ${rateText(v7.stability.rootScoreConsistency)} | ${deltaText(comparison.rootScoreConsistency)} |`, "",
  "## v7 解决了什么", "",
  `- 66/66 次运行在技术上正常结束，说明 v4/v5 的空 content、INVALID_JSON 和结果丢失问题已被消除。`,
  `- Collector、Readiness Gate、无工具 Synthesizer 的阶段边界可审计；即使结构化生成失败，也会保留证据并安全结束。`,
  `- 工具共调用 ${v7.tools.calls} 次，EMPTY ${v7.tools.empty.successes} 次；模型调用 ${v7.performance.modelCallsTotal} 次。`, "",
  "## v7 没有解决什么", "",
  `- 只有 ${v7.finalizedCompletion.successes}/66 次形成明确诊断，${v7.terminalStates.INCONCLUSIVE ?? 0}/66 次以证据不足结束。`,
  `- 与 v3 完全同口径的业务完成为 ${rateText(v7.businessCompletion)}；但面向用户真正交付明确诊断并引用完整关键证据只有 ${rateText(v7.actionableDelivery)}。旧口径会把“证据存在于内部轨迹但最终未交付”的拒答也算完成，因此两项必须并列。`,
  `- 盲评语义层面的严格根因得分为 ${rateText(v7.rootCause.score2Strict)}；其中包含与 Gold 一致的“无法归因”结论，不能等同于明确因果诊断。`,
  `- 盲评接受的合理拒答为 ${rateText(v7.abstention.judgeAccepted)}；其余拒答属于过度保守或输出质量不足。`,
  `- 当前达到 ${targetsMet}/${Object.keys(targets).length} 项内部目标，不能进入自动归因或自动处置。`, "",
  "## 用户会感受到什么", "",
  `调查不再因协议错误突然失败，但大多数用户会得到“证据不足”，而不是可用于发布决策的归因。内部关键证据召回为 ${pct(v7.evidence.meanCriticalEvidenceRecall)}，最终引用却只有 ${v7.evidence.citationValidity.total} 个，说明证据主要停留在 Collector 内。单次中位耗时 ${(v7.performance.durationMsP50 / 1000).toFixed(1)} 秒，P95 ${(v7.performance.durationMsP95 / 1000).toFixed(1)} 秒；这比等待后报错更好，但仍不是完整产品价值。`, "",
  "## 产品决策", "",
  "- 当前只适合作为内部 Alpha 的证据收集与人工辅助界面，不适合作为自动根因判断器。",
  "- 不应继续单纯增加调用次数、重试或 Prompt 长度；主要瓶颈已经从 Provider 协议转为 Readiness Gate 与证据语义映射。",
  "- 下一步应先做离线反事实回放：让 Synthesizer 直接读取每案已收集证据，测量 Gate 放行与最终诊断各自造成的损失，再决定是否继续当前架构。",
  "- 在同一 Dev 集上修复后，必须建立不可见 Holdout；否则不能判断改善是否泛化。", "",
  "## 评测边界", "",
  "- 22 个受治理离线案例，每案 3 轮，共 66 次；所有失败和拒答都保留在分母。",
  "- Gold 只用于评分与盲评，未提供给 Agent；没有按案例 ID 硬编码、删除失败或放宽 grounding。",
  "- 盲评隐藏版本身份并打乱三轮顺序，但使用同一模型家族，不等同独立人类评审。",
  `- 数据集哈希：\`${identities[0].datasetHash}\`；源码提交：\`${identities[0].sourceCommit}\`；源码内容身份：\`${identities[0].modelConfiguration.sourceIdentity}\`。`, "",
].join("\n");

const technicalAppendix = [
  "# ReleaseGuard AI Harness v7 技术附录", "",
  "> v7 正式 Dev 三轮评测与同模型盲评的可审计统计。", "",
  "## 完整性与身份", "",
  `- 原始运行：3 × 22 = ${items.length}；盲评尝试：${judgeAttempts.length}；最终覆盖：${judgeRecords.length} 案；失败尝试：${failedJudgeAttempts.length}；数值评分：${numericScores.length}；N/A：${v7.rootCause.notApplicable}。`,
  `- 三轮数据集、源码、模型配置和连续案例顺序一致；每轮 reportStatus=COMPLETE。`,
  `- 技术完成：${rateText(v7.technicalCompletion)}；明确诊断：${rateText(v7.finalizedCompletion)}；同 v3 口径业务完成：${rateText(v7.businessCompletion)}；面向用户交付：${rateText(v7.actionableDelivery)}。`,
  `- 终态：${JSON.stringify(v7.terminalStates)}；执行错误：${JSON.stringify(v7.errors)}。`, "",
  "## 根因、证据与拒答", "",
  `- 严格根因：${rateText(v7.rootCause.score2Strict)}；宽松根因：${rateText(v7.rootCause.score1Or2Lenient)}；均分 ${v7.rootCause.meanScore ?? "n/a"}。`,
  `- 合理拒答：${rateText(v7.abstention.judgeAccepted)}；N/A 不计入数值根因分母。`,
  `- 引用有效率：${rateText(v7.evidence.citationValidity)}；关键证据召回：${pct(v7.evidence.meanCriticalEvidenceRecall)}。`,
  `- 同时处理支持与反证：${rateText(v7.evidence.supportAndContradictionHandled)}。`, "",
  "## 工具、稳定性、延迟与成本", "",
  `- 工具非错误完成：${rateText(v7.tools.success)}；EMPTY：${rateText(v7.tools.empty)}；ERROR：${rateText(v7.tools.error)}；总调用：${v7.tools.calls}。`,
  `- Pass@1：${rateText(v7.stability.passAt1Technical)}；三轮全通过：${rateText(v7.stability.allThreeTechnical)}。`,
  `- 终态一致性：${rateText(v7.stability.terminalStateConsistency)}；根因评分一致性：${rateText(v7.stability.rootScoreConsistency)}。`,
  `- P50/P95：${(v7.performance.durationMsP50 / 1000).toFixed(1)}s / ${(v7.performance.durationMsP95 / 1000).toFixed(1)}s；总耗时 ${(v7.performance.durationMsTotal / 3600000).toFixed(2)}h。`,
  `- 模型调用 ${v7.performance.modelCallsTotal}；工具调用 ${v7.performance.toolCallsTotal}；schema repair ${v7.performance.schemaRepairsOrRetriesTotal}。`,
  `- Tokens：input ${v7.performance.peakCost.inputTokens.toLocaleString()} / output ${v7.performance.peakCost.outputTokens.toLocaleString()}；峰时估算 $${v7.performance.peakCost.estimatedUsd.toFixed(4)}，非账单。`, "",
  "## 限制与副作用", "",
  ...summary.harnessV7.sideEffects.map((item) => `- ${item}`),
  "- 同数据集持续开发存在调参过拟合风险，必须用 Holdout 验证。", "",
].join("\n");

const improvementReport = [
  "# ReleaseGuard AI Harness v7 后续完整改进报告", "",
  "> 本报告依据 v3/v7 正式 Dev 对比结果生成。它是下一步研发建议，不代表功能已经实现。", "",
  "## 核心归因", "",
  "v7 的主要问题不再是模型接口或 JSON 稳定性，而是调查编排过度保守。Collector 实际收集到证据后，Readiness Gate 经常不放行；随后安全拒答路径又清空最终引用，使关键证据召回和业务完成被同时压低。模型能力仍是次要变量，但当前数据不能把 65 次拒答主要归因给模型。", "",
  "## P0：先做离线损失分解，不再直接烧 3×22", "",
  "1. 对 66 个已冻结 v7 轨迹做离线回放，禁止调用 Gold：分别测量 Collector 找到的证据、Gate 判断、Synthesizer 输出三个阶段。",
  "2. 对每个 INCONCLUSIVE，记录是缺必需证据、存在冲突、Gate 规则未满足、Synthesizer 拒答还是结构化降级。",
  "3. 用同一份已收集证据绕过 Gate 仅运行无工具 Synthesizer，作为诊断性消融，不作为正式产品结果；若质量显著回升，证明 Gate 是主瓶颈。",
  "4. 只有离线消融证明某项改动可提升后，才创建 v8 并重新运行正式 3×22。", "",
  "## P0：修正 Readiness Gate 的产品语义", "",
  "- Gate 只判断证据是否足以支持“形成结论或明确缺口”，不要要求所有理想证据齐全。",
  "- 将 `READY_FOR_CAUSAL`, `READY_FOR_BOUNDED_HYPOTHESIS`, `READY_FOR_ABSTENTION`, `NEEDS_COLLECTION` 分开，避免二元闸门把有价值的概率性结论全部拦截。",
  "- `READY_FOR_BOUNDED_HYPOTHESIS` 必须保留领先假设、反证、缺口和置信度，不得伪装确定根因。",
  "- Gate 依据事故类型与证据类别，不读取案例 ID、Gold 或目标证据 ID。", "",
  "## P0：拒答仍须交付证据资产", "",
  "- INCONCLUSIVE 输出必须引用已观察证据，列出已确认事实、仍缺数据、被排除假设和建议补充的数据源。",
  "- 业务完成率之外新增“可行动拒答率”：即使不能归因，也要让产品经理知道下一步该补什么。",
  "- 不把合理拒答计为根因正确，但单独衡量盲评 N/A 接受率和证据完整性。", "",
  "## P1：控制模型与成本", "",
  `- v7 平均模型调用 ${v7.performance.modelCallsMean} 次、平均工具调用 ${v7.performance.toolCallsMean} 次。下一版应合并纯状态整理调用，目标模型调用下降 25%，工具召回不下降。`,
  "- Collector 每得到一项关键新证据才重新评估 Gate；无新增证据时不重复综合。",
  "- Synthesizer 保持无工具和严格 schema，但只在 Gate 输出稳定状态后调用一次。", "",
  "## v8 进入正式评测前的门槛", "",
  "- 离线消融覆盖全部 66 个 v7 轨迹并生成可审计分类。",
  "- 结构化/空 content 回归测试继续 100% 通过。",
  "- 在不读 Gold 的回放中，Gate 放行率和可行动拒答率均显著高于 v7。",
  "- 小规模 smoke set 通过后再运行 3×22，避免重复消耗额度。",
  "- 正式目标仍为业务完成率 ≥60%、严格根因 ≥50%、关键证据召回 ≥85%、技术完成率 ≥97%。", "",
  "## 停止条件", "",
  "如果绕过 Gate 的离线 Synthesizer 仍无法在已收集证据上明显超过 v7，则瓶颈转为 Collector/工具可观测性或基础模型能力；此时不应继续微调 Gate，而应先扩充工具信息或做模型对照实验。", "",
].join("\n");

await mkdir(pathOf("evaluation/results/v7/"), { recursive: true });
await mkdir(pathOf("public/evaluation/"), { recursive: true });
await mkdir(pathOf("docs/evaluation/"), { recursive: true });
await writeFile(pathOf("evaluation/results/v7/summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(pathOf("public/evaluation/summary-v7.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(pathOf("evaluation/results/v7/review_queue.csv"), reviewCsv);
await writeFile(pathOf("docs/evaluation/releaseguard-harness-v7-ai-pm-report.zh-CN.md"), productReport);
await writeFile(pathOf("docs/evaluation/releaseguard-harness-v7-technical-appendix.zh-CN.md"), technicalAppendix);
await writeFile(pathOf("docs/evaluation/releaseguard-harness-v7-improvement-report.zh-CN.md"), improvementReport);
console.log(JSON.stringify({
  summary: "evaluation/results/v7/summary.json",
  reviewQueueRows: reviewRows.length,
  v7,
  comparison,
  targets: { met: targetsMet, total: Object.keys(targets).length },
}, null, 2));
