import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { callModel } from "../lib/investigation/model.ts";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const root = resolve(new URL("../", import.meta.url).pathname);
const probePath = resolve(root, "evaluation/results/v7/ablation/synthesis-repair-probe.jsonl");
const outputPath = resolve(root, "evaluation/results/v7/ablation/synthesis-repair-probe.judged-v2.jsonl");
const frozen = JSON.parse(await readFile(resolve(root, "evaluation/dataset/frozen-cases.json"), "utf8"));
const frozenById = new Map(frozen.cases.map((item) => [item.case_id, item]));
const probeAttempts = (await readFile(probePath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effectiveProbeByCase = new Map();
for (const item of probeAttempts) {
  if (!effectiveProbeByCase.has(item.caseId) || !item.error) effectiveProbeByCase.set(item.caseId, item);
}
const probe = [...effectiveProbeByCase.values()];
let existing = [];
try {
  existing = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const completed = new Set(existing.filter((item) => !item.error).map((item) => item.caseId));
const system = [
  "You are a blind incident root-cause evaluator. The output source identity is hidden.",
  "Use only the supplied Gold, acceptable equivalents, and runtime observations.",
  "Score the anonymous output: 2 = core cause, mechanism, and affected object agree with Gold; 1 = correct component or causal direction but incomplete mechanism or a secondary error; 0 = mismatch, symptom-only, unsupported attribution, technical failure, or incorrect abstention; N/A = runtime evidence is objectively insufficient and the output correctly abstains.",
  "Do not reward verbosity or infer evidence not present. Return exactly one JSON object: {score:'0'|'1'|'2'|'N/A',reason:string,confidence:'HIGH'|'MEDIUM'|'LOW'} and no prose.",
].join(" ");

function parse(content) {
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
    } catch { /* try fenced representation */ }
  }
  throw new Error("PROBE_JUDGE_JSON_INVALID");
}

for (const record of probe) {
  if (completed.has(record.caseId)) continue;
  const source = frozenById.get(record.caseId);
  if (!source) throw new Error(`PROBE_JUDGE_CASE_UNKNOWN:${record.caseId}`);
  const claims = record.decision?.type === "FINALIZE" ? record.decision.diagnosis.claims : [];
  const diagnosis = record.decision?.type === "FINALIZE"
    ? claims.find((item) => item.type === "ROOT_CAUSE")?.statement
      ?? record.decision.diagnosis.summary
    : record.decision?.type === "STOP_INCONCLUSIVE"
      ? `Insufficient evidence: ${record.decision.reason}`
      : null;
  const citedEvidenceIds = [...new Set(claims.flatMap((item) => item.evidenceIds ?? []))];
  const anonymousId = `PROBE-${createHash("sha256").update(record.caseId).digest("hex").slice(0, 10).toUpperCase()}`;
  const input = {
    case_id: record.caseId,
    gold_root_cause: source.gold_root_cause,
    acceptable_equivalents: source.acceptable_equivalents,
    unacceptable_statements: source.unacceptable_statements,
    critical_evidence_ids: source.critical_evidence_ids,
    runtime_observations: source.agent_accessible_observations,
    anonymous_output: {
      anonymous_id: anonymousId,
      diagnosis,
      cited_evidence_ids: citedEvidenceIds,
      technical_status: record.error ? "FAILED" : "PASS",
    },
  };
  let judged = null;
  let error = null;
  const rawResponses = [];
  try {
    const config = {
      provider: required("LIVE_EVAL_PROVIDER"),
      baseUrl: required("LIVE_EVAL_BASE_URL"),
      apiKey: required("LIVE_EVAL_API_KEY"),
      model: required("LIVE_EVAL_MODEL"),
      requestTimeoutMs: 75_000,
    };
    const first = await callModel(config, [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(input) },
    ], { enableTools: false, enableThinking: false, requireJsonObject: true });
    rawResponses.push(first.choices?.[0]?.message?.content ?? "");
    try {
      judged = parse(rawResponses[0]);
    } catch {
      const repaired = await callModel(config, [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(input) },
        { role: "assistant", content: rawResponses[0] },
        { role: "user", content: "Repair the previous response to the exact required JSON schema." },
      ], { enableTools: false, enableThinking: false, requireJsonObject: true });
      rawResponses.push(repaired.choices?.[0]?.message?.content ?? "");
      judged = parse(rawResponses[1]);
    }
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }
  const output = {
    schemaVersion: "releaseguard-v7-probe-blind-judge-v1",
    boundary: "JUDGE_ONLY; GOLD_NOT_VISIBLE_TO_SYNTHESIZER",
    caseId: record.caseId,
    anonymousId,
    ...judged,
    error,
    attempts: rawResponses.length,
  };
  await appendFile(outputPath, `${JSON.stringify(output)}\n`);
  console.error(`[${record.caseId}] ${error ?? judged.score}`);
  if (/PROVIDER_QUOTA_EXHAUSTED|\b402\b|Insufficient Balance/i.test(error ?? "")) break;
}
const attempts = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effectiveByCase = new Map();
for (const item of attempts) {
  if (!effectiveByCase.has(item.caseId) || !item.error) effectiveByCase.set(item.caseId, item);
}
const records = [...effectiveByCase.values()];
console.log(JSON.stringify({
  output: outputPath,
  cases: records.length,
  scores: Object.fromEntries(["0", "1", "2", "N/A"].map((score) =>
    [score, records.filter((item) => item.score === score).length])),
  errors: records.filter((item) => item.error).length,
  totalAttempts: attempts.length,
  retainedFailedAttempts: attempts.filter((item) => item.error).length,
}, null, 2));
