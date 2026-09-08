import type { InvestigationAggregate } from "../../../lib/investigation/types";
import { LLMInvestigationPlanner } from "../../../lib/investigation/llm-planner";
import { LLMInvestigationSynthesizer } from "../../../lib/investigation/llm-synthesizer";
import { StagedInvestigationPlanner } from "../../../lib/investigation/staged-planner";
import { ModelTransportError, resolveModelEndpoint } from "../../../lib/investigation/model";
import { projectInvestigationOutcomeV2 } from
  "../../../lib/investigation/outcome-projection";
import { summarizePlannerUsage } from "../../../lib/investigation/planner-usage";
import { executeHarnessAgentRuntime, HarnessRuntimeExecutionError } from "./runtime";
import { telemetryFromAggregate } from "./telemetry";
import { benchmarkEvidenceMap } from "./fixture-adapter";
import {
  INCONCLUSIVE_PREDICTION_FALLBACK,
  projectInconclusivePrediction,
} from "./inconclusive-prediction";
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
    transportMaxRetries: Math.min(2, Math.max(0, Math.trunc(input.transportMaxRetries ?? 0))),
    transportRetryBaseDelayMs: Math.min(
      4_000,
      Math.max(0, Math.trunc(input.transportRetryBaseDelayMs ?? 500)),
    ),
    fixtureQueryHints: input.fixtureQueryHints ?? false,
    harnessVersion: input.harnessVersion ?? "V2",
    sourceIdentity: input.sourceIdentity?.trim() || undefined,
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
  schemaRepairMax: 2,
  transportRetry: config.transportMaxRetries ?? 0,
  fixtureQueryHints: config.fixtureQueryHints ?? false,
  harnessVersion: config.harnessVersion ?? "V2",
  sourceIdentity: config.sourceIdentity ?? null,
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
  harnessVersion?: LiveHarnessModelConfig["harnessVersion"],
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
  const inconclusivePrediction = !diagnosis && aggregate.run.status === "INCONCLUSIVE"
    ? projectInconclusivePrediction({
        run: {
          status: aggregate.run.status,
          stopReason: aggregate.run.stopReason,
        },
        hypotheses: aggregate.hypotheses.map((hypothesis) => ({
          statement: hypothesis.statement,
          status: hypothesis.status,
          confidence: hypothesis.confidence,
          supportScore: hypothesis.supportScore,
          contradictionScore: hypothesis.contradictionScore,
          createdAt: hypothesis.createdAt,
        })),
      })
    : null;
  const outcomeProjection = harnessVersion === "V8"
    ? projectInvestigationOutcomeV2(aggregate)
    : null;
  const v8BoundedPrediction = outcomeProjection?.kind === "BOUNDED_HYPOTHESIS"
    ? `Leading hypothesis (not yet confirmed as the sole root cause): ${outcomeProjection.leadingHypothesis}`
    : null;
  return {
    predictedRootCause: diagnosis?.rootCause
      ?? v8BoundedPrediction
      ?? inconclusivePrediction
      ?? INCONCLUSIVE_PREDICTION_FALLBACK,
    predictedRootCauseId: null,
    ...(outcomeProjection
      ? { outcomeProjection }
      : {}),
    ...(!diagnosis ? { citedEvidenceIds: [] } : {}),
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
  if (error instanceof ModelTransportError) {
    if (error.statusCode === 401 || error.statusCode === 403) return "PROVIDER_AUTHENTICATION_FAILED";
    if (error.statusCode === 402) return "PROVIDER_QUOTA_EXHAUSTED";
    if (error.statusCode === 429) return "PROVIDER_RATE_LIMITED";
    if (error.statusCode !== null && error.statusCode >= 500) return "PROVIDER_UNAVAILABLE";
  }
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
      const collector = new LLMInvestigationPlanner(this.#config, {
        maxDecisionRepairAttempts: 2,
        policyVersion: this.#config.harnessVersion ?? "V2",
      });
      const planner = ["V7", "V8"].includes(this.#config.harnessVersion ?? "")
        ? new StagedInvestigationPlanner(
            collector,
            new LLMInvestigationSynthesizer(this.#config, 1),
            { packetVersion: this.#config.harnessVersion === "V8" ? "V2" : "V1" },
          )
        : collector;
      const aggregate = await executeHarnessAgentRuntime(request, {
        planner,
        provider: this.#config.provider,
        model: this.#config.model,
        maxModelCalls: 20,
        maxIterations: 16,
        maxToolCalls: 10,
        includeFixtureQueryHints: this.#config.fixtureQueryHints ?? false,
        harnessVersion: this.#config.harnessVersion ?? "V2",
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
          this.#config.harnessVersion,
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
