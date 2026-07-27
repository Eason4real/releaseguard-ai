import { modelToolDefinitions } from "./tools";
import type { Confidence, Severity } from "./types";

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
};

export type DiagnosisDraft = {
  rootCause: string;
  summary: string;
  causalChain: string[];
  affectedMetrics: string[];
  affectedSegments: string[];
  validatedClaims: string[];
  unvalidatedClaims: string[];
  confidence: Confidence;
  severity: Severity;
  recommendedAction: string;
  requiresHumanApproval: boolean;
};

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 12) : [];

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
  options: { enableTools?: boolean; enableThinking?: boolean } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
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
      throw new Error(`${config.provider} ${response.status}: ${detail.slice(0, 240)}`);
    }
    return (await response.json()) as {
      choices?: Array<{ message?: ModelMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
  } finally {
    clearTimeout(timeout);
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

function normalizeConfidence(value: unknown): Confidence {
  const text = String(value ?? "").trim().toUpperCase();
  if (text === "HIGH" || text === "MEDIUM" || text === "LOW") return text;
  const numeric = Number(text.replace("%", ""));
  if (Number.isFinite(numeric)) {
    const normalized = text.includes("%") || numeric > 1 ? numeric / 100 : numeric;
    if (normalized >= 0.8) return "HIGH";
    if (normalized >= 0.55) return "MEDIUM";
  }
  return "LOW";
}

function normalizeSeverity(value: unknown): Severity {
  const severity = String(value ?? "").trim().toUpperCase();
  if (severity === "CRITICAL" || severity === "HIGH" || severity === "MEDIUM" || severity === "LOW") {
    return severity;
  }
  return "HIGH";
}

export function parseModelDiagnosis(content: string | null): DiagnosisDraft | null {
  const raw = (content ?? "").trim();
  if (!raw) return null;
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  const candidates = [raw, ...fenced, ...extractJsonObjects(raw)];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || !parsed.root_cause) continue;
      const causalChain = stringArray(parsed.causal_chain);
      const validatedClaims = stringArray(parsed.validated_claims ?? parsed.evidence_summary);
      return {
        rootCause: String(parsed.root_cause),
        summary: String(parsed.summary ?? "调查完成"),
        causalChain: causalChain.length > 0 ? causalChain : [String(parsed.summary ?? parsed.root_cause)],
        affectedMetrics: stringArray(parsed.affected_metrics),
        affectedSegments: stringArray(parsed.affected_users ?? parsed.affected_segments),
        validatedClaims,
        unvalidatedClaims: stringArray(parsed.unvalidated_claims),
        confidence: normalizeConfidence(parsed.confidence),
        severity: normalizeSeverity(parsed.severity ?? parsed.risk_level),
        recommendedAction: String(parsed.recommended_action ?? parsed.recommendation ?? "补充调查后再执行变更"),
        requiresHumanApproval: parsed.requires_human_approval !== false,
      };
    } catch {
      // Continue with the next candidate.
    }
  }
  return null;
}

export const investigationSystemPrompt =
  "你是 ReleaseGuard AI 的上线风险调查 Agent。自主选择必要工具，至少交叉验证两个独立来源。不得执行修复、发布、回滚或通知等外部动作。最终仅输出 JSON，字段为 root_cause、summary、causal_chain(字符串数组)、affected_metrics(字符串数组)、affected_users(字符串数组)、validated_claims(字符串数组)、unvalidated_claims(字符串数组)、confidence(HIGH/MEDIUM/LOW)、severity(CRITICAL/HIGH/MEDIUM/LOW)、recommended_action、requires_human_approval。不得输出百分比置信度。高风险修复必须 requires_human_approval=true。";

export const repairSystemPrompt =
  "你是 JSON 格式整理器。只整理用户提供的结论，不增加新事实。仅输出合法 JSON，字段为 root_cause、summary、causal_chain、affected_metrics、affected_users、validated_claims、unvalidated_claims、confidence(HIGH/MEDIUM/LOW)、severity、recommended_action、requires_human_approval。不得输出 Markdown、解释或百分比置信度。";
