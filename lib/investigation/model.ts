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
  transportMaxRetries?: number;
  transportRetryBaseDelayMs?: number;
  transport?: typeof fetch;
  responseObserver?: (response: ModelResponseObservation) => void;
};

export type ModelResponseObservation = {
  model: string;
  attemptIndex?: number;
  transportAttemptIndex?: number;
  latencyMs: number;
  status: "SUCCESS" | "ERROR" | "TIMEOUT" | "CANCELLED";
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
};

export class ModelTransportError extends Error {
  readonly name = "ModelTransportError";
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const retryableHttpStatus = (status: number) => status === 408 || status === 409
  || status === 429 || status >= 500;

const boundedTransportRetries = (value: number | undefined) =>
  Math.min(2, Math.max(0, Math.trunc(value ?? 0)));

const retryDelayMs = (baseDelayMs: number | undefined, retryIndex: number) =>
  Math.min(4_000, Math.max(0, Math.trunc(baseDelayMs ?? 500)) * (2 ** retryIndex));

const waitForRetry = (delayMs: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException("aborted", "AbortError"));
    return;
  }
  const timeout = setTimeout(resolve, delayMs);
  signal.addEventListener("abort", () => {
    clearTimeout(timeout);
    reject(new DOMException("aborted", "AbortError"));
  }, { once: true });
});

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

export function resolveModelEndpoint(baseUrl: string) {
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
  options: {
    enableTools?: boolean;
    enableThinking?: boolean;
    requireJsonObject?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const observe = (observation: ModelResponseObservation) => {
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
  const redactCredential = (value: string) => config.apiKey
    ? value.replaceAll(config.apiKey, "[redacted]")
    : value;
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.1,
    max_tokens: 5000,
  };
  if (options.requireJsonObject && config.provider.toLowerCase() === "deepseek") {
    body.response_format = { type: "json_object" };
  }
  if (options.enableTools !== false) {
    body.tools = modelToolDefinitions;
    body.tool_choice = "auto";
  }
  if (config.provider.toLowerCase() === "deepseek") {
    body.thinking = { type: options.enableThinking === false ? "disabled" : "enabled" };
    if (options.enableThinking !== false) body.reasoning_effort = "high";
  }
  try {
    const maxRetries = boundedTransportRetries(config.transportMaxRetries);
    for (let transportAttemptIndex = 0; transportAttemptIndex <= maxRetries; transportAttemptIndex += 1) {
      const attemptStartedAt = performance.now();
      const timeout = setTimeout(() => abort("TIMEOUT"), config.requestTimeoutMs ?? 75_000);
      try {
        const response = await (config.transport ?? fetch)(resolveModelEndpoint(config.baseUrl), {
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
          const retryable = retryableHttpStatus(response.status);
          observe({ model: config.model, transportAttemptIndex, latencyMs: performance.now() - attemptStartedAt, status: "ERROR", usage: null });
          throw new ModelTransportError(
            `${config.provider} ${response.status}: ${redactCredential(detail).slice(0, 240)}`,
            response.status,
            retryable,
          );
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: ModelMessage }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          model?: string;
        };
        observe({
          model: payload.model ?? config.model,
          transportAttemptIndex,
          latencyMs: performance.now() - attemptStartedAt,
          status: "SUCCESS",
          usage: payload.usage ? {
            promptTokens: payload.usage.prompt_tokens ?? null,
            completionTokens: payload.usage.completion_tokens ?? null,
            totalTokens: payload.usage.total_tokens ?? null,
          } : null,
        });
        return payload;
      } catch (error) {
        const retryable = error instanceof ModelTransportError
          ? error.retryable
          : error instanceof TypeError;
        if (!(error instanceof ModelTransportError)) {
          observe({
            model: config.model,
            transportAttemptIndex,
            latencyMs: performance.now() - attemptStartedAt,
            status: abortStatus ?? "ERROR",
            usage: null,
          });
        }
        if (transportAttemptIndex >= maxRetries || !retryable || controller.signal.aborted) throw error;
        await waitForRetry(retryDelayMs(config.transportRetryBaseDelayMs, transportAttemptIndex), controller.signal);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("MODEL_TRANSPORT_RETRY_STATE_INVALID");
  } catch (error) {
    if (error instanceof Error && config.apiKey && error.message.includes(config.apiKey)) {
      const sanitized = error instanceof ModelTransportError
        ? new ModelTransportError(redactCredential(error.message), error.statusCode, error.retryable)
        : new Error(redactCredential(error.message));
      if (!(sanitized instanceof ModelTransportError)) sanitized.name = error.name;
      throw sanitized;
    }
    throw error;
  } finally {
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
