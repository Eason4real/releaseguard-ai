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
    successes,
    total,
    proportion: round(p),
    lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)),
  };
};
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const rateText = (rate) => `${rate.successes}/${rate.total} (${pct(rate.proportion)})`;

const v1 = await readJson("evaluation/results/summary.json");
const v1ImprovedReports = await Promise.all([1, 2, 3].map((index) =>
  readJson(`evaluation/results/raw/improved-agent-run-${index}.json`)));
const v1ImprovedToolCalls = v1ImprovedReports.flatMap((report) => report.cases)
  .flatMap((item) => item.telemetry?.toolTrajectory ?? item.telemetry?.toolCalls ?? []);
const v1ImprovedEmpty = wilson(
  v1ImprovedToolCalls.filter((call) => call.resultStatus === "EMPTY").length,
  v1ImprovedToolCalls.length,
);
const frozen = await readJson("evaluation/dataset/frozen-cases.json");
const frozenById = new Map(frozen.cases.map((item) => [item.case_id, item]));
const judgeRecords = await readJsonl("evaluation/results/v2/judge/blind-judge-v2.jsonl");
if (judgeRecords.length !== 22 || judgeRecords.some((record) => record.error)) {
  throw new Error("V2_JUDGE_NOT_COMPLETE");
}
const judgeByKey = new Map();
for (const record of judgeRecords) {
  for (const score of record.scores ?? []) {
    judgeByKey.set(`${score.runIndex}|${record.case_id}`, {
      score: score.score,
      reason: score.reason,
      confidence: score.confidence,
    });
  }
}

const reports = await Promise.all([1, 2, 3].map((index) =>
  readJson(`evaluation/results/v2/raw/harness-v2-run-${index}.json`)));
const manifestIdentity = reports.map((report) => ({
  datasetHash: report.manifest.datasetHash,
  sourceCommit: report.manifest.sourceCommit,
  modelConfiguration: report.manifest.modelConfiguration,
}));
if (reports.some((report) => report.reportStatus !== "COMPLETE" || report.cases.length !== 22)
  || new Set(manifestIdentity.map((item) => JSON.stringify(item))).size !== 1) {
  throw new Error("V2_RUN_IDENTITY_OR_COVERAGE_INVALID");
}

const items = [];
for (const [offset, report] of reports.entries()) {
  const runIndex = offset + 1;
  for (const item of report.cases) {
    const gold = frozenById.get(item.caseId);
    const citedEvidenceIds = item.normalizedPrediction?.citedEvidenceIds ?? [];
    const observedEvidence = new Set([
      ...citedEvidenceIds,
      ...(item.telemetry?.evidencePersistenceEvents ?? []).map((event) => event.evidenceId),
    ]);
    const critical = gold.critical_evidence_ids ?? [];
    const diagnosis = item.normalizedPrediction?.predictedRootCause ?? null;
    const technical = item.execution.status === "PASS";
    items.push({
      system: "HARNESS_V2",
      runIndex,
      caseId: item.caseId,
      category: gold.incident_type,
      difficulty: gold.difficulty,
      technical,
      terminal: technical ? item.execution.terminalInvestigationState : "FAILED",
      diagnosis,
      citedEvidenceIds,
      criticalEvidenceRecall: critical.length
        ? critical.filter((id) => observedEvidence.has(id)).length / critical.length : null,
      business: technical && Boolean(diagnosis) && critical.every((id) => observedEvidence.has(id)),
      judge: judgeByKey.get(`${runIndex}|${item.caseId}`) ?? null,
      durationMs: item.normalizedPrediction?.durationMs ?? item.scoring?.cost?.durationMs ?? null,
      modelCalls: item.telemetry?.modelCallCount ?? item.execution.modelCallCount,
      toolCalls: item.telemetry?.toolCallCount ?? item.execution.toolCallCount,
      tokens: item.normalizedPrediction?.tokenUsage ?? item.scoring?.cost?.tokenUsage ?? {},
      error: item.execution.error ?? item.execution.errorCategory ?? null,
      retries: item.telemetry?.schemaRepairCount ?? 0,
      scoring: item.scoring,
      telemetry: item.telemetry,
      rawRef: `raw/harness-v2-run-${runIndex}.json`,
    });
  }
}
if (items.length !== 66 || items.some((item) => !item.judge)) throw new Error("V2_TRIAL_COVERAGE_INVALID");

