import type { InvestigationAggregate } from "../../../lib/investigation/types";
import { LLMInvestigationPlanner } from "../../../lib/investigation/llm-planner";
import { resolveModelEndpoint } from "../../../lib/investigation/model";
import { summarizePlannerUsage } from "../../../lib/investigation/planner-usage";
import { executeHarnessAgentRuntime, HarnessRuntimeExecutionError } from "./runtime";
import { telemetryFromAggregate } from "./telemetry";
import { benchmarkEvidenceMap } from "./fixture-adapter";
import {
  LIVE_MODEL_PROVIDERS,
  type HarnessAgentRequest,
  type HarnessExecutionOutcome,
  type HarnessExecutionProvider,
  type HarnessExecutionProviderFactory,
  type HarnessFixtureExecutionRecord,
  type LiveHarnessManifestModelConfiguration,
  type LiveHarnessModelConfig,
  type LiveModelProvider,
} from "./types";

const DEFAULT_TIMEOUT_MS = 75_000;

export type LiveHarnessConfigurationErrorCode =
  | "LIVE_PROVIDER_REQUIRED"
  | "LIVE_PROVIDER_INVALID"
  | "LIVE_BASE_URL_REQUIRED"
  | "LIVE_BASE_URL_INVALID"
  | "LIVE_API_KEY_REQUIRED"
  | "LIVE_MODEL_REQUIRED";

export class LiveHarnessConfigurationError extends Error {
  readonly name = "LiveHarnessConfigurationError";
  constructor(readonly code: LiveHarnessConfigurationErrorCode) {
    super(code);
  }
}

const required = (
  value: string | undefined,
  code: LiveHarnessConfigurationErrorCode,
) => {
  const normalized = value?.trim();
  if (!normalized) throw new LiveHarnessConfigurationError(code);
  return normalized;
};

export function validateLiveHarnessModelConfig(
  input: Partial<LiveHarnessModelConfig>,
): LiveHarnessModelConfig {
  const provider = required(input.provider, "LIVE_PROVIDER_REQUIRED");
  if (!(LIVE_MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new LiveHarnessConfigurationError("LIVE_PROVIDER_INVALID");
  }
  const baseUrl = required(input.baseUrl, "LIVE_BASE_URL_REQUIRED");
  try {
    resolveModelEndpoint(baseUrl);
  } catch {
    throw new LiveHarnessConfigurationError("LIVE_BASE_URL_INVALID");
  }
  return {
    provider: provider as LiveModelProvider,
    baseUrl,
    apiKey: required(input.apiKey, "LIVE_API_KEY_REQUIRED"),
    model: required(input.model, "LIVE_MODEL_REQUIRED"),
    requestTimeoutMs: input.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.responseObserver ? { responseObserver: input.responseObserver } : {}),
  };
}

const manifestConfiguration = (
  config: LiveHarnessModelConfig,
): LiveHarnessManifestModelConfiguration => ({
  provider: config.provider,
  endpointType: "OPENAI_COMPATIBLE_CHAT_COMPLETIONS",
  baseUrl: resolveModelEndpoint(config.baseUrl),
  model: config.model,
  temperature: 0.1,
  topP: "PROVIDER_DEFAULT",
  maxOutputTokens: 5000,
  reasoningConfig: config.provider === "deepseek"
    ? "DEEPSEEK_ENABLED_HIGH"
    : "PROVIDER_DEFAULT",
  maxModelCalls: 20,
  toolBudget: 10,
  maxIterations: 16,
  timeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  schemaRepairMax: 1,
  transportRetry: 0,
  concurrency: 1,
  credentialPresent: true,
});

const evidenceIdMap = (
  aggregate: InvestigationAggregate,
  fixtureExecutions: readonly HarnessFixtureExecutionRecord[],
) => benchmarkEvidenceMap(aggregate, fixtureExecutions);

const predictionFromAggregate = (
  aggregate: InvestigationAggregate,
  durationMs: number,
  fixtureExecutions: readonly HarnessFixtureExecutionRecord[],
) => {
  const diagnosis = aggregate.diagnosis;
  const claims = aggregate.diagnosisClaims.filter((item) => item.diagnosisId === diagnosis?.id);
  const claimIds = new Set(claims.map((item) => item.id));
  const links = aggregate.diagnosisClaimEvidenceLinks.filter((item) => claimIds.has(item.claimId));
  const evidenceIds = evidenceIdMap(aggregate, fixtureExecutions);
  const mappedLinks = links.flatMap((item) => {
    const evidenceId = evidenceIds.get(item.evidenceId);
    return evidenceId ? [{ claimId: item.claimId, evidenceId }] : [];
  });
  const usage = summarizePlannerUsage(aggregate.auditEvents);
  return {
    predictedRootCause: diagnosis?.rootCause
      ?? "Insufficient evidence to determine a root cause from the available observations.",
    predictedRootCauseId: null,
    diagnosisClaims: claims.map((claim) => ({
      claimId: claim.id,
      type: claim.type,
      statement: claim.statement,
      groundingStatus: claim.groundingStatus,
      citedEvidenceIds: mappedLinks.filter((item) => item.claimId === claim.id)
        .map((item) => item.evidenceId),
    })),
    modelCallCount: aggregate.run.modelCallCount,
    toolCallCount: aggregate.toolCalls.filter((item) => item.proposedActionId === null).length,
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      completeness: usage.completeness,
    },
    durationMs,
  };
};

