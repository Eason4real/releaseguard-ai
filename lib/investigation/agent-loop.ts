import type { AnalyticsStore } from "../analytics/store";
import { calculateHypothesisConfidence } from "./confidence";
import type { InvestigationPlanner } from "./planner";
import type { Phase3InvestigationStore } from "./phase3-store";
import { createToolSignature } from "./state";
import {
  executeAndRecordTool,
  finalizeInvestigation,
  markInvestigationFailed,
} from "./runtime";
import type {
  AgentIteration,
  AgentIterationTrigger,
  Hypothesis,
  HypothesisEvidenceLink,
  InvestigationStopReason,
  InvestigationTraceEvent,
} from "./types";
import type { FeedbackRetriever, IncidentRetriever } from "../retrieval/types";

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const trace = (
  runId: string,
  iterationId: string | null,
  sequence: number,
  type: string,
  actor: InvestigationTraceEvent["actor"],
  publicSummary: string,
  details: Record<string, unknown> = {},
): InvestigationTraceEvent => ({
  id: createId("ITE"),
  runId,
  iterationId,
  sequence,
  type,
  actor,
  publicSummary,
  details,
  createdAt: new Date().toISOString(),
});

async function stopInconclusive(
  store: Phase3InvestigationStore,
  runId: string,
  reason: InvestigationStopReason,
  summary: string,
) {
  const aggregate = await store.getAggregate(runId);
  const sequence = (aggregate?.traceEvents.at(-1)?.sequence ?? 0) + 1;
  await store.saveTraceEvents([
    trace(runId, null, sequence, "INVESTIGATION_STOPPED", "RUNTIME", summary, { reason }),
  ]);
  await store.transitionRun(runId, "INCONCLUSIVE", {
    stopReason: reason,
    completedAt: new Date().toISOString(),
  });
}

