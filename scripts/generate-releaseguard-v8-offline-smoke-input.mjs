import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const FORBIDDEN_AGENT_KEYS = /^(?:gold(?:_|$)|goldRootCause|criticalEvidence|critical_evidence|acceptableEquivalent|acceptable_equivalent|unacceptableStatement|unacceptable_statement|scoring|score|difficulty|difficulty_score|caseId|case_id|reviewStatus|review_status|publicGold|public_gold)/i;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);

export function assertAgentPlaneSafe(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAgentPlaneSafe(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_AGENT_KEYS.test(key)) throw new Error(`V8_AGENT_INPUT_FORBIDDEN_KEY:${path}.${key}`);
    assertAgentPlaneSafe(child, `${path}.${key}`);
  }
}

const emptyAggregateCollections = {
  diagnoses: [],
  proposedAction: null,
  proposedActions: [],
  approval: null,
  approvals: [],
  auditEvents: [],
  iterations: [],
  traceEvents: [],
  messages: [],
  diagnosis: null,
  diagnosisClaims: [],
  diagnosisClaimEvidenceLinks: [],
  diagnosisEvidenceLinks: [],
  approvalSnapshots: [],
  actionCompletions: [],
  verificationRuns: [],
  verificationPolicySnapshots: [],
  verificationEvidence: [],
  verificationEvaluations: [],
};

function buildAggregate({ source, governedCase, sampleId }) {
  const telemetry = source.telemetry ?? {};
  const observations = new Map((governedCase.agent_accessible_observations ?? [])
    .map((item) => [item.evidenceId, item]));
  const events = telemetry.evidencePersistenceEvents ?? [];
  const eventByEvidenceId = new Map(events.map((item) => [item.evidenceId, item]));
  const runId = `V8-SMOKE-${sampleId}`;
  const createdAt = "2026-09-04T00:00:00.000Z";
  const toolCalls = (telemetry.toolTrajectory ?? []).map((trajectory, index) => {
    const evidenceIds = trajectory.evidenceIds ?? [];
    const matched = evidenceIds.map((id) => observations.get(id)).filter(Boolean);
    if (trajectory.resultStatus === "SUCCESS" && matched.length === 0) {
      throw new Error(`V8_OBSERVATION_MISSING:${sampleId}:${trajectory.toolCallId}`);
    }
    if (matched.some((item) => item.toolName !== trajectory.toolName)) {
      throw new Error(`V8_TOOL_OBSERVATION_MISMATCH:${sampleId}:${trajectory.toolCallId}`);
    }
    const resultId = `V8-RESULT-${sampleId}-${String(index + 1).padStart(3, "0")}`;
    const output = matched.length === 1
      ? clone(matched[0].payload)
      : matched.length > 1
        ? { observations: matched.map((item) => clone(item.payload)) }
        : null;
    return {
      id: trajectory.toolCallId,
      runId,
      name: trajectory.toolName,
      arguments: clone(trajectory.arguments ?? {}),
      canonicalSignature: `${trajectory.toolName}:${sha256(JSON.stringify(trajectory.arguments ?? {}))}`,
      status: trajectory.status === "COMPLETED" ? "COMPLETED" : trajectory.status,
      proposedActionId: null,
      approvalId: null,
      agentIterationId: null,
      triggerMessageId: null,
      cacheSourceToolCallId: null,
      iteration: trajectory.iteration ?? index + 1,
      order: trajectory.order ?? index + 1,
      resultId,
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
      result: {
        id: resultId,
        runId,
        toolCallId: trajectory.toolCallId,
        status: trajectory.resultStatus,
        output,
        errorMessage: trajectory.error ?? null,
        retryable: false,
        createdAt,
      },
    };
  });
  const resultIdByCallId = new Map(toolCalls.map((call) => [call.id, call.resultId]));
  const evidence = events.map((item, index) => {
    const toolResultId = resultIdByCallId.get(item.toolCallId);
    if (!toolResultId || !observations.has(item.evidenceId)) {
      throw new Error(`V8_EVIDENCE_BINDING_MISSING:${sampleId}:${item.evidenceId}`);
    }
    return {
      id: item.evidenceId,
      runId,
      toolResultId,
      category: item.category,
      statement: item.statement,
      source: item.source,
      strength: item.strength,
      provenance: item.provenance,
      collectedAt: `2026-09-04T00:01:${String(index).padStart(2, "0")}.000Z`,
    };
  });
  const hypotheses = (telemetry.competingHypothesisState ?? []).map((item, index) => ({
    id: item.hypothesisId,
    runId,
    revision: item.revision ?? 1,
    statement: item.statement,
    supportIf: "Current persisted evidence supports this mechanism and affected scope.",
    refuteIf: "Current persisted evidence contradicts this mechanism or supports a competitor.",
    status: item.status,
    confidence: item.confidence,
    supportScore: item.supportScore ?? 0,
    contradictionScore: item.contradictionScore ?? 0,
    confidenceReason: "Reconstructed from the frozen v7 public trajectory.",
    createdBy: "AGENT",
    createdAt: `2026-09-04T00:02:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-09-04T00:02:${String(index).padStart(2, "0")}.000Z`,
  }));
  const hypothesisEvidenceLinks = (telemetry.evidenceAssessments ?? []).map((item, index) => {
    if (!eventByEvidenceId.has(item.evidenceId)) {
      throw new Error(`V8_ASSESSMENT_EVIDENCE_MISSING:${sampleId}:${item.evidenceId}`);
    }
    return {
      id: `V8-LINK-${sampleId}-${String(index + 1).padStart(3, "0")}`,
      runId,
      hypothesisId: item.hypothesisId,
      evidenceId: item.evidenceId,
      relation: item.relation,
      explanation: item.explanation,
      linkedBy: "AGENT",
      createdAt: `2026-09-04T00:03:${String(index).padStart(2, "0")}.000Z`,
    };
  });
  const anomaly = governedCase.initial_anomaly;
  return {
    run: {
      id: runId,
      incidentId: `INCIDENT-${sampleId}`,
      riskEventId: anomaly.riskEvent?.id ?? null,
      releaseId: anomaly.release?.id ?? null,
      question: anomaly.question,
      provider: "offline-smoke",
      model: "configured-at-runtime",
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
      startedAt: createdAt,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
    },
    release: clone(anomaly.release ?? null),
    riskEvent: clone(anomaly.riskEvent ?? null),
    toolCalls,
    evidence,
    hypotheses,
    hypothesisEvidenceLinks,
    evidenceRelations: [],
    ...clone(emptyAggregateCollections),
  };
}