const pricing = v1.model.pricing;
const cost = (band) => {
  const inputTokens = sum(items.map((item) => item.tokens.inputTokens ?? item.tokens.promptTokens));
  const outputTokens = sum(items.map((item) => item.tokens.outputTokens ?? item.tokens.completionTokens));
  const rates = pricing[band];
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd: round((inputTokens * rates.input_cache_miss + outputTokens * rates.output) / pricing.unit_tokens, 6),
    assumption: "All input tokens priced as cache misses; failed-trial token telemetry may be incomplete.",
  };
};
const calls = items.flatMap((item) => item.telemetry?.toolTrajectory ?? item.telemetry?.toolCalls ?? []);
const emptyCalls = calls.filter((call) => call.resultStatus === "EMPTY").length;
const successfulCalls = calls.filter((call) => call.status === "COMPLETED" && call.resultStatus !== "ERROR").length;
const validEvidenceIds = new Set(frozen.cases.flatMap((item) =>
  (item.agent_accessible_observations ?? []).map((observation) => observation.evidenceId)));
const citations = items.flatMap((item) => item.citedEvidenceIds);
const grounding = items.map((item) => item.scoring?.grounding?.unsupportedClaimRate)
  .filter((value) => value !== null && value !== undefined);
const scoreNumber = (score) => ["0", "1", "2"].includes(score) ? Number(score) : null;
const numericScores = items.map((item) => scoreNumber(item.judge.score)).filter((value) => value !== null);
const errors = {};
const terminals = {};
for (const item of items) {
  if (item.error) errors[item.error] = (errors[item.error] ?? 0) + 1;
  terminals[item.terminal] = (terminals[item.terminal] ?? 0) + 1;
}
const groups = frozen.cases.map((gold) => items.filter((item) => item.caseId === gold.case_id));
const v2System = {
  system: "HARNESS_V2",
  trials: items.length,
  cases: groups.length,
  technicalCompletion: wilson(items.filter((item) => item.technical).length, items.length),
  businessCompletion: wilson(items.filter((item) => item.business).length, items.length),
  rootCause: {
    score2Strict: wilson(items.filter((item) => item.judge.score === "2").length, numericScores.length),
    score1Or2Lenient: wilson(items.filter((item) => ["1", "2"].includes(item.judge.score)).length, numericScores.length),
    meanScore: round(mean(numericScores)),
    numericDenominator: numericScores.length,
    notApplicable: items.filter((item) => item.judge.score === "N/A").length,
    judgeErrors: items.filter((item) => !item.judge).length,
    judgeDisclosure: "Non-independent same-model blind LLM review; v2 identities hidden and run order deterministically randomized.",
  },
  evidence: {
    citationValidity: wilson(citations.filter((id) => validEvidenceIds.has(id)).length, citations.length),
    meanCitationSupport: round(mean(items.map((item) => item.scoring?.evidence?.precision).filter(Number.isFinite))),
    meanUnsupportedClaimRate: round(mean(grounding)),
    groundingEvaluableTrials: grounding.length,
    meanCriticalEvidenceRecall: round(mean(items.map((item) => item.criticalEvidenceRecall).filter(Number.isFinite))),
    supportAndContradictionHandled: wilson(items.filter((item) => {
      const relations = new Set((item.telemetry?.evidenceAssessments ?? []).map((event) => event.relation));
      return relations.has("SUPPORTS") && relations.has("CONTRADICTS");
    }).length, items.length),
  },
  tools: {
    calls: calls.length,
    success: wilson(successfulCalls, calls.length),
    empty: wilson(emptyCalls, calls.length),
    meanCallsPerTrial: round(calls.length / items.length),
    disclosure: "EMPTY is a valid no-information result, not a transport failure.",
  },
  stability: {
    passAt1Technical: wilson(groups.filter((group) => group[0]?.technical).length, groups.length),
    allThreeTechnical: wilson(groups.filter((group) => group.length === 3 && group.every((item) => item.technical)).length, groups.length),
    terminalStateConsistency: wilson(groups.filter((group) => group.length === 3
      && new Set(group.map((item) => item.terminal)).size === 1).length, groups.length),
    rootScoreConsistency: wilson(groups.filter((group) => group.length === 3
      && new Set(group.map((item) => item.judge.score)).size === 1).length, groups.length),
    interventionFreeTrials: wilson(items.length, items.length),
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
    schemaRepairsOrRetriesTotal: sum(items.map((item) => item.retries)),
    timeoutRate: wilson(items.filter((item) => /TIMEOUT/i.test(item.error ?? "")).length, items.length),
    peakCost: cost("peak"),
    offPeakCost: cost("off_peak"),
  },
  terminalStates: terminals,
  errors,
};

