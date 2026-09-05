import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const filePath = (relative) => new URL(relative, root).pathname;
const readJson = async (relative) => JSON.parse(await readFile(filePath(relative), "utf8"));
const readJsonl = async (relative) => (await readFile(filePath(relative), "utf8"))
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
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
  return { successes, total, proportion: round(p), lower: round(Math.max(0, center - margin)), upper: round(Math.min(1, center + margin)) };
};
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
  return value;
};
const canonical = (value) => JSON.stringify(canonicalize(value));

const frozen = await readJson("evaluation/dataset/frozen-cases.json");
const frozenById = new Map(frozen.cases.map((item) => [item.case_id, item]));
const judgeRecords = await readJsonl("evaluation/results/raw/blind-judge.jsonl");
const judgeByKey = new Map();
for (const record of judgeRecords) {
  for (const score of record.scores ?? []) {
    judgeByKey.set(`${score.system}|${score.runIndex}|${record.case_id}`, {
      score: score.score,
      reason: score.reason,
      confidence: score.confidence,
      judgeError: record.error,
    });
  }
}

const runs = [];
for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
  for (const record of await readJsonl(`evaluation/results/raw/direct-llm-run-${runIndex}.jsonl`)) {
    runs.push({
      system: "DIRECT_LLM", runIndex, caseId: record.case_id,
      technical: !record.error, terminal: record.error ? "FAILED" : "FINALIZED",
      diagnosis: record.final_diagnosis, citedEvidenceIds: record.evidence ?? [],
      durationMs: record.duration_ms, modelCalls: 1, toolCalls: 0,
      tokens: record.token_usage ?? {}, error: record.error, retries: record.retries ?? 0,
      scoring: record.scoring, telemetry: null, rawRef: `raw/direct-llm-run-${runIndex}.jsonl`,
    });
  }
  for (const [system, prefix] of [["CURRENT_AGENT", "current-agent"], ["IMPROVED_AGENT", "improved-agent"]]) {
    const report = await readJson(`evaluation/results/raw/${prefix}-run-${runIndex}.json`);
    for (const item of report.cases) {
      runs.push({
        system, runIndex, caseId: item.caseId,
        technical: item.execution.status === "PASS",
        terminal: item.execution.status === "PASS" ? item.execution.terminalInvestigationState : "FAILED",
        diagnosis: item.normalizedPrediction?.predictedRootCause ?? null,
        citedEvidenceIds: item.normalizedPrediction?.citedEvidenceIds ?? [],
        durationMs: item.normalizedPrediction?.durationMs ?? item.scoring?.cost?.durationMs ?? null,
        modelCalls: item.telemetry?.modelCallCount ?? item.execution.modelCallCount,
        toolCalls: item.telemetry?.toolCallCount ?? item.execution.toolCallCount,
        tokens: item.normalizedPrediction?.tokenUsage ?? item.scoring?.cost?.tokenUsage ?? {},
        error: item.execution.errorCategory,
        retries: item.telemetry?.schemaRepairCount ?? 0,
        scoring: item.scoring,
        telemetry: item.telemetry,
        rawRef: `raw/${prefix}-run-${runIndex}.json`,
      });
    }
  }
}

for (const item of runs) {
  const gold = frozenById.get(item.caseId);
  const observedEvidence = new Set([
    ...item.citedEvidenceIds,
    ...(item.telemetry?.evidencePersistenceEvents ?? []).map((event) => event.evidenceId),
  ]);
  const critical = gold.critical_evidence_ids ?? [];
  item.criticalEvidenceRecall = critical.length
    ? critical.filter((id) => observedEvidence.has(id)).length / critical.length : null;
  item.business = item.technical && Boolean(item.diagnosis)
    && critical.every((id) => observedEvidence.has(id));
  item.judge = judgeByKey.get(`${item.system}|${item.runIndex}|${item.caseId}`) ?? null;
  item.category = gold.incident_type;
  item.difficulty = gold.difficulty;
}