export function buildSanitizedSmokeArtifacts({ dataset, ablation, sourceReports }) {
  const governedByCase = new Map(dataset.cases.map((item) => [item.case_id, item]));
  const selected = [];
  const seen = new Set();
  for (const item of ablation.cases
    .filter((entry) => entry.bottleneck === "SYNTHESIZER_FAILURE_OR_VALIDATION")
    .sort((left, right) => left.caseId.localeCompare(right.caseId) || left.runIndex - right.runIndex)) {
    if (seen.has(item.caseId)) continue;
    seen.add(item.caseId);
    selected.push(item);
  }
  if (selected.length !== 17) throw new Error(`V8_SMOKE_CASE_COUNT_INVALID:${selected.length}`);
  const samples = selected.map((selection) => {
    const sampleId = `SMOKE-${sha256(`v8:${selection.caseId}`).slice(0, 12).toUpperCase()}`;
    const governedCase = governedByCase.get(selection.caseId);
    const source = sourceReports.get(`${selection.runIndex}:${selection.caseId}`);
    if (!governedCase || !source) throw new Error(`V8_SMOKE_SOURCE_MISSING:${selection.caseId}`);
    return { sampleId, aggregate: buildAggregate({ source, governedCase, sampleId }) };
  });
  const agentInput = {
    schemaVersion: "releaseguard-v8-offline-smoke-agent-input-v1",
    mode: "SANITIZED_FROZEN_V7_TRAJECTORIES_ZERO_TOOLS",
    expectedSamples: 17,
    samples,
  };
  assertAgentPlaneSafe(agentInput);
  const evaluatorManifest = {
    schemaVersion: "releaseguard-v8-offline-smoke-evaluator-manifest-v1",
    boundary: "EVALUATOR_ONLY_NOT_READ_BY_SYNTHESIZER",
    samples: selected.map((item, index) => ({
      sampleId: samples[index].sampleId,
      caseId: item.caseId,
      sourceRunIndex: item.runIndex,
    })),
  };
  return { agentInput, evaluatorManifest };
}

export async function generateSmokeInput(root) {
  const resultsRoot = resolve(root, "evaluation/results/v8/smoke");
  const datasetBytes = await readFile(resolve(root, "evaluation/dataset/frozen-cases.json"));
  const ablationBytes = await readFile(resolve(root, "evaluation/results/v7/ablation.json"));
  const dataset = JSON.parse(datasetBytes);
  const ablation = JSON.parse(ablationBytes);
  const sourceReports = new Map();
  const sourceHashes = {};
  for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
    const path = resolve(root, `evaluation/results/v7/raw/harness-v7-run-${runIndex}.json`);
    const bytes = await readFile(path);
    sourceHashes[`v7Run${runIndex}`] = sha256(bytes);
    const report = JSON.parse(bytes);
    for (const item of report.cases) sourceReports.set(`${runIndex}:${item.caseId}`, item);
  }
  const { agentInput, evaluatorManifest } = buildSanitizedSmokeArtifacts({
    dataset,
    ablation,
    sourceReports,
  });
  agentInput.sourceIdentity = {
    datasetSha256: sha256(datasetBytes),
    ablationSha256: sha256(ablationBytes),
    ...sourceHashes,
  };
  assertAgentPlaneSafe(agentInput);
  const inputDirectory = resolve(resultsRoot, "input");
  await mkdir(inputDirectory, { recursive: true });
  const agentPath = resolve(inputDirectory, "agent-input.json");
  const evaluatorPath = resolve(inputDirectory, "evaluator-manifest.json");
  await writeFile(agentPath, `${JSON.stringify(agentInput, null, 2)}\n`, { flag: "wx" });
  await writeFile(evaluatorPath, `${JSON.stringify(evaluatorManifest, null, 2)}\n`, { flag: "wx" });
  return { agentPath, evaluatorPath, samples: agentInput.samples.length };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(await generateSmokeInput(root), null, 2));
}
