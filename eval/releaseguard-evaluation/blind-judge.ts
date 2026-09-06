import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { callModel, type ModelResponseObservation } from "../../lib/investigation/model";

type HarnessPredictionSet = "HARNESS_V2" | "HARNESS_V3" | "HARNESS_V4" | "HARNESS_V7";
type PredictionSet = "V1" | HarnessPredictionSet | "PORTFOLIO_FINAL";

type Prediction = {
  system: "DIRECT_LLM" | "CURRENT_AGENT" | "IMPROVED_AGENT" | HarnessPredictionSet
    | "PORTFOLIO_FINAL";
  runIndex: number;
  caseId: string;
  diagnosis: string | null;
  evidenceIds: string[];
  technicalStatus: string;
};

type JudgeScore = "0" | "1" | "2" | "N/A";

type JudgedOutput = {
  anonymous_id: string;
  score: JudgeScore;
  reason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function stableAnonymousId(caseId: string, system: string, runIndex: number, judgeVersion: string) {
  return `OUT-${sha256(`${caseId}|${system}|${runIndex}|${judgeVersion}`).slice(0, 10).toUpperCase()}`;
}

function deterministicShuffle<T>(items: T[], seed: string) {
  return [...items].sort((left, right) => {
    const leftHash = sha256(`${seed}|${JSON.stringify(left)}`);
    const rightHash = sha256(`${seed}|${JSON.stringify(right)}`);
    return leftHash.localeCompare(rightHash);
  });
}

function parseJudgeResponse(content: string, expectedIds: string[]) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  let parsed: unknown;
  for (const candidate of [content, fenced].filter(Boolean) as string[]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch { /* try the next representation */ }
  }
  if (!parsed || typeof parsed !== "object") throw new Error("JUDGE_JSON_INVALID");
  const scores = (parsed as { scores?: unknown }).scores;
  if (!Array.isArray(scores)) throw new Error("JUDGE_SCORES_MISSING");
  const normalized = scores.map((item) => {
    if (!item || typeof item !== "object") throw new Error("JUDGE_SCORE_INVALID");
    const value = item as Record<string, unknown>;
    const score = String(value.score ?? "") as JudgeScore;
    const confidence = String(value.confidence ?? "");
    const anonymousId = String(value.anonymous_id ?? "");
    if (!expectedIds.includes(anonymousId)
      || !["0", "1", "2", "N/A"].includes(score)
      || !["HIGH", "MEDIUM", "LOW"].includes(confidence)
      || !String(value.reason ?? "").trim()) {
      throw new Error("JUDGE_SCORE_SCHEMA_INVALID");
    }
    return {
      anonymous_id: anonymousId,
      score,
      reason: String(value.reason).trim(),
      confidence: confidence as JudgedOutput["confidence"],
    } satisfies JudgedOutput;
  });
  if (new Set(normalized.map((item) => item.anonymous_id)).size !== expectedIds.length
    || normalized.length !== expectedIds.length) throw new Error("JUDGE_OUTPUT_COVERAGE_INVALID");
  return normalized;
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export async function loadPredictions(
  root: string,
  predictionSet: PredictionSet,
  reportPath?: string,
): Promise<Prediction[]> {
  const predictions: Prediction[] = [];
  if (predictionSet === "PORTFOLIO_FINAL") {
    if (!reportPath) throw new Error("PORTFOLIO_FINAL_REPORT_PATH_REQUIRED");
    const report = await readJson(reportPath);
    if (report.schemaVersion !== "investigation-live-benchmark-report-v1"
      || report.reportStatus !== "COMPLETE") {
      throw new Error("PORTFOLIO_FINAL_REPORT_INVALID");
    }
    const manifest = report.manifest as Record<string, unknown> | undefined;
    const cases = report.cases;
    if (!Array.isArray(cases)
      || cases.length !== 22
      || manifest?.totalCases !== 22
      || manifest?.processedCases !== 22) {
      throw new Error("PORTFOLIO_FINAL_REPORT_COVERAGE_INVALID");
    }
    for (const item of cases as Array<Record<string, unknown>>) {
      const execution = (item.execution ?? {}) as Record<string, unknown>;
      const normalized = (item.normalizedPrediction ?? {}) as Record<string, unknown>;
      const technicalStatus = String(execution.status ?? "FAILED");
      const passed = technicalStatus === "PASS";
      predictions.push({
        system: "PORTFOLIO_FINAL",
        runIndex: 1,
        caseId: String(item.caseId),
        diagnosis: passed && normalized.predictedRootCause
          ? String(normalized.predictedRootCause)
          : null,
        evidenceIds: passed && Array.isArray(normalized.citedEvidenceIds)
          ? normalized.citedEvidenceIds.map(String)
          : [],
        technicalStatus,
      });
    }
    if (new Set(predictions.map((item) => item.caseId)).size !== 22
      || predictions.some((item) => !/^CASE-\d+$/.test(item.caseId))) {
      throw new Error("PORTFOLIO_FINAL_REPORT_CASE_IDS_INVALID");
    }
    return predictions;
  }
  if (predictionSet !== "V1") {
    const version = predictionSet.toLowerCase().replace("harness_", "");
    const system = predictionSet;
    for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
      const report = await readJson(
        `${root}/evaluation/results/${version}/raw/harness-${version}-run-${runIndex}.json`,
      );
      for (const item of report.cases as Array<Record<string, unknown>>) {
        const execution = item.execution as Record<string, unknown>;
        const normalized = (item.normalizedPrediction ?? {}) as Record<string, unknown>;
        predictions.push({
          system,
          runIndex,
          caseId: String(item.caseId),
          diagnosis: normalized.predictedRootCause ? String(normalized.predictedRootCause) : null,
          evidenceIds: Array.isArray(normalized.citedEvidenceIds) ? normalized.citedEvidenceIds.map(String) : [],
          technicalStatus: String(execution.status ?? "FAILED"),
        });
      }
    }
    return predictions;
  }
  for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
    const directText = await readFile(`${root}/evaluation/results/raw/direct-llm-run-${runIndex}.jsonl`, "utf8");
    for (const line of directText.split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line) as Record<string, unknown>;
      predictions.push({
        system: "DIRECT_LLM",
        runIndex,
        caseId: String(record.case_id),
        diagnosis: record.final_diagnosis ? String(record.final_diagnosis) : null,
        evidenceIds: Array.isArray(record.evidence) ? record.evidence.map(String) : [],
        technicalStatus: record.error ? "FAILED" : "PASS",
      });
    }
    for (const [system, prefix] of [["CURRENT_AGENT", "current-agent"], ["IMPROVED_AGENT", "improved-agent"]] as const) {
      const report = await readJson(`${root}/evaluation/results/raw/${prefix}-run-${runIndex}.json`);
      for (const item of report.cases as Array<Record<string, unknown>>) {
        const execution = item.execution as Record<string, unknown>;
        const normalized = (item.normalizedPrediction ?? {}) as Record<string, unknown>;
        predictions.push({
          system,
          runIndex,
          caseId: String(item.caseId),
          diagnosis: normalized.predictedRootCause ? String(normalized.predictedRootCause) : null,
          evidenceIds: Array.isArray(normalized.citedEvidenceIds) ? normalized.citedEvidenceIds.map(String) : [],
          technicalStatus: String(execution.status ?? "FAILED"),
        });
      }
    }
  }
  return predictions;
}