const pricing = (await readJson("evaluation/config/model.json")).pricing;
const scoreNumber = (score) => ["0", "1", "2"].includes(score) ? Number(score) : null;
const outputCost = (items, band) => {
  const input = sum(items.map((item) => item.tokens.inputTokens ?? item.tokens.promptTokens));
  const output = sum(items.map((item) => item.tokens.outputTokens ?? item.tokens.completionTokens));
  const rates = pricing[band];
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    estimatedUsd: round((input * rates.input_cache_miss + output * rates.output) / pricing.unit_tokens, 6),
    assumption: "All input tokens priced as cache misses; actual billed amount may differ.",
  };
};

function toolMetrics(items) {
  const calls = items.flatMap((item) => item.telemetry?.toolCalls ?? []);
  if (!calls.length) return null;
  let duplicates = 0;
  for (const item of items) {
    const signatures = new Set();
    for (const call of item.telemetry?.toolCalls ?? []) {
      const signature = `${call.toolName}|${canonical(call.arguments ?? {})}`;
      if (signatures.has(signature)) duplicates += 1;
      signatures.add(signature);
    }
  }
  const successful = calls.filter((call) => call.status === "COMPLETED" && call.resultStatus !== "ERROR").length;
  const empty = calls.filter((call) => call.resultStatus === "EMPTY").length;
  let failedTrials = 0;
  let recovered = 0;
  for (const item of items) {
    const itemCalls = item.telemetry?.toolCalls ?? [];
    const firstError = itemCalls.findIndex((call) => call.status !== "COMPLETED" || call.resultStatus === "ERROR");
    if (firstError >= 0) {
      failedTrials += 1;
      if (itemCalls.slice(firstError + 1).some((call) => call.status === "COMPLETED" && call.resultStatus !== "ERROR")) recovered += 1;
    }
  }
  const invalidArguments = items.flatMap((item) => item.telemetry?.guardEvents ?? [])
    .filter((event) => /ARGUMENT|PARAM/i.test(`${event.code ?? ""}|${event.reason ?? ""}`)).length;
  const criticalToolRuns = items.map((item) => {
    const gold = frozenById.get(item.caseId);
    const criticalIds = new Set(gold.critical_evidence_ids ?? []);
    const required = new Set((gold.agent_accessible_observations ?? [])
      .filter((observation) => criticalIds.has(observation.evidenceId)).map((observation) => observation.toolName));
    const called = new Set((item.telemetry?.toolCalls ?? []).map((call) => call.toolName));
    return required.size ? [...required].filter((name) => called.has(name)).length / required.size : null;
  }).filter((value) => value !== null);
  return {
    calls: calls.length,
    success: wilson(successful, calls.length),
    invalidArguments: wilson(invalidArguments, calls.length),
    duplicateCalls: wilson(duplicates, calls.length),
    noInformationGain: wilson(empty, calls.length),
    meanCallsPerTrial: round(calls.length / items.length),
    failureRecovery: wilson(recovered, failedTrials),
    meanCriticalToolRecall: round(mean(criticalToolRuns)),
  };
}

function evidenceMetrics(items) {
  let cited = 0;
  let valid = 0;
  const supportValues = [];
  const unsupported = [];
  let bothSides = 0;
  for (const item of items) {
    const gold = frozenById.get(item.caseId);
    const validIds = new Set((gold.agent_accessible_observations ?? []).map((observation) => observation.evidenceId));
    cited += item.citedEvidenceIds.length;
    valid += item.citedEvidenceIds.filter((id) => validIds.has(id)).length;
    if (item.scoring?.evidence?.precision !== undefined) supportValues.push(item.scoring.evidence.precision);
    if (item.scoring?.grounding?.unsupportedClaimRate !== null && item.scoring?.grounding?.unsupportedClaimRate !== undefined) unsupported.push(item.scoring.grounding.unsupportedClaimRate);
    const relations = new Set((item.telemetry?.evidenceAssessments ?? []).map((event) => event.relation));
    if (relations.has("SUPPORTS") && relations.has("CONTRADICTS")) bothSides += 1;
  }
  return {
    citationValidity: wilson(valid, cited),
    meanCitationSupport: round(mean(supportValues)),
    meanUnsupportedClaimRate: round(mean(unsupported)),
    groundingEvaluableTrials: unsupported.length,
    meanCriticalEvidenceRecall: round(mean(items.map((item) => item.criticalEvidenceRecall).filter((value) => value !== null))),
    supportAndContradictionHandled: wilson(bothSides, items.length),
  };
}