export async function runAgentLoop(
  store: Phase3InvestigationStore,
  input: {
    runId: string;
    planner: InvestigationPlanner;
    analytics?: AnalyticsStore;
    trigger?: AgentIterationTrigger;
    humanMessage?: string | null;
    triggerMessageId?: string | null;
    maxIterations?: number;
    maxToolCalls?: number;
    feedbackRetriever?: FeedbackRetriever;
    incidentRetriever?: IncidentRetriever;
  },
) {
  const maxIterations = input.maxIterations ?? 8;
  const maxToolCalls = input.trigger === "HUMAN_MESSAGE"
    || input.trigger === "HUMAN_HYPOTHESIS"
    ? Math.min(input.maxToolCalls ?? 3, 3)
    : input.maxToolCalls ?? 10;
  const initialAggregate = await store.getAggregate(input.runId);
  const initialToolCallCount = initialAggregate?.toolCalls.filter((call) =>
    call.proposedActionId === null).length ?? 0;
  let emptyEvidenceRounds = 0;

  for (let localRound = 0; localRound < maxIterations; localRound += 1) {
    const aggregate = await store.getAggregate(input.runId);
    if (!aggregate) throw new Error("InvestigationRun 不存在。");
    if (aggregate.run.status !== "RUNNING") return aggregate;
    const investigationCalls = aggregate.toolCalls.filter((call) => call.proposedActionId === null);
    const callsThisInvocation = investigationCalls.length - initialToolCallCount;
    if (callsThisInvocation >= maxToolCalls) {
      await stopInconclusive(
        store,
        input.runId,
        "MAX_TOOL_CALLS",
        "已达到本次调查工具预算，当前证据不足以继续。",
      );
      return store.getAggregate(input.runId);
    }

    const now = new Date().toISOString();
    const iteration: AgentIteration = {
      id: createId("AI"),
      runId: input.runId,
      sequence: aggregate.run.currentIteration + 1,
      trigger: localRound === 0 ? input.trigger ?? "INITIAL" : "INITIAL",
      plannerType: input.planner.type,
      status: "RUNNING",
      decisionType: null,
      publicRationale: null,
      startedAt: now,
      completedAt: null,
    };
    const claimed = await store.claimIteration(iteration, aggregate.run.lockVersion);
    if (!claimed) throw new Error("RUN_BUSY");

    try {
      const current = await store.getAggregate(input.runId);
      if (!current) throw new Error("InvestigationRun 不存在。");
      const decision = await input.planner.plan({
        aggregate: current,
        trigger: iteration.trigger,
        humanMessage: input.humanMessage ?? null,
        remainingIterations: maxIterations - localRound,
        remainingToolCalls: maxToolCalls - callsThisInvocation,
      });
      const traceSequence = (current.traceEvents.at(-1)?.sequence ?? 0) + 1;
      await store.saveTraceEvents([
        trace(
          input.runId,
          iteration.id,
          traceSequence,
          "PLANNER_DECISION",
          "AGENT",
          decision.rationale,
          { decisionType: decision.type },
        ),
      ]);

      if (decision.type === "CALL_TOOL") {
        const signature = createToolSignature(decision.toolName, decision.arguments);
        const duplicate = current.toolCalls.find((call) =>
          call.proposedActionId === null && call.canonicalSignature === signature);
        if (duplicate) {
          await store.completeIteration(
            iteration.id,
            "COMPLETED",
            decision.type,
            decision.rationale,
            new Date().toISOString(),
          );
          await stopInconclusive(
            store,
            input.runId,
            "DUPLICATE_TOOL_CALL",
            `已阻止重复调用 ${decision.toolName}，避免无效循环。`,
          );
          return store.getAggregate(input.runId);
        }

        if (decision.hypothesisDrafts?.length) {
          const hypotheses: Hypothesis[] = decision.hypothesisDrafts.map((draft) => ({
            id: createId("HYP"),
            runId: input.runId,
            revision: current.run.currentDiagnosisRevision + 1,
            statement: draft.statement.trim().slice(0, 2_000),
            status: "ACTIVE",
            confidence: "LOW",
            supportScore: 0,
            contradictionScore: 0,
            confidenceReason: "等待工具证据验证",
            createdBy: "AGENT",
            createdAt: now,
            updatedAt: now,
          }));
          await store.saveHypotheses(hypotheses);
        }

        const recorded = await executeAndRecordTool(store, {
          runId: input.runId,
          name: decision.toolName,
          args: decision.arguments,
          iteration: iteration.sequence,
          order: investigationCalls.length + 1,
          analytics: input.analytics,
          agentIterationId: iteration.id,
          triggerMessageId: input.triggerMessageId ?? null,
          feedbackRetriever: input.feedbackRetriever,
          incidentRetriever: input.incidentRetriever,
        });
        const afterTool = await store.getAggregate(input.runId);
        const primary = afterTool?.hypotheses.find((item) =>
          item.status !== "REJECTED" && item.revision === afterTool.run.currentDiagnosisRevision + 1);
        if (primary && recorded.evidence.length > 0) {
          const links: HypothesisEvidenceLink[] = recorded.evidence.map((item) => ({
            id: createId("HEL"),
            runId: input.runId,
            hypothesisId: primary.id,
            evidenceId: item.id,
            relation: "SUPPORTS",
            explanation: item.category === "SIMILAR_INCIDENT"
              ? "历史事故与当前症状相似，仅作为辅助模式证据。"
              : "该工具结果与当前根因假设方向一致。",
            linkedBy: "RUNTIME",
            createdAt: new Date().toISOString(),
          }));
          await store.saveHypothesisEvidenceLinks(links);
          const refreshed = await store.getAggregate(input.runId);
          const relevantLinks = refreshed?.hypothesisEvidenceLinks.filter((item) =>
            item.hypothesisId === primary.id) ?? links;
          const calculated = calculateHypothesisConfidence(refreshed?.evidence ?? [], relevantLinks);
          await store.updateHypothesis({
            ...primary,
            ...calculated,
            updatedAt: new Date().toISOString(),
          });
          emptyEvidenceRounds = 0;
        } else {
          emptyEvidenceRounds += 1;
        }
        await store.completeIteration(
          iteration.id,
          "COMPLETED",
          decision.type,
          decision.rationale,
          new Date().toISOString(),
        );
        if (emptyEvidenceRounds >= 3) {
          await stopInconclusive(
            store,
            input.runId,
            "NO_NEW_EVIDENCE",
            "连续三轮未产生新证据，调查安全停止。",
          );
          return store.getAggregate(input.runId);
        }
        continue;
      }

      if (decision.type === "ASK_HUMAN") {
        await store.saveTraceEvents([
          trace(
            input.runId,
            iteration.id,
            traceSequence + 1,
            "HUMAN_INPUT_REQUESTED",
            "AGENT",
            decision.question,
          ),
        ]);
        await store.completeIteration(
          iteration.id,
          "PAUSED",
          decision.type,
          decision.rationale,
          new Date().toISOString(),
        );
        await store.transitionRun(input.runId, "WAITING_HUMAN_INPUT");
        return store.getAggregate(input.runId);
      }

      if (decision.type === "FINALIZE") {
        await store.completeIteration(
          iteration.id,
          "COMPLETED",
          decision.type,
          decision.rationale,
          new Date().toISOString(),
        );
        const beforeFinal = await store.getAggregate(input.runId);
        const primary = beforeFinal?.hypotheses
          .filter((item) => item.status !== "REJECTED")
          .sort((left, right) => right.supportScore - left.supportScore)[0];
        const diagnosis = {
          ...decision.diagnosis,
          confidence: primary?.confidence ?? decision.diagnosis.confidence,
        };
        await finalizeInvestigation(store, {
          runId: input.runId,
          diagnosis,
          totalTokens: beforeFinal?.run.totalTokens ?? 0,
          evidenceCount: beforeFinal?.evidence.length ?? 0,
        });
        return store.getAggregate(input.runId);
      }

      await store.completeIteration(
        iteration.id,
        "COMPLETED",
        decision.type,
        decision.rationale,
        new Date().toISOString(),
      );
      await stopInconclusive(
        store,
        input.runId,
        "PLANNER_STOPPED",
        decision.rationale || decision.reason,
      );
      return store.getAggregate(input.runId);
    } catch (error) {
      await store.completeIteration(
        iteration.id,
        "FAILED",
        null,
        error instanceof Error ? error.message : "Planner 运行失败",
        new Date().toISOString(),
      );
      await markInvestigationFailed(
        store,
        input.runId,
        error instanceof Error ? error.message : "Planner 运行失败",
      );
      throw error;
    }
  }

  await stopInconclusive(
    store,
    input.runId,
    "MAX_ITERATIONS",
    "已达到最大调查轮数，当前证据不足以继续。",
  );
  return store.getAggregate(input.runId);
}
