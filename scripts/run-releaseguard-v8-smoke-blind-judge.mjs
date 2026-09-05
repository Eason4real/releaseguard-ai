import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callModel } from "../lib/investigation/model.ts";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = resolve(root, "evaluation/results/v8/smoke");
const seriesId = process.env.V8_SMOKE_SERIES?.trim() || "contract-v2";
if (!/^[a-z0-9-]+$/.test(seriesId)) throw new Error("V8_SMOKE_SERIES_INVALID");
const attemptsPath = resolve(smokeRoot, `raw/synthesis-attempts-${seriesId}.jsonl`);
const outputPath = resolve(smokeRoot, `judge-${seriesId}.jsonl`);
const manifest = JSON.parse(await readFile(resolve(smokeRoot, "input/evaluator-manifest.json"), "utf8"));
const caseIdBySample = new Map(manifest.samples.map((item) => [item.sampleId, item.caseId]));
const frozen = JSON.parse(await readFile(resolve(root, "evaluation/dataset/frozen-cases.json"), "utf8"));
const frozenByCase = new Map(frozen.cases.map((item) => [item.case_id, item]));
const attempts = (await readFile(attemptsPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effective = new Map();
for (const item of attempts) {
  if (!effective.has(item.sampleId) || !item.error) effective.set(item.sampleId, item);
}
if (effective.size !== 17) throw new Error(`V8_SMOKE_JUDGE_COVERAGE_INVALID:${effective.size}`);
let existing = [];
try {
  existing = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const completed = new Set(existing.filter((item) => !item.error).map((item) => item.sampleId));
const system = [
  "You are a blind incident root-cause evaluator. System identity is hidden.",
  "Use only the supplied Gold, acceptable equivalents, governed runtime observations, and anonymous output.",
  "Score 2 when core cause, mechanism, and affected object agree with Gold; 1 when causal direction or component is correct but mechanism or affected object is incomplete; 0 for mismatch, symptom-only output, unsupported attribution, technical failure, or incorrect abstention; N/A only when runtime evidence is objectively insufficient and the output correctly abstains.",
  "Do not reward verbosity or infer evidence not present.",
  "Return exactly one JSON object with keys score, reason, confidence. score must be 0, 1, 2, or N/A; confidence must be HIGH, MEDIUM, or LOW. Return no Markdown or prose outside the JSON object.",
].join(" ");

const parse = (content) => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [content, fenced].filter(Boolean)) {
    try {
      const value = JSON.parse(candidate);
      const score = String(value.score ?? "");
      const confidence = String(value.confidence ?? "");
      if (!["0", "1", "2", "N/A"].includes(score)
        || !["HIGH", "MEDIUM", "LOW"].includes(confidence)
        || !String(value.reason ?? "").trim()) continue;
      return { score, reason: String(value.reason).trim(), confidence };
    } catch { /* try the fenced representation */ }
  }
  throw new Error("V8_SMOKE_JUDGE_JSON_INVALID");
};

for (const record of effective.values()) {
  if (completed.has(record.sampleId)) continue;
  const caseId = caseIdBySample.get(record.sampleId);
  const source = frozenByCase.get(caseId);
  if (!caseId || !source) throw new Error(`V8_SMOKE_JUDGE_MAPPING_MISSING:${record.sampleId}`);
  const claims = record.decision?.type === "FINALIZE" ? record.decision.diagnosis.claims : [];
  const diagnosis = record.decision?.type === "FINALIZE"
    ? claims.find((item) => item.type === "ROOT_CAUSE")?.statement
      ?? record.decision.diagnosis.summary
    : record.decision?.type === "STOP_INCONCLUSIVE"
      ? `Insufficient evidence: ${record.decision.reason}`
      : null;
  const citedEvidenceIds = [...new Set(claims.flatMap((item) => item.evidenceIds ?? []))];
  const input = {
    gold_root_cause: source.gold_root_cause,
    acceptable_equivalents: source.acceptable_equivalents,
    unacceptable_statements: source.unacceptable_statements,
    critical_evidence_ids: source.critical_evidence_ids,
    runtime_observations: source.agent_accessible_observations,
    anonymous_output: {
      anonymous_id: record.sampleId,
      diagnosis,
      cited_evidence_ids: citedEvidenceIds,
      technical_status: record.error ? "FAILED" : "PASS",
    },
  };
  let judged = null;
  let error = null;
  const publicResponses = [];
  try {
    const config = {
      provider: required("LIVE_EVAL_PROVIDER"),
      baseUrl: required("LIVE_EVAL_BASE_URL"),
      apiKey: required("LIVE_EVAL_API_KEY"),
      model: required("LIVE_EVAL_MODEL"),
      requestTimeoutMs: 75_000,
    };
    for (let judgeAttempt = 0; judgeAttempt < 2 && !judged; judgeAttempt += 1) {
      const messages = [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(input) },
        ...(judgeAttempt === 1 ? [
          { role: "assistant", content: publicResponses[0] },
          { role: "user", content: "Repair the previous response to the exact required JSON object." },
        ] : []),
      ];
      const response = await callModel(config, messages, {
        enableTools: false,
        enableThinking: false,
        requireJsonObject: true,
      });
      const content = response.choices?.[0]?.message?.content ?? "";
      publicResponses.push(content.slice(0, 20_000));
      try { judged = parse(content); } catch (caught) {
        if (judgeAttempt === 1) throw caught;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }
  const output = {
    schemaVersion: "releaseguard-v8-smoke-blind-judge-v1",
    boundary: "JUDGE_ONLY; ANSWER_NOT_VISIBLE_TO_SYNTHESIZER; SYSTEM_IDENTITY_HIDDEN",
    seriesId,
    sampleId: record.sampleId,
    caseId,
    ...judged,
    error,
    attempts: publicResponses.length,
    publicResponses,
  };
  await appendFile(outputPath, `${JSON.stringify(output)}\n`);
  console.error(`[${record.sampleId}] ${error ?? judged.score}`);
  if (/PROVIDER_QUOTA_EXHAUSTED|\b402\b|Insufficient Balance/i.test(error ?? "")) break;
}

const allAttempts = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effectiveJudgments = new Map();
for (const item of allAttempts) {
  if (!effectiveJudgments.has(item.sampleId) || !item.error) {
    effectiveJudgments.set(item.sampleId, item);
  }
}
const records = [...effectiveJudgments.values()];
const scorable = records.filter((item) => item.score !== "N/A" && !item.error);
console.log(JSON.stringify({
  output: outputPath,
  cases: records.length,
  scores: Object.fromEntries(["0", "1", "2", "N/A"].map((score) =>
    [score, records.filter((item) => item.score === score).length])),
  errors: records.filter((item) => item.error).length,
  strictRate: scorable.length ? scorable.filter((item) => item.score === "2").length / scorable.length : 0,
  lenientRate: scorable.length ? scorable.filter((item) => ["1", "2"].includes(item.score)).length / scorable.length : 0,
  scorable: scorable.length,
  totalAttempts: allAttempts.length,
}, null, 2));