function stability(items) {
  const caseGroups = new Map();
  for (const item of items) {
    const group = caseGroups.get(item.caseId) ?? [];
    group.push(item);
    caseGroups.set(item.caseId, group);
  }
  const groups = [...caseGroups.values()].map((group) => group.sort((a, b) => a.runIndex - b.runIndex));
  return {
    passAt1Technical: wilson(groups.filter((group) => group[0]?.technical).length, groups.length),
    allThreeTechnical: wilson(groups.filter((group) => group.length === 3 && group.every((item) => item.technical)).length, groups.length),
    terminalStateConsistency: wilson(groups.filter((group) => group.length === 3 && new Set(group.map((item) => item.terminal)).size === 1).length, groups.length),
    rootScoreConsistency: wilson(groups.filter((group) => group.length === 3 && new Set(group.map((item) => item.judge?.score ?? "ERROR")).size === 1).length, groups.length),
    interventionFreeTrials: wilson(items.filter((item) => !/WAITING_HUMAN/.test(item.terminal)).length, items.length),
    scopeNote: "Intervention-free means no mid-run human state/input modification in the offline harness; it is not an enterprise unattended-operation claim.",
  };
}

function systemSummary(system) {
  const items = runs.filter((item) => item.system === system);
  const numeric = items.map((item) => scoreNumber(item.judge?.score)).filter((value) => value !== null);
  const strict = items.filter((item) => item.judge?.score === "2").length;
  const lenient = items.filter((item) => ["1", "2"].includes(item.judge?.score)).length;
  const nA = items.filter((item) => item.judge?.score === "N/A").length;
  const errors = {};
  for (const item of items.filter((value) => value.error)) errors[item.error] = (errors[item.error] ?? 0) + 1;
  const terminal = {};
  for (const item of items) terminal[item.terminal] = (terminal[item.terminal] ?? 0) + 1;
  return {
    system,
    trials: items.length,
    cases: new Set(items.map((item) => item.caseId)).size,
    technicalCompletion: wilson(items.filter((item) => item.technical).length, items.length),
    businessCompletion: wilson(items.filter((item) => item.business).length, items.length),
    rootCause: {
      score2Strict: wilson(strict, numeric.length),
      score1Or2Lenient: wilson(lenient, numeric.length),
      meanScore: round(mean(numeric)),
      numericDenominator: numeric.length,
      notApplicable: nA,
      judgeErrors: items.filter((item) => !item.judge).length,
      judgeDisclosure: "Non-independent same-model blind LLM review; system identities hidden and output order deterministically randomized.",
    },
    evidence: evidenceMetrics(items),
    tools: toolMetrics(items),
    stability: stability(items),
    performance: {
      durationMsP50: round(percentile(items.map((item) => item.durationMs).filter((value) => value !== null), 0.5), 1),
      durationMsP95: round(percentile(items.map((item) => item.durationMs).filter((value) => value !== null), 0.95), 1),
      durationMsTotal: round(sum(items.map((item) => item.durationMs).filter((value) => value !== null)), 1),
      durationAvailableTrials: items.filter((item) => item.durationMs !== null).length,
      modelCallsTotal: sum(items.map((item) => item.modelCalls)),
      modelCallsMean: round(mean(items.map((item) => item.modelCalls))),
      toolCallsTotal: sum(items.map((item) => item.toolCalls)),
      toolCallsMean: round(mean(items.map((item) => item.toolCalls))),
      schemaRepairsOrRetriesTotal: sum(items.map((item) => item.retries)),
      timeoutRate: wilson(items.filter((item) => /TIMEOUT/i.test(item.error ?? "")).length, items.length),
      peakCost: outputCost(items, "peak"),
      offPeakCost: outputCost(items, "off_peak"),
    },
    terminalStates: terminal,
    errors,
  };
}

