import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildEvidencePacketV2, evaluateEvidenceReadinessV2 } from
  "../lib/investigation/evidence-packet-v2.ts";
import { LLMInvestigationSynthesizer } from "../lib/investigation/llm-synthesizer.ts";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = resolve(root, "evaluation/results/v8/smoke");
const input = JSON.parse(await readFile(resolve(smokeRoot, "input/agent-input.json"), "utf8"));
if (input.schemaVersion !== "releaseguard-v8-offline-smoke-agent-input-v1"
  || input.expectedSamples !== 17 || input.samples?.length !== 17) {
  throw new Error("V8_SMOKE_AGENT_INPUT_INVALID");
}
await mkdir(resolve(smokeRoot, "raw"), { recursive: true });
const seriesId = process.env.V8_SMOKE_SERIES?.trim() || "contract-v2";
if (!/^[a-z0-9-]+$/.test(seriesId)) throw new Error("V8_SMOKE_SERIES_INVALID");
const outputPath = resolve(smokeRoot, `raw/synthesis-attempts-${seriesId}.jsonl`);
let attempts = [];
try {
  attempts = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const completed = new Set(attempts.filter((item) => !item.error).map((item) => item.sampleId));
const providerConfig = {
  provider: required("LIVE_EVAL_PROVIDER"),
  baseUrl: required("LIVE_EVAL_BASE_URL"),
  apiKey: required("LIVE_EVAL_API_KEY"),
  model: required("LIVE_EVAL_MODEL"),
  requestTimeoutMs: 75_000,
};

for (const sample of input.samples) {
  if (completed.has(sample.sampleId)) continue;
  const readiness = evaluateEvidenceReadinessV2(sample.aggregate, 0);
  const packet = buildEvidencePacketV2(sample.aggregate, readiness);
  let ordinal = 0;
  const synthesizer = new LLMInvestigationSynthesizer(providerConfig, 1);
  const startedAt = Date.now();
  let record;
  try {
    const decision = await synthesizer.synthesize({
      aggregate: sample.aggregate,
      trigger: "INITIAL",
      humanMessage: null,
      remainingIterations: 2,
      remainingToolCalls: 0,
      evidencePacket: packet,
      readiness,
      modelCallBudget: {
        async reserve() {
          if (ordinal >= 2) return { reserved: false, modelCallCount: ordinal, maxModelCalls: 2 };
          ordinal += 1;
          return { reserved: true, reservation: {
            id: `V8-SMOKE-${sample.sampleId}-${ordinal}`,
            ordinal,
            maxModelCalls: 2,
            reservedAt: new Date().toISOString(),
          } };
        },
      },
    });
    record = {
      schemaVersion: "releaseguard-v8-offline-smoke-attempt-v2",
      seriesId,
      mode: "PACKET_V2_FROZEN_TRAJECTORY_ZERO_TOOLS",
      sampleId: sample.sampleId,
      readiness,
      decision,
      modelCalls: synthesizer.drainModelCallObservations(),
      synthesisAttempts: synthesizer.drainAttemptObservations(),
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    record = {
      schemaVersion: "releaseguard-v8-offline-smoke-attempt-v2",
      seriesId,
      mode: "PACKET_V2_FROZEN_TRAJECTORY_ZERO_TOOLS",
      sampleId: sample.sampleId,
      readiness,
      decision: null,
      outcomeProjection: null,
      modelCalls: synthesizer.drainModelCallObservations(),
      synthesisAttempts: synthesizer.drainAttemptObservations(),
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      error: message.slice(0, 1000),
    };
  }
  await appendFile(outputPath, `${JSON.stringify(record)}\n`);
  console.error(`[${sample.sampleId}] ${record.error ?? record.decision?.type}`);
  if (/PROVIDER_QUOTA_EXHAUSTED|\b402\b|Insufficient Balance/i.test(record.error ?? "")) break;
}

attempts = (await readFile(outputPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const effective = new Map();
for (const item of attempts) {
  if (!effective.has(item.sampleId) || !item.error) effective.set(item.sampleId, item);
}
const records = [...effective.values()];
console.log(JSON.stringify({
  output: outputPath,
  expectedSamples: 17,
  completedSamples: records.filter((item) => !item.error).length,
  retainedSamples: records.length,
  errors: records.filter((item) => item.error).length,
  finalized: records.filter((item) => item.decision?.type === "FINALIZE").length,
  inconclusive: records.filter((item) => item.decision?.type === "STOP_INCONCLUSIVE").length,
  modelCalls: records.reduce((total, item) => total + item.modelCalls.length, 0),
  toolCalls: 0,
  totalAttempts: attempts.length,
}, null, 2));