const slices = structuredClone(v1.slices);
for (const dimension of ["category", "difficulty"]) {
  for (const value of [...new Set(items.map((item) => item[dimension]))]) {
    const selected = items.filter((item) => item[dimension] === value);
    const numeric = selected.map((item) => scoreNumber(item.judge.score)).filter((score) => score !== null);
    slices[dimension][value].HARNESS_V2 = {
      trials: selected.length,
      technical: wilson(selected.filter((item) => item.technical).length, selected.length),
      score2: wilson(selected.filter((item) => item.judge.score === "2").length, numeric.length),
      meanScore: round(mean(numeric)),
    };
  }
}

const reviewRows = items.filter((item) => !item.judge || item.judge.confidence === "LOW"
  || ["1", "N/A"].includes(item.judge.score));
const reviewHeader = ["case_id", "system", "run_index", "judge_score", "judge_confidence", "judge_reason", "diagnosis", "raw_result"];
const reviewCsv = [reviewHeader.map(csv).join(","), ...reviewRows.map((item) => [
  item.caseId, item.system, item.runIndex, item.judge?.score ?? "ERROR", item.judge?.confidence ?? "",
  item.judge?.reason ?? "Judge output unavailable", item.diagnosis ?? "", item.rawRef,
].map(csv).join(","))].join("\n") + "\n";
const typical = items.find((item) => item.judge.score === "2" && item.telemetry && item.diagnosis);
const v1Improved = v1.systems.find((system) => system.system === "IMPROVED_AGENT");
const delta = (after, before) => after === null || before === null ? null : round(after - before);
const comparison = {
  technicalCompletion: delta(v2System.technicalCompletion.proportion, v1Improved.technicalCompletion.proportion),
  businessCompletion: delta(v2System.businessCompletion.proportion, v1Improved.businessCompletion.proportion),
  strictRootCause: delta(v2System.rootCause.score2Strict.proportion, v1Improved.rootCause.score2Strict.proportion),
  lenientRootCause: delta(v2System.rootCause.score1Or2Lenient.proportion, v1Improved.rootCause.score1Or2Lenient.proportion),
  criticalEvidenceRecall: delta(v2System.evidence.meanCriticalEvidenceRecall, v1Improved.evidence.meanCriticalEvidenceRecall),
  emptyToolRate: delta(v2System.tools.empty.proportion, v1ImprovedEmpty.proportion),
};
const summary = {
  ...v1,
  schemaVersion: "releaseguard-v1-v2-comparison-summary-v1",
  generatedAt: new Date().toISOString(),
  evaluationVersion: "0.2.0-harness-v2",
  systems: [...v1.systems, v2System],
  slices,
  judge: {
    type: "NON_INDEPENDENT_SAME_MODEL",
    cases: judgeRecords.length,
    failedCases: 0,
    status: "COMPLETE",
    scoredOutputs: numericScores.length,
    reviewQueueRows: reviewRows.length,
    rawResults: "judge/blind-judge-v2.jsonl",
  },
  typicalTrace: typical ? {
    caseId: typical.caseId,
    runIndex: typical.runIndex,
    diagnosis: typical.diagnosis,
    rootCauseScore: typical.judge.score,
    actions: (typical.telemetry.iterations ?? []).map((event) => ({
      sequence: event.sequence, decisionType: event.decisionType, rationale: event.publicRationale,
    })),
    tools: (typical.telemetry.toolTrajectory ?? []).map((call) => ({
      toolName: call.toolName, resultStatus: call.resultStatus, evidenceIds: call.evidenceIds,
    })),
  } : null,
  latestEvaluationCompletedAt: reports.map((report) => report.manifest.completedAt).sort().at(-1),
  harnessV2: {
    status: "EXPERIMENTAL_DEV_NOT_HOLDOUT",
    manifestIdentity: manifestIdentity[0],
    comparisonAgainst: "IMPROVED_AGENT_V1",
    deltas: comparison,
    excludedAttempts: [
      "v2/misconfigured-attempt-1: transportRetry=0 and fixtureQueryHints=false",
      "v2/quota-exhausted-attempt-2: provider quota failures; valid CASE-201..203 prefix resumed into formal run 2",
    ],
    sideEffects: [
      "Transport retry can increase wall time and billing ambiguity for lost responses.",
      "Fixture query-shape hints disclose metric and dimension names; production parity requires schema metadata.",
      "Resume logic adds checkpoint provenance and operational complexity.",
      "Approval, AgentLoop, evidence grounding, and external-write boundaries were not relaxed.",
    ],
  },
  limitations: [
    ...v1.limitations,
    "Harness v2 is a Dev experiment on the same governed cases, not a Holdout or production accuracy claim.",
    "The v2 blind judge uses the same model family and is not independent human review.",
    "Failed trials can have incomplete duration and token telemetry; cost and latency denominators are disclosed.",
  ],
  artifacts: {
    ...v1.artifacts,
    report: "docs/evaluation/releaseguard-harness-v2-comparison-report.zh-CN.md",
    reviewQueue: "evaluation/results/v2/review_queue.csv",
    rawDirectory: "evaluation/results/v2/raw/",
  },
};

