import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LLMInvestigationSynthesizer } from "../lib/investigation/llm-synthesizer.ts";
import { buildEvidencePacket, evaluateEvidenceReadiness } from "../lib/investigation/staged-planner.ts";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const root = resolve(new URL("../", import.meta.url).pathname);
const resultsRoot = resolve(root, "evaluation/results/v7");
const outputDirectory = resolve(resultsRoot, "ablation");
const outputPath = resolve(outputDirectory, "synthesis-repair-probe.jsonl");
await mkdir(outputDirectory, { recursive: true });

const ablation = JSON.parse(await readFile(resolve(resultsRoot, "ablation.json"), "utf8"));
const sourceReports = new Map();
for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
  const report = JSON.parse(await readFile(
    resolve(resultsRoot, `raw/harness-v7-run-${runIndex}.json`), "utf8"));
  for (const item of report.cases) sourceReports.set(`${runIndex}:${item.caseId}`, item);
}
const candidates = [];
const selectedCaseIds = new Set();
for (const item of ablation.cases
  .filter((entry) => entry.bottleneck === "SYNTHESIZER_FAILURE_OR_VALIDATION")
  .sort((left, right) => left.caseId.localeCompare(right.caseId) || left.runIndex - right.runIndex)) {
  if (selectedCaseIds.has(item.caseId)) continue;
  selectedCaseIds.add(item.caseId);
  candidates.push(item);
}

