import { modelToolDefinitions } from "./tools";
import { DIAGNOSIS_CLAIM_TYPES, DIAGNOSIS_LIMITATION_TYPES } from "./types";
import type { DiagnosisDisposition } from "./types";
import type { DiagnosisClaimDraft, GroundedDiagnosisDraft } from "./planner";

export type ModelToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string | null;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
};

export type ModelConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  requestTimeoutMs?: number;
  responseObserver?: (response: ModelResponseObservation) => void;
};

export type ModelResponseObservation = {
  model: string;
  attemptIndex?: number;
  latencyMs: number;
  status: "SUCCESS" | "ERROR" | "TIMEOUT" | "CANCELLED";
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
};

export type ModelFinalization = {
  selectedHypothesisId: string;
  diagnosis: GroundedDiagnosisDraft;
  disposition: DiagnosisDisposition;
};

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (host.includes(":")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function resolveEndpoint(baseUrl: string) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" || isPrivateHost(endpoint.hostname)) {
    throw new Error("API Base URL 必须是可公开访问的 HTTPS 地址。");
  }
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  const path = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return endpoint.toString();
}

export async function callModel(
  config: ModelConfig,
  messages: ModelMessage[],
  options: { enableTools?: boolean; enableThinking?: boolean; signal?: AbortSignal } = {},
) {
  const startedAt = performance.now();
  let observationSent = false;
  const observe = (observation: ModelResponseObservation) => {
    if (observationSent) return;
    observationSent = true;
    try {
      config.responseObserver?.(observation);
    } catch {
      // Eval instrumentation must never change Planner behavior.
    }
  };
  const controller = new AbortController();
  let abortStatus: "TIMEOUT" | "CANCELLED" | null = null;
  const abort = (status: "TIMEOUT" | "CANCELLED") => {
    if (controller.signal.aborted) return;
    abortStatus = status;
    controller.abort();
  };
  const cancelFromCaller = () => abort("CANCELLED");
  if (options.signal?.aborted) cancelFromCaller();
  else options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  const timeout = setTimeout(() => abort("TIMEOUT"), config.requestTimeoutMs ?? 75_000);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.1,
    max_tokens: 5000,
  };
  if (options.enableTools !== false) {
    body.tools = modelToolDefinitions;
    body.tool_choice = "auto";
  }
  if (config.provider.toLowerCase() === "deepseek" && options.enableThinking !== false) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = "high";
  }
  try {
    const response = await fetch(resolveEndpoint(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      observe({ model: config.model, latencyMs: performance.now() - startedAt, status: "ERROR", usage: null });
      throw new Error(`${config.provider} ${response.status}: ${detail.slice(0, 240)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: ModelMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };
    observe({
      model: payload.model ?? config.model,
      latencyMs: performance.now() - startedAt,
      status: "SUCCESS",
      usage: payload.usage ? {
        promptTokens: payload.usage.prompt_tokens ?? null,
        completionTokens: payload.usage.completion_tokens ?? null,
        totalTokens: payload.usage.total_tokens ?? null,
      } : null,
    });
    return payload;
  } catch (error) {
    observe({
      model: config.model,
      latencyMs: performance.now() - startedAt,
      status: abortStatus ?? "ERROR",
      usage: null,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancelFromCaller);
  }
}

function extractJsonObjects(content: string) {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

const hasOnlyKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

export function parseModelFinalization(content: string | null): ModelFinalization | null {
  const raw = (content ?? "").trim();
  if (!raw) return null;
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  const candidates = [raw, ...fenced, ...extractJsonObjects(raw)];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (!hasOnlyKeys(parsed, ["selectedHypothesisId", "diagnosis", "disposition"])) continue;
      const selectedHypothesisId = String(parsed.selectedHypothesisId ?? "").trim();
      const disposition = String(parsed.disposition ?? "").trim();
      const diagnosis = parsed.diagnosis;
      if (
        !selectedHypothesisId
        || !["OBSERVE", "FIX", "ROLLBACK", "ESCALATE"].includes(disposition)
        || !diagnosis
        || typeof diagnosis !== "object"
        || Array.isArray(diagnosis)
      ) continue;
      const diagnosisObject = diagnosis as Record<string, unknown>;
      if (!hasOnlyKeys(diagnosisObject, ["summary", "claims"])) continue;
      const summary = String(diagnosisObject.summary ?? "").trim();
      if (!summary || !Array.isArray(diagnosisObject.claims) || diagnosisObject.claims.length === 0) {
        continue;
      }
      const claims: DiagnosisClaimDraft[] = [];
      let valid = true;
      for (const item of diagnosisObject.claims) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          valid = false;
          break;
        }
        const claim = item as Record<string, unknown>;
        const type = String(claim.type ?? "");
        const allowedClaimKeys = type === "LIMITATION"
          ? ["type", "limitationType", "statement", "evidenceIds"]
          : ["type", "statement", "evidenceIds"];
        if (!hasOnlyKeys(claim, allowedClaimKeys)) {
          valid = false;
          break;
        }
        const statement = String(claim.statement ?? "").trim();
        const evidenceIds = Array.isArray(claim.evidenceIds)
          ? claim.evidenceIds.map(String).map((id) => id.trim()).filter(Boolean)
          : [];
        if (!DIAGNOSIS_CLAIM_TYPES.includes(type as DiagnosisClaimDraft["type"]) || !statement) {
          valid = false;
          break;
        }
        if (type === "LIMITATION") {
          const limitationType = String(claim.limitationType ?? "");
          if (!DIAGNOSIS_LIMITATION_TYPES.includes(
            limitationType as (typeof DIAGNOSIS_LIMITATION_TYPES)[number],
          )) {
            valid = false;
            break;
          }
          claims.push({
            type,
            limitationType: limitationType as (typeof DIAGNOSIS_LIMITATION_TYPES)[number],
            statement,
            evidenceIds,
          });
        } else {
          claims.push({
            type: type as Exclude<DiagnosisClaimDraft["type"], "LIMITATION">,
            statement,
            evidenceIds,
          });
        }
      }
      if (!valid) continue;
      return {
        selectedHypothesisId,
        diagnosis: { summary, claims },
        disposition: disposition as DiagnosisDisposition,
      };
    } catch {
      // Continue with the next candidate.
    }
  }
  return null;
}

export const investigationSystemPrompt =
  "你是 ReleaseGuard AI 的上线风险调查 Agent。自主选择必要工具，至少交叉验证两个独立来源。不得执行修复、发布、回滚或通知等外部动作。最终结论必须选择一个有效 Hypothesis，并为每个关键 Diagnosis Claim 引用当前 Run 的 Evidence。不得输出 confidence、grounding status 或 grounding score。";

export const repairSystemPrompt =
  "你是 JSON 格式整理器。只整理用户提供的结论，不增加新事实。不得增加或判断 confidence、grounding status 或 grounding score。";