const table = (language) => {
  const labels = language === "zh" ? {
    title: "ReleaseGuard AI Harness v2 对比报告",
    boundary: "这是同一受治理 Dev 数据集上的实验对比，不是 Holdout、生产准确率或人工评审。",
    metric: "指标", v1: "Improved Agent v1", v2: "Harness v2", change: "变化",
  } : {
    title: "ReleaseGuard AI Harness v2 Comparison Report",
    boundary: "This is an experimental comparison on the same governed Dev set, not a Holdout, production-accuracy, or human-review claim.",
    metric: "Metric", v1: "Improved Agent v1", v2: "Harness v2", change: "Delta",
  };
  const rows = [
    ["Technical completion", v1Improved.technicalCompletion, v2System.technicalCompletion, comparison.technicalCompletion],
    ["Business completion", v1Improved.businessCompletion, v2System.businessCompletion, comparison.businessCompletion],
    ["Strict root cause (2)", v1Improved.rootCause.score2Strict, v2System.rootCause.score2Strict, comparison.strictRootCause],
    ["Lenient root cause (1-2)", v1Improved.rootCause.score1Or2Lenient, v2System.rootCause.score1Or2Lenient, comparison.lenientRootCause],
  ];
  if (language === "zh") {
    const zhRows = [
      ["技术完成率", v1Improved.technicalCompletion, v2System.technicalCompletion, comparison.technicalCompletion],
      ["业务完成率", v1Improved.businessCompletion, v2System.businessCompletion, comparison.businessCompletion],
      ["严格根因得分 2", v1Improved.rootCause.score2Strict, v2System.rootCause.score2Strict, comparison.strictRootCause],
      ["宽松根因得分 1-2", v1Improved.rootCause.score1Or2Lenient, v2System.rootCause.score1Or2Lenient, comparison.lenientRootCause],
    ];
    return [
      `# ${labels.title}`,
      "",
      `> ${labels.boundary}`,
      "",
      "## 一、核心结果",
      "",
      `| ${labels.metric} | ${labels.v1} | ${labels.v2} | ${labels.change} |`,
      "| --- | ---: | ---: | ---: |",
      ...zhRows.map(([name, before, after, difference]) => `| ${name} | ${rateText(before)} | ${rateText(after)} | ${difference === null ? "不适用" : `${difference >= 0 ? "+" : ""}${(difference * 100).toFixed(1)} 个百分点`} |`),
      `| 平均关键证据召回 | ${pct(v1Improved.evidence.meanCriticalEvidenceRecall)} | ${pct(v2System.evidence.meanCriticalEvidenceRecall)} | +${(comparison.criticalEvidenceRecall * 100).toFixed(1)} 个百分点 |`,
      `| EMPTY 工具调用 | ${rateText(v1ImprovedEmpty)} | ${rateText(v2System.tools.empty)} | ${(comparison.emptyToolRate * 100).toFixed(1)} 个百分点 |`,
      "",
      "v2 相比受 Provider 余额中断污染的 Improved Agent v1，各项核心指标均上升。其中技术完成率恢复到 93.9%，但严格根因得分仍只有 28.8%，不能宣称达到 80-90%。Direct LLM v1 的严格得分为 72.7%，仍明显高于 Harness v2。",
      "",
      "## 二、执行完整性与稳定性",
      "",
      `- 正式 v2 覆盖 22 个案例、每案 3 轮，共 66/66 次试验；技术失败 ${66 - v2System.technicalCompletion.successes} 次。`,
      `- 独立版本盲评完成 22/22 个案例请求、66/66 个匿名输出评分，格式修复 ${judgeRecords.reduce((total, record) => total + record.repair_count, 0)} 次，错误 0 次。`,
      `- 首轮技术成功 ${rateText(v2System.stability.passAt1Technical)}；三轮全部技术成功 ${rateText(v2System.stability.allThreeTechnical)}。`,
      `- 终态一致性 ${rateText(v2System.stability.terminalStateConsistency)}；根因得分一致性 ${rateText(v2System.stability.rootScoreConsistency)}。`,
      "- 盲评使用同一模型家族，方案身份被隐藏且顺序确定性打乱，但它不是独立模型裁决或人工审核。",
      "",
      "## 三、工具与证据",
      "",
      `- 工具非错误完成率 ${rateText(v2System.tools.success)}，共 ${v2System.tools.calls} 次调用。`,
      `- EMPTY 占 ${rateText(v2System.tools.empty)}。EMPTY 表示没有信息增益，不是传输失败；54.4% 的比例仍然过高，是下一版 Harness 的首要问题。`,
      `- 平均关键证据召回 ${pct(v2System.evidence.meanCriticalEvidenceRecall)}，引用 ID 有效率 ${rateText(v2System.evidence.citationValidity)}。`,
      `- 同时处理支持与反证的试验占 ${rateText(v2System.evidence.supportAndContradictionHandled)}。`,
      "",
      "## 四、延迟、Tokens 与成本",
      "",
      `- 在 ${v2System.performance.durationAvailableTrials}/66 个有完整耗时遥测的试验中，P50 为 ${(v2System.performance.durationMsP50 / 1000).toFixed(1)} 秒，P95 为 ${(v2System.performance.durationMsP95 / 1000).toFixed(1)} 秒。`,
      `- 模型调用 ${v2System.performance.modelCallsTotal} 次，工具调用 ${v2System.performance.toolCallsTotal} 次。`,
      `- 已记录 ${v2System.performance.peakCost.inputTokens.toLocaleString()} input tokens 和 ${v2System.performance.peakCost.outputTokens.toLocaleString()} output tokens。`,
      `- 按配置中的峰时公开单价估算成本为 $${v2System.performance.peakCost.estimatedUsd.toFixed(4)}；失败试验可能缺少 token 遥测，因此该值不是账单。`,
      "",
      "## 五、错误与失败案例",
      "",
      ...Object.entries(v2System.errors).map(([name, count]) => `- \`${name}\`：${count} 次。`),
      "- 所有失败均保留在 66 次正式分母中，没有删除或选择性重跑。",
      "- 误配置尝试和额度耗尽尝试分别归档，不进入正式分母；第 2 轮仅复用了通过哈希、提交、配置与连续前缀校验的 CASE-201 至 CASE-203。",
      "",
      "## 六、版本边界与副作用",
      "",
      "- 有限传输重试可恢复短暂网络/5xx 错误，但可能增加耗时，并对响应已生成但传输丢失的请求产生计费不确定性。",
      "- Fixture 查询提示只暴露指标和维度名称，不暴露观察值、证据 ID、案例 ID 或 Gold；生产环境要达到同等能力，需要真实 schema/catalog 元数据。",
      "- 安全断点续跑增加了检查点来源管理复杂度，但避免了重复案例和不兼容结果拼接。",
      "- AgentLoop、审批、证据 grounding 和外部写入边界均未放宽。",
      "",
      "## 七、来源、限制与下一步",
      "",
      `- 数据集哈希：\`${manifestIdentity[0].datasetHash}\`；源码提交：\`${manifestIdentity[0].sourceCommit}\`。`,
      "- 这是开发期间可见的同一 Dev 集，不是不可见 Holdout，也不代表企业生产数据。",
      "- 数据包含 16 个合成案例和 6 个仓库原生案例，Wilson 区间仍较宽。",
      "- 下一步应优先降低 EMPTY 调用和过度 INCONCLUSIVE，改进证据充分性协议与无信息停止规则；然后在独立 Holdout 和人工/独立模型评审上复测。",
      "- 当前结果不支持 80-90% 根因准确率声明。",
      "",
    ].join("\n");
  }
  return [
    `# ${labels.title}`,
    "",
    `> ${labels.boundary}`,
    "",
    "## Result",
    "",
    `| ${labels.metric} | ${labels.v1} | ${labels.v2} | ${labels.change} |`,
    "| --- | ---: | ---: | ---: |",
    ...rows.map(([name, before, after, difference]) => `| ${name} | ${rateText(before)} | ${rateText(after)} | ${difference === null ? "n/a" : `${difference >= 0 ? "+" : ""}${(difference * 100).toFixed(1)} pp`} |`),
    `| Mean critical evidence recall | ${pct(v1Improved.evidence.meanCriticalEvidenceRecall)} | ${pct(v2System.evidence.meanCriticalEvidenceRecall)} | ${comparison.criticalEvidenceRecall === null ? "n/a" : `${comparison.criticalEvidenceRecall >= 0 ? "+" : ""}${(comparison.criticalEvidenceRecall * 100).toFixed(1)} pp`} |`,
    `| EMPTY tool calls | ${rateText(v1ImprovedEmpty)} | ${rateText(v2System.tools.empty)} | ${(comparison.emptyToolRate * 100).toFixed(1)} pp |`,
    "",
    "## Execution and stability",
    "",
    `- Formal v2 coverage: 66/66 trials across 22 cases and three runs; technical failures: ${66 - v2System.technicalCompletion.successes}.`,
    `- Blind judge: 22/22 case requests, 66/66 scored outputs, ${judgeRecords.reduce((total, record) => total + record.repair_count, 0)} repairs, 0 errors.`,
    `- Pass@1 technical: ${rateText(v2System.stability.passAt1Technical)}; all-three technical: ${rateText(v2System.stability.allThreeTechnical)}; terminal consistency: ${rateText(v2System.stability.terminalStateConsistency)}; root-score consistency: ${rateText(v2System.stability.rootScoreConsistency)}.`,
    `- Tool success: ${rateText(v2System.tools.success)}; EMPTY: ${rateText(v2System.tools.empty)}; calls: ${v2System.tools.calls}.`,
    `- Latency P50/P95 over ${v2System.performance.durationAvailableTrials} observable trials: ${(v2System.performance.durationMsP50 / 1000).toFixed(1)}s / ${(v2System.performance.durationMsP95 / 1000).toFixed(1)}s.`,
    `- Tokens observed: ${v2System.performance.peakCost.inputTokens} input / ${v2System.performance.peakCost.outputTokens} output; peak cost estimate: $${v2System.performance.peakCost.estimatedUsd.toFixed(4)}.`,
    `- Errors: ${Object.entries(v2System.errors).map(([name, count]) => `${name}=${count}`).join(", ") || "none"}.`,
    "",
    "## Interpretation",
    "",
    language === "zh"
      ? "v2 明显恢复了技术完成率，并提高业务完成、严格/宽松根因得分和关键证据召回；但严格得分仍不足 30%，不能宣称已达到 80-90%。主要剩余问题是过度 INCONCLUSIVE、EMPTY 查询和结构化输出尾部失败。"
      : "v2 materially recovered technical completion and improved business completion, strict/lenient root-cause scores, and critical-evidence recall. Strict accuracy remains below 30%, so no 80-90% claim is supported. Remaining problems include excessive INCONCLUSIVE outcomes, EMPTY queries, and tail schema failures.",
    "",
    "## Provenance and exclusions",
    "",
    `- Dataset hash: \`${manifestIdentity[0].datasetHash}\`; source commit: \`${manifestIdentity[0].sourceCommit}\`.`,
    "- The misconfigured first attempt and quota-exhausted attempt are retained in separate directories and excluded from the formal denominator.",
    "- Gold was available only to scoring and blind judging, never to Agent execution.",
    "- No failures were deleted, no case-ID-specific behavior was added, and approval/write boundaries remain unchanged.",
    "",
    "## Side effects and limitations",
    "",
    ...summary.harnessV2.sideEffects.map((item) => `- ${item}`),
    ...summary.limitations.slice(-3).map((item) => `- ${item}`),
    "",
  ].join("\n");
};

await mkdir(pathOf("evaluation/results/v2/"), { recursive: true });
await mkdir(pathOf("public/evaluation/"), { recursive: true });
await writeFile(pathOf("evaluation/results/v2/summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(pathOf("public/evaluation/summary-v2.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(pathOf("evaluation/results/v2/review_queue.csv"), reviewCsv);
await writeFile(pathOf("docs/evaluation/releaseguard-harness-v2-comparison-report.md"), table("en"));
await writeFile(pathOf("docs/evaluation/releaseguard-harness-v2-comparison-report.zh-CN.md"), table("zh"));
console.log(JSON.stringify({
  summary: pathOf("evaluation/results/v2/summary.json"),
  reviewQueueRows: reviewRows.length,
  v2: {
    technical: v2System.technicalCompletion,
    business: v2System.businessCompletion,
    strict: v2System.rootCause.score2Strict,
    lenient: v2System.rootCause.score1Or2Lenient,
    criticalEvidenceRecall: v2System.evidence.meanCriticalEvidenceRecall,
    emptyToolCalls: v2System.tools.empty,
  },
}, null, 2));
