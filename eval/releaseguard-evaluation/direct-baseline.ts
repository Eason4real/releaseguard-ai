import { callModel, type ModelResponseObservation } from "../../lib/investigation/model";
import { loadInvestigationBenchmarkDevDataset } from "../investigation-benchmark/dataset/dev";
import { scoreInvestigationCase } from "../investigation-benchmark/scorer";

type DirectAnswer = {
  root_cause: string;
  evidence_ids: string[];
  evidence_summary: string;
  recommendation: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

const jsonObject = (text: string) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [text, fenced].filter(Boolean) as string[]) {
    try { return JSON.parse(candidate) as unknown; } catch { /* try next */ }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as unknown;
  throw new Error("DIRECT_BASELINE_JSON_NOT_FOUND");
};

const parseAnswer = (content: string): DirectAnswer => {
  const value = jsonObject(content) as Record<string, unknown>;
  const confidence = String(value.confidence ?? "");
  if (!String(value.root_cause ?? "").trim()
    || !Array.isArray(value.evidence_ids)
    || !["HIGH", "MEDIUM", "LOW"].includes(confidence)) {
    throw new Error("DIRECT_BASELINE_SCHEMA_INVALID");
  }
  return {
    root_cause: String(value.root_cause).trim(),
    evidence_ids: value.evidence_ids.map(String),
    evidence_summary: String(value.evidence_summary ?? "").trim(),
    recommendation: String(value.recommendation ?? "").trim(),
    confidence: confidence as DirectAnswer["confidence"],
  };
};

export async function runDirectBaseline(config: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  runIndex: number;
  onCase?: (record: Record<string, unknown>) => Promise<void> | void;
}) {
  const dataset = loadInvestigationBenchmarkDevDataset();
  const fixtures = new Map(dataset.fixtures.map((item) => [item.benchmarkCase.caseId, item]));
  const records: Record<string, unknown>[] = [];
  for (const entry of [...dataset.manifest.caseEntries].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
    const fixture = fixtures.get(entry.caseId)!;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const observations: ModelResponseObservation[] = [];
    let rawContent = "";
    let error: string | null = null;
    let answer: DirectAnswer | null = null;
    let scoring = null;
    try {
      const payload = await callModel({
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        requestTimeoutMs: 75_000,
        responseObserver(value) { observations.push(value); },
      }, [{
        role: "system",
        content: "You are an incident investigator. Use only supplied evidence. Historical incidents are clues, not proof. Return one JSON object and no prose: {root_cause:string,evidence_ids:string[],evidence_summary:string,recommendation:string,confidence:'HIGH'|'MEDIUM'|'LOW'}. If evidence cannot distinguish causes, root_cause must explicitly state that it is insufficient and name unresolved alternatives.",
      }, {
        role: "user",
        content: JSON.stringify({
          incident: fixture.benchmarkCase.input,
          observations: fixture.evidence.map((evidence) => {
            const item = { ...evidence } as Record<string, unknown>;
            delete item.role;
            return item;
          }),
        }),
      }], { enableTools: false });
      rawContent = payload.choices?.[0]?.message?.content ?? "";
      answer = parseAnswer(rawContent);
      const observation = observations.at(-1);
      scoring = scoreInvestigationCase(fixture.benchmarkCase, {
        caseId: entry.caseId,
        predictedRootCause: answer.root_cause,
        predictedRootCauseId: null,
        citedEvidenceIds: answer.evidence_ids,
        diagnosisClaims: [{
          claimId: "DIRECT-ROOT-CAUSE",
          type: "ROOT_CAUSE",
          statement: answer.root_cause,
          citedEvidenceIds: answer.evidence_ids,
          groundingStatus: answer.evidence_ids.length > 0 ? "GROUNDED" : "UNGROUNDED",
        }],
        modelCallCount: 1,
        toolCallCount: 0,
        tokenUsage: {
          inputTokens: observation?.usage?.promptTokens ?? null,
          outputTokens: observation?.usage?.completionTokens ?? null,
          totalTokens: observation?.usage?.totalTokens ?? null,
          completeness: observation?.usage && Object.values(observation.usage).every((v) => v !== null)
            ? "COMPLETE" : "UNAVAILABLE",
        },
        durationMs: performance.now() - started,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "DIRECT_BASELINE_FAILED";
    }
    const record = {
      schema_version: "releaseguard-evaluation-raw-v1",
      case_id: entry.caseId,
      system: "DIRECT_LLM",
      run_id: `DIRECT-${config.runIndex}-${entry.caseId}`,
      run_index: config.runIndex,
      input_version: dataset.manifest.version,
      dataset_hash: dataset.manifest.expectedDatasetHash,
      model: { provider: config.provider, model: config.model, temperature: 0.1 },
      trajectory: null,
      tool_calls: [],
      evidence: answer?.evidence_ids ?? [],
      final_diagnosis: answer?.root_cause ?? null,
      recommendation: answer?.recommendation ?? null,
      confidence: answer?.confidence ?? null,
      scoring,
      scoring_basis: "Frozen deterministic phase1a-v2 scorer; review-required cases remain unadjudicated.",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: performance.now() - started,
      token_usage: observations.at(-1)?.usage ?? null,
      estimated_cost_usd: null,
      retries: 0,
      error,
      raw_model_content: rawContent,
    };
    records.push(record);
    await config.onCase?.(record);
  }
  return records;
}
