import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { callModel } from "../lib/investigation/model.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const probe = JSON.parse(await readFile(resolve(root, "evaluation/results/v8/collector-probe-v3/collector-probe-v3.json"), "utf8"));
const frozen = JSON.parse(await readFile(resolve(root, "evaluation/dataset/frozen-cases.json"), "utf8"));
const byCase = new Map(frozen.cases.map((item) => [item.case_id, item]));
const outputPath = resolve(root, "evaluation/results/v8/collector-probe-v3/judge.jsonl");
const system = "You are a blind incident root-cause evaluator. Score 2 only when core cause, mechanism, and affected object agree with Gold; score 1 when direction/component is right but incomplete; score 0 for mismatch, unsupported attribution, or incorrect abstention; N/A only when evidence is objectively insufficient and abstention is correct. Return exactly JSON with score (2,1,0,N/A), reason, confidence (HIGH,MEDIUM,LOW).";
const parse = (content) => {
  const value = JSON.parse(content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content);
  const score = String(value.score ?? "");
  if (!["0", "1", "2", "N/A"].includes(score) || !String(value.reason ?? "").trim()) throw new Error("INVALID_JUDGE_JSON");
  return { score, reason: String(value.reason).trim(), confidence: String(value.confidence ?? "LOW") };
};
for (const item of probe.cases) {
  const gold = byCase.get(item.caseId);
  if (!gold) throw new Error(`MISSING_GOLD:${item.caseId}`);
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing.split(/\r?\n/).filter(Boolean).some((line) => JSON.parse(line).caseId === item.caseId)) continue;
  const diagnosis = item.normalizedPrediction?.predictedRootCause ?? null;
  const input = { gold_root_cause: gold.gold_root_cause, acceptable_equivalents: gold.acceptable_equivalents, unacceptable_statements: gold.unacceptable_statements, runtime_observations: gold.agent_accessible_observations, anonymous_output: { anonymous_id: `PROBE-${item.caseId}`, diagnosis, cited_evidence_ids: item.normalizedPrediction?.citedEvidenceIds ?? [], technical_status: item.execution.status } };
  let judged = null; let error = null;
  try {
    const response = await callModel({ provider: process.env.LIVE_EVAL_PROVIDER, baseUrl: process.env.LIVE_EVAL_BASE_URL, apiKey: process.env.LIVE_EVAL_API_KEY, model: process.env.LIVE_EVAL_MODEL, requestTimeoutMs: 75000 }, [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }], { enableTools: false, enableThinking: false, requireJsonObject: true });
    judged = parse(response.choices?.[0]?.message?.content ?? "");
  } catch (caught) { error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught); }
  await appendFile(outputPath, `${JSON.stringify({ schemaVersion: "releaseguard-v8-collector-probe-judge-v1", boundary: "JUDGE_ONLY; ANSWER_NOT_VISIBLE_TO_AGENT", caseId: item.caseId, ...judged, error })}\n`);
  console.error(`[${item.caseId}] ${error ?? judged.score}`);
  if (/402|QUOTA|Insufficient Balance/i.test(error ?? "")) break;
}
const rows = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const scorable = rows.filter((item) => !item.error && item.score !== "N/A");
console.log(JSON.stringify({ cases: rows.length, scores: Object.fromEntries(["0", "1", "2", "N/A"].map((score) => [score, rows.filter((item) => item.score === score).length])), errors: rows.filter((item) => item.error).length, strictRate: scorable.length ? rows.filter((item) => item.score === "2").length / scorable.length : 0, lenientRate: scorable.length ? rows.filter((item) => ["1", "2"].includes(item.score)).length / scorable.length : 0 }, null, 2));