const providerErrorCode = (error: unknown) => {
  if (error instanceof HarnessRuntimeExecutionError) return providerErrorCode(error.runtimeCause);
  const message = error instanceof Error ? error.message : "";
  if (/\b(?:401|403)\b/.test(message)) return "PROVIDER_AUTHENTICATION_FAILED";
  if (/\b429\b/.test(message)) return "PROVIDER_RATE_LIMITED";
  if (error instanceof Error && (error.name === "AbortError" || /abort|timeout/i.test(message))) {
    return "PROVIDER_TIMEOUT";
  }
  if (error instanceof Error && [
    "PlannerDecisionValidationError",
    "PlannerDecisionSemanticError",
  ].includes(error.name)) return "PROVIDER_MALFORMED_RESPONSE";
  return "PROVIDER_FAILURE";
};

const providerErrorCategory = (error: unknown) => {
  if (error instanceof HarnessRuntimeExecutionError) return providerErrorCategory(error.runtimeCause);
  if (error instanceof Error && error.name === "PlannerDecisionValidationError") {
    return "PLANNER_SCHEMA_ERROR" as const;
  }
  if (error instanceof Error && error.name === "PlannerDecisionSemanticError") {
    return "INVALID_PLANNER_DECISION" as const;
  }
  return "RUNTIME_ERROR" as const;
};

export class LiveLLMHarnessProvider implements HarnessExecutionProvider {
  readonly providerType = "LIVE_LLM_PROVIDER" as const;
  readonly executionMetadata;
  readonly #config: LiveHarnessModelConfig;
  #executed = false;

  constructor(input: Partial<LiveHarnessModelConfig>) {
    this.#config = validateLiveHarnessModelConfig(input);
    this.executionMetadata = {
      label: "Live LLM Benchmark" as const,
      executionProvider: "LIVE_LLM_PROVIDER" as const,
      runtimeMode: "LIVE_LLM" as const,
      modelConfiguration: manifestConfiguration(this.#config),
    };
  }

  async execute(request: HarnessAgentRequest): Promise<HarnessExecutionOutcome> {
    if (this.#executed) throw new Error("LIVE_LLM_PROVIDER_INSTANCE_REUSED");
    this.#executed = true;
    const startedAt = performance.now();
    let observability;
    let fixtureExecutions: HarnessFixtureExecutionRecord[] = [];
    try {
      const aggregate = await executeHarnessAgentRuntime(request, {
        planner: new LLMInvestigationPlanner(this.#config),
        provider: this.#config.provider,
        model: this.#config.model,
        maxModelCalls: 20,
        maxIterations: 16,
        maxToolCalls: 10,
        onObservability: (value) => { observability = value; },
        onFixtureExecutions: (value) => { fixtureExecutions = value; },
      });
      const terminalInvestigationState = aggregate.diagnosis
        ? "FINALIZED" as const
        : aggregate.run.status === "INCONCLUSIVE"
          ? "INCONCLUSIVE" as const
          : "FAILED" as const;
      if (terminalInvestigationState === "FAILED") {
        return {
          status: "FAIL",
          terminalInvestigationState,
          telemetry: telemetryFromAggregate(request, aggregate, [this.#config.apiKey], observability),
          error: "LIVE_RUNTIME_FAILED",
          errorCategory: "RUNTIME_ERROR",
        };
      }
      return {
        status: "PASS",
        terminalInvestigationState,
        prediction: predictionFromAggregate(
          aggregate,
          performance.now() - startedAt,
          fixtureExecutions,
        ),
        telemetry: telemetryFromAggregate(request, aggregate, [this.#config.apiKey], observability),
      };
    } catch (error) {
      return {
        status: "FAIL",
        terminalInvestigationState: "FAILED",
        ...(error instanceof HarnessRuntimeExecutionError && error.aggregate
          ? { telemetry: telemetryFromAggregate(
            request,
            error.aggregate,
            [this.#config.apiKey],
            error.observability,
          ) }
          : {}),
        error: providerErrorCode(error),
        errorCategory: providerErrorCategory(error),
      };
    }
  }
}

export const createLiveLLMHarnessProviderFactory = (
  config: Partial<LiveHarnessModelConfig>,
): HarnessExecutionProviderFactory => {
  const validated = validateLiveHarnessModelConfig(config);
  const provider = new LiveLLMHarnessProvider(validated);
  return {
    executionMetadata: provider.executionMetadata,
    create: () => new LiveLLMHarnessProvider(validated),
  };
};

export const __testOnlyLiveProvider = {
  providerErrorCode,
  providerErrorCategory,
  evidenceIdMap,
  predictionFromAggregate,
};