const systems = ["DIRECT_LLM", "CURRENT_AGENT", "IMPROVED_AGENT"].map(systemSummary);
const slices = {};
for (const dimension of ["category", "difficulty"]) {
  slices[dimension] = {};
  for (const value of [...new Set(runs.map((item) => item[dimension]))].sort()) {
    slices[dimension][value] = {};
    for (const system of systems.map((item) => item.system)) {
      const items = runs.filter((item) => item.system === system && item[dimension] === value);
      const numeric = items.map((item) => scoreNumber(item.judge?.score)).filter((score) => score !== null);
      slices[dimension][value][system] = {
        trials: items.length,
        technical: wilson(items.filter((item) => item.technical).length, items.length),
        score2: wilson(items.filter((item) => item.judge?.score === "2").length, numeric.length),
        meanScore: round(mean(numeric)),
      };
    }
  }
}

const reviewRows = runs.filter((item) => !item.judge || item.judge.confidence === "LOW" || ["1", "N/A"].includes(item.judge.score));
const reviewHeader = ["case_id", "system", "run_index", "judge_score", "judge_confidence", "judge_reason", "diagnosis", "raw_result"];
const reviewCsv = [reviewHeader.map(csv).join(","), ...reviewRows.map((item) => [
  item.caseId, item.system, item.runIndex, item.judge?.score ?? "ERROR", item.judge?.confidence ?? "",
  item.judge?.reason ?? "Judge output unavailable", item.diagnosis ?? "", item.rawRef,
].map(csv).join(","))].join("\n") + "\n";

const successfulTrace = runs.find((item) => item.system === "IMPROVED_AGENT" && item.judge?.score === "2" && item.telemetry);
const latestCompletedAt = [1, 2, 3].map((index) => index)
  .map(async (index) => readJson(`evaluation/results/raw/improved-agent-run-${index}.json`));