let existing = [];
try {
  existing = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const completed = new Set(existing.filter((item) => !item.error)
  .map((item) => `${item.runIndex}:${item.caseId}`));

function reconstructAggregate(source, runIndex) {
  const telemetry = source.telemetry ?? {};
  const runId = `V7-ABLATION-R${runIndex}-${source.caseId}`;
  const hypotheses = (telemetry.competingHypothesisState ?? []).map((item, index) => ({
    id: item.hypothesisId,
    runId,
    revision: item.revision ?? 1,
    statement: item.statement,
    supportIf: "Persisted v7 trajectory support condition.",
    refuteIf: "Persisted v7 trajectory refutation condition.",
    status: item.status,
    confidence: item.confidence,
    supportScore: item.supportScore ?? 0,
    contradictionScore: item.contradictionScore ?? 0,
    confidenceReason: "Reconstructed from frozen v7 telemetry.",
    createdBy: "AGENT",
    createdAt: `2026-09-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-09-02T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const evidence = (telemetry.evidencePersistenceEvents ?? []).map((item, index) => ({
    id: item.evidenceId,
    runId,
    toolResultId: item.toolCallId ?? `TR-${index + 1}`,
    category: item.category,
    statement: item.statement,
    source: item.source,
    strength: item.strength,
    provenance: item.provenance,
    collectedAt: `2026-09-02T00:01:${String(index).padStart(2, "0")}.000Z`,
  }));
  const hypothesisEvidenceLinks = (telemetry.evidenceAssessments ?? []).map((item, index) => ({
    id: `LINK-${index + 1}`,
    runId,
    hypothesisId: item.hypothesisId,
    evidenceId: item.evidenceId,
    relation: item.relation,
    explanation: item.explanation,
    linkedBy: "AGENT",
    createdAt: `2026-09-02T00:02:${String(index).padStart(2, "0")}.000Z`,
  }));
  return {
    run: {
      id: runId,
      incidentId: `INC-${source.caseId}`,
      riskEventId: null,
      releaseId: null,
      question: "Determine the most evidence-supported explanation for the observed release risk.",
      provider: "offline-ablation",
      model: process.env.LIVE_EVAL_MODEL,
      plannerType: "LLM",
      status: "RUNNING",
      currentIteration: 1,
      activeIterationId: null,
      lockVersion: 0,
      modelCallCount: 0,
      maxModelCalls: 2,
      stopReason: null,
      currentDiagnosisRevision: 0,
      totalTokens: 0,
      errorMessage: null,
      startedAt: "2026-09-02T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
    release: null,
    riskEvent: null,
    hypotheses,
    evidence,
    hypothesisEvidenceLinks,
    toolCalls: [],
    iterations: [],
    traceEvents: [],
    auditEvents: [],
    evidenceRelations: [],
    diagnosis: null,
    diagnosisClaims: [],
    diagnosisClaimEvidenceLinks: [],
  };
}

for (const candidate of candidates) {
  const key = `${candidate.runIndex}:${candidate.caseId}`;
  if (completed.has(key)) continue;
  const source = sourceReports.get(key);
  if (!source) throw new Error(`V7_PROBE_SOURCE_MISSING:${key}`);
  const aggregate = reconstructAggregate(source, candidate.runIndex);
  const readiness = evaluateEvidenceReadiness(aggregate, 0);
  let ordinal = 0;
  const synthesizer = new LLMInvestigationSynthesizer({
    provider: required("LIVE_EVAL_PROVIDER"),
    baseUrl: required("LIVE_EVAL_BASE_URL"),
    apiKey: required("LIVE_EVAL_API_KEY"),
    model: required("LIVE_EVAL_MODEL"),
    requestTimeoutMs: 75_000,
  });
  let record;
  try {
    const decision = await synthesizer.synthesize({
      aggregate,
      trigger: "INITIAL",
      humanMessage: null,
      remainingIterations: 2,
      remainingToolCalls: 0,
      evidencePacket: buildEvidencePacket(aggregate, readiness),
      readiness,
      modelCallBudget: {
        async reserve() {
          if (ordinal >= 2) return { reserved: false, modelCallCount: ordinal, maxModelCalls: 2 };
          ordinal += 1;
          return { reserved: true, reservation: {
            id: `PROBE-${candidate.caseId}-${ordinal}`,
            ordinal,
            maxModelCalls: 2,
            reservedAt: new Date().toISOString(),
          } };
        },
      },
    });
    record = {
      schemaVersion: "releaseguard-v7-synthesis-repair-probe-v1",
      mode: "FROZEN_EVIDENCE_PACKET_NO_TOOLS_NO_GOLD",
      runIndex: candidate.runIndex,
      caseId: candidate.caseId,
      readiness,
      decision,
      modelCalls: synthesizer.drainModelCallObservations(),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    record = {
      schemaVersion: "releaseguard-v7-synthesis-repair-probe-v1",
      mode: "FROZEN_EVIDENCE_PACKET_NO_TOOLS_NO_GOLD",
      runIndex: candidate.runIndex,
      caseId: candidate.caseId,
      readiness,
      decision: null,
      modelCalls: synthesizer.drainModelCallObservations(),
      error: message.slice(0, 1000),
    };
  }
  await appendFile(outputPath, `${JSON.stringify(record)}\n`);
  console.error(`[${candidate.caseId}] ${record.error ?? record.decision?.type}`);
  if (/PROVIDER_QUOTA_EXHAUSTED|\b402\b|Insufficient Balance/i.test(record.error ?? "")) break;
}

const attempts = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effectiveByCase = new Map();
for (const item of attempts) {
  const key = `${item.runIndex}:${item.caseId}`;
  if (!effectiveByCase.has(key) || !item.error) effectiveByCase.set(key, item);
}
const records = [...effectiveByCase.values()];
console.log(JSON.stringify({
  output: outputPath,
  candidateCases: candidates.length,
  completedCases: records.length,
  finalized: records.filter((item) => item.decision?.type === "FINALIZE").length,
  inconclusive: records.filter((item) => item.decision?.type === "STOP_INCONCLUSIVE").length,
  errors: records.filter((item) => item.error).length,
  modelCalls: records.reduce((total, item) => total + item.modelCalls.length, 0),
  totalAttempts: attempts.length,
  retainedFailedAttempts: attempts.filter((item) => item.error).length,
}, null, 2));