export async function runBlindJudge(config: {
  root: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  predictionSet?: PredictionSet;
  reportPath?: string;
  judgeVersion?: string;
  skipCaseIds?: string[];
  onCase?: (record: Record<string, unknown>) => Promise<void> | void;
}) {
  const frozen = await readJson(`${config.root}/evaluation/dataset/frozen-cases.json`);
  const predictionSet = config.predictionSet ?? "V1";
  const judgeVersion = config.judgeVersion ?? "releaseguard-blind-v1";
  const predictions = await loadPredictions(config.root, predictionSet, config.reportPath);
  const outputsPerCase = predictionSet === "V1"
    ? 9
    : predictionSet === "PORTFOLIO_FINAL"
      ? 1
      : 3;
  const skipped = new Set(config.skipCaseIds ?? []);
  const records: Record<string, unknown>[] = [];
  for (const frozenCase of frozen.cases as Array<Record<string, unknown>>) {
    const caseId = String(frozenCase.case_id);
    if (skipped.has(caseId)) continue;
    const casePredictions = predictions.filter((item) => item.caseId === caseId);
    if (casePredictions.length !== outputsPerCase) {
      throw new Error(`JUDGE_EXPECTED_${outputsPerCase}_OUTPUTS:${caseId}`);
    }
    const identityMap = new Map<string, Prediction>();
    const anonymousOutputs = deterministicShuffle(casePredictions.map((item) => {
      const anonymousId = stableAnonymousId(caseId, item.system, item.runIndex, judgeVersion);
      identityMap.set(anonymousId, item);
      return {
        anonymous_id: anonymousId,
        diagnosis: item.diagnosis,
        cited_evidence_ids: item.evidenceIds,
        technical_status: item.technicalStatus,
      };
    }), caseId);
    const judgeInput = {
      case_id: caseId,
      gold_root_cause: frozenCase.gold_root_cause,
      acceptable_equivalents: frozenCase.acceptable_equivalents,
      unacceptable_statements: frozenCase.unacceptable_statements,
      critical_evidence_ids: frozenCase.critical_evidence_ids,
      runtime_observations: frozenCase.agent_accessible_observations,
      anonymous_outputs: anonymousOutputs,
    };
    const observations: ModelResponseObservation[] = [];
    const started = performance.now();
    const rawResponses: string[] = [];
    let scores: JudgedOutput[] = [];
    let error: string | null = null;
    try {
      const modelConfig = {
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        requestTimeoutMs: 75_000,
        responseObserver(value: ModelResponseObservation) { observations.push(value); },
      };
      const systemMessage = {
        role: "system",
        content: [
          "You are a blind incident root-cause evaluator. System identities are hidden.",
          "Use only the supplied Gold, acceptable equivalents, and runtime observations.",
          "Score each anonymous output independently: 2 = core cause, mechanism, and affected object agree with Gold; 1 = correct component or causal direction but incomplete mechanism or a secondary error; 0 = mismatch, symptom-only, unsupported attribution, technical failure, or incorrect abstention; N/A = the runtime evidence is objectively insufficient and the output correctly abstains.",
          "Do not reward verbosity. Do not infer evidence not present. Treat missing diagnosis as 0.",
          "Return exactly one JSON object: {scores:[{anonymous_id:string,score:'0'|'1'|'2'|'N/A',reason:string,confidence:'HIGH'|'MEDIUM'|'LOW'}]}. Include every anonymous_id exactly once and no prose.",
        ].join(" "),
      } as const;
      const response = await callModel(modelConfig, [systemMessage, { role: "user", content: JSON.stringify(judgeInput) }], {
        enableTools: false,
        requireJsonObject: true,
      });
      rawResponses.push(response.choices?.[0]?.message?.content ?? "");
      try {
        scores = parseJudgeResponse(rawResponses[0], anonymousOutputs.map((item) => item.anonymous_id));
      } catch (initialError) {
        const repair = await callModel(modelConfig, [systemMessage, {
          role: "user",
          content: JSON.stringify({
            task: "Repair the prior judge output to the exact schema. Preserve the intended scores where possible; include every expected ID once.",
            expected_anonymous_ids: anonymousOutputs.map((item) => item.anonymous_id),
            invalid_response: rawResponses[0],
            validation_error: initialError instanceof Error ? initialError.message : "JUDGE_INVALID",
          }),
        }], { enableTools: false, requireJsonObject: true });
        rawResponses.push(repair.choices?.[0]?.message?.content ?? "");
        scores = parseJudgeResponse(rawResponses[1], anonymousOutputs.map((item) => item.anonymous_id));
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "JUDGE_FAILED";
    }
    const record = {
      schema_version: `${judgeVersion}-result-v1`,
      case_id: caseId,
      judge_type: "NON_INDEPENDENT_SAME_MODEL",
      judge_model: { provider: config.provider, model: config.model, temperature: 0.1 },
      prompt_version: "releaseguard-root-cause-judge-v1",
      prompt_hash: sha256("releaseguard-root-cause-judge-v1"),
      input: judgeInput,
      scores: scores.map((score) => ({ ...score, ...identityMap.get(score.anonymous_id) })),
      raw_responses: rawResponses,
      repair_count: Math.max(0, rawResponses.length - 1),
      token_usage: observations.map((item) => item.usage),
      duration_ms: performance.now() - started,
      error,
    };
    records.push(record);
    await config.onCase?.(record);
  }
  return records;
}

export function summarizeBlindJudgeRecords(records: Array<Record<string, unknown>>) {
  const judged = records.flatMap((record) => Array.isArray(record.scores)
    ? (record.scores as Array<Record<string, unknown>>)
    : []);
  const scores = Object.fromEntries(["0", "1", "2", "N/A"].map((score) => [
    score,
    judged.filter((item) => String(item.score) === score).length,
  ]));
  const scorable = judged.filter((item) => ["0", "1", "2"].includes(String(item.score)));
  const strict = scorable.filter((item) => String(item.score) === "2").length;
  const lenient = scorable.filter((item) => ["1", "2"].includes(String(item.score))).length;
  return {
    cases: records.length,
    scores,
    errors: records.filter((record) => Boolean(record.error)).length,
    strict,
    lenient,
    scorable: scorable.length,
    strictRate: scorable.length ? strict / scorable.length : 0,
    lenientRate: scorable.length ? lenient / scorable.length : 0,
  };
}