const improvedReports = await Promise.all(latestCompletedAt);
const summary = {
  schemaVersion: "releaseguard-evaluation-summary-v1",
  generatedAt: new Date().toISOString(),
  evaluationVersion: "0.2.0",
  sourceCommit: "aca76ff977e38df48390da10d622768c61e301b1",
  improvedSourceDiffSha256: (await readFile(filePath("evaluation/config/improved-source-diff.sha256"), "utf8")).trim(),
  dataset: {
    cases: frozen.cases.length,
    runsPerSystem: 3,
    trialsPerSystem: frozen.cases.length * 3,
    hash: frozen.source_dataset.expectedDatasetHash,
    frozenArtifactSha256: sha256(await readFile(filePath("evaluation/dataset/frozen-cases.json"), "utf8")),
    sourceClassDistribution: Object.fromEntries([...new Set(frozen.cases.map((item) => item.source_class))]
      .sort().map((value) => [value, frozen.cases.filter((item) => item.source_class === value).length])),
    incidentTypeDistribution: Object.fromEntries([...new Set(frozen.cases.map((item) => item.incident_type))]
      .sort().map((value) => [value, frozen.cases.filter((item) => item.incident_type === value).length])),
    difficultyDistribution: Object.fromEntries([...new Set(frozen.cases.map((item) => item.difficulty))]
      .sort().map((value) => [value, frozen.cases.filter((item) => item.difficulty === value).length])),
    claimBoundary: "22 governed offline reconstructed cases: 16 synthetic and 6 repository-native. They are not 22 independently sourced public postmortems and are not production enterprise data.",
  },
  model: await readJson("evaluation/config/model.json"),
  scoring: await readJson("evaluation/config/scoring.json"),
  systems,
  slices,
  judge: {
    type: "NON_INDEPENDENT_SAME_MODEL",
    cases: judgeRecords.length,
    failedCases: judgeRecords.filter((item) => item.error).length,
    status: judgeRecords.length > 0 && judgeRecords.every((item) => item.error)
      ? "UNAVAILABLE_ALL_CASES_FAILED"
      : judgeRecords.some((item) => item.error)
        ? "PARTIAL"
        : "COMPLETE",
    scoredOutputs: judgeRecords.reduce((sum, item) => sum + (item.scores?.length ?? 0), 0),
    failureReason: judgeRecords.length > 0 && judgeRecords.every((item) => /\b402\b|Insufficient Balance/i.test(item.error ?? ""))
      ? "PROVIDER_QUOTA_EXHAUSTED_HTTP_402"
      : null,
    reviewQueueRows: reviewRows.length,
    rawResults: "raw/blind-judge.jsonl",
  },
  typicalTrace: successfulTrace ? {
    caseId: successfulTrace.caseId,
    runIndex: successfulTrace.runIndex,
    diagnosis: successfulTrace.diagnosis,
    rootCauseScore: successfulTrace.judge.score,
    actions: (successfulTrace.telemetry.iterations ?? []).map((item) => ({ sequence: item.sequence, decisionType: item.decisionType, rationale: item.publicRationale })),
    tools: (successfulTrace.telemetry.toolCalls ?? []).map((item) => ({ toolName: item.toolName, resultStatus: item.resultStatus, evidenceIds: item.evidenceIds })),
  } : null,
  latestEvaluationCompletedAt: improvedReports.map((report) => report.manifest.completedAt).sort().at(-1),
  limitations: [
    "Small governed Dev set; no holdout split and Wilson intervals remain wide.",
    "Six cases are repository-native and sixteen are synthetic; results cannot be generalized to enterprise production incidents.",
    "Root-cause semantic scores use the same model family as a blind judge and are not independent or human-reviewed.",
    ...(judgeRecords.some((item) => item.error)
      ? [`Blind judging is ${judgeRecords.every((item) => item.error) ? "unavailable" : "partial"}: ${judgeRecords.filter((item) => item.error).length}/${judgeRecords.length} case-level judge requests failed. Root-cause score denominators exclude unavailable judgments.`]
      : []),
    "The deterministic scorer and LLM judge measure different properties; both raw outputs are retained.",
    "Costs are estimates using published token rates and assume input cache misses; they are not invoices.",
  ],
  artifacts: {
    methodology: "docs/evaluation/methodology.md",
    reproduce: "docs/evaluation/reproduce.md",
    report: "docs/evaluation/releaseguard-evaluation-report.md",
    reviewQueue: "evaluation/results/review_queue.csv",
    rawDirectory: "evaluation/results/raw/",
    github: "https://github.com/Eason4real/releaseguard-ai/tree/main/evaluation",
  },
};

await mkdir(filePath("evaluation/results/"), { recursive: true });
await mkdir(filePath("public/evaluation/"), { recursive: true });
const serialized = `${JSON.stringify(summary, null, 2)}\n`;
await writeFile(filePath("evaluation/results/summary.json"), serialized);
await writeFile(filePath("public/evaluation/summary.json"), serialized);
await writeFile(filePath("evaluation/results/review_queue.csv"), reviewCsv);
console.log(JSON.stringify({
  summary: filePath("evaluation/results/summary.json"),
  reviewQueueRows: reviewRows.length,
  systems: systems.map((item) => ({ system: item.system, technical: item.technicalCompletion, strict: item.rootCause.score2Strict })),
}, null, 2));
