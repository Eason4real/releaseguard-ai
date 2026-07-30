import type {
  HarnessAgentRequest,
  HarnessExecutionOutcome,
  HarnessExecutionProvider,
  HarnessExecutionProviderFactory,
} from "./types";
import { executeHarnessAgentRuntime } from "./runtime";
import { telemetryFromAggregate } from "./telemetry";

const requireCount = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${label.toUpperCase()}`);
};

export class DeterministicHarnessProvider implements HarnessExecutionProvider {
  readonly providerType = "HARNESS_PROVIDER" as const;
  readonly executionMetadata = {
    label: "Deterministic Harness Validation" as const,
    executionProvider: "HARNESS_PROVIDER" as const,
    runtimeMode: "DETERMINISTIC_NO_LIVE_MODEL" as const,
    modelConfiguration: "deterministic / no live model" as const,
  };
  private executed = false;

  async execute(request: HarnessAgentRequest): Promise<HarnessExecutionOutcome> {
    if (this.executed) throw new Error("HARNESS_PROVIDER_INSTANCE_REUSED");
    this.executed = true;
    const allowedTools = new Set(request.enabledTools);
    for (const observation of request.observations) {
      if (!allowedTools.has(observation.toolName)) {
        throw new Error(`HARNESS_TOOL_NOT_ENABLED: ${observation.toolName}`);
      }
      if (!/^EV-\d{3,}$/.test(observation.evidenceId)) {
        throw new Error(`NON_OPAQUE_EVIDENCE_ID: ${observation.evidenceId}`);
      }
    }

    // This fixture-compatible provider intentionally makes no capability claim. It executes the
    // observable script and applies one case-agnostic stopping policy without answer lookup.
    let observability;
    const aggregate = await executeHarnessAgentRuntime(request, {
      onObservability: (value) => { observability = value; },
    });
    if (aggregate.run.status !== "INCONCLUSIVE") {
      return {
        status: "FAIL",
        terminalInvestigationState: "FAILED",
        error: aggregate.run.errorMessage ?? `INVALID_TERMINAL_STATE: ${aggregate.run.status}`,
      };
    }
    const executedTools = new Set(aggregate.toolCalls
      .filter((call) => call.proposedActionId === null && call.status === "COMPLETED")
      .map((call) => call.name));
    const successful = request.observations.filter((item) =>
      item.status === "SUCCESS" && executedTools.has(item.toolName));
    const citedEvidenceIds = successful.map((item) => item.evidenceId);
    const statement = "Insufficient evidence to determine a root cause from the available observations.";
    const prediction = {
      predictedRootCause: statement,
      predictedRootCauseId: null,
      citedEvidenceIds,
      diagnosisClaims: [{
        claimId: "CLAIM-001",
        type: "ROOT_CAUSE" as const,
        statement,
        groundingStatus: "GROUNDED" as const,
        citedEvidenceIds,
      }],
      modelCallCount: aggregate.run.modelCallCount,
      toolCallCount: aggregate.toolCalls.filter((call) => call.proposedActionId === null).length,
    };
    requireCount(prediction.modelCallCount, "modelCallCount");
    requireCount(prediction.toolCallCount, "toolCallCount");
    return {
      status: "PASS",
      terminalInvestigationState: "INCONCLUSIVE",
      prediction,
      telemetry: telemetryFromAggregate(request, aggregate, [], observability),
    };
  }
}

export const createDeterministicHarnessProviderFactory = (): HarnessExecutionProviderFactory => ({
  executionMetadata: {
    label: "Deterministic Harness Validation",
    executionProvider: "HARNESS_PROVIDER",
    runtimeMode: "DETERMINISTIC_NO_LIVE_MODEL",
    modelConfiguration: "deterministic / no live model",
  },
  create: () => new DeterministicHarnessProvider(),
});
