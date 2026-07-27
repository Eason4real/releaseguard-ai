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
import {
  assertActiveHypothesisInvariant,
  getActiveHypotheses,
  getPendingEvidence,
  MAX_ACTIVE_HYPOTHESES,
} from "./hypothesis-invariants";

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const boundedText = (value: string, label: string) => {
  const text = value.trim().slice(0, 2_000);
  if (!text) throw new Error(`${label} 不能为空。`);
  return text;
};

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
  const maxIterations = input.maxIterations ?? 16;
  const maxToolCalls = input.trigger === "HUMAN_MESSAGE"
    || input.trigger === "HUMAN_HYPOTHESIS"
    ? Math.min(input.maxToolCalls ?? 3, 3)
    : input.maxToolCalls ?? 10;
  const initialAggregate = await store.getAggregate(input.runId);
  if (!initialAggregate) throw new Error("InvestigationRun 不存在。");
  assertActiveHypothesisInvariant(initialAggregate);
  const initialToolCallCount = initialAggregate?.toolCalls.filter((call) =>
    call.proposedActionId === null).length ?? 0;
  let emptyEvidenceRounds = 0;
  let triggerPending = true;
  const invocationTrigger = input.trigger ?? "INITIAL";

  for (let localRound = 0; localRound < maxIterations; localRound += 1) {
    const aggregate = await store.getAggregate(input.runId);
    if (!aggregate) throw new Error("InvestigationRun 不存在。");
    assertActiveHypothesisInvariant(aggregate);
    if (aggregate.run.status !== "RUNNING") return aggregate;
    const investigationCalls = aggregate.toolCalls.filter((call) => call.proposedActionId === null);
    const callsThisInvocation = investigationCalls.length - initialToolCallCount;
    const now = new Date().toISOString();
    const iteration: AgentIteration = {
      id: createId("AI"),
      runId: input.runId,
      sequence: aggregate.run.currentIteration + 1,
      trigger: triggerPending ? invocationTrigger : "INITIAL",
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
      const decisionTrace = trace(
        input.runId,
        iteration.id,
        traceSequence,
        "PLANNER_DECISION",
        "AGENT",
        decision.rationale,
        { decisionType: decision.type },
      );
      if (decision.type !== "ASSESS_EVIDENCE") {
        await store.saveTraceEvents([decisionTrace]);
      }

      if (decision.type === "CREATE_HYPOTHESES") {
        const existingActive = getActiveHypotheses(current);
        if (
          decision.hypotheses.length === 0
          || existingActive.length + decision.hypotheses.length > MAX_ACTIVE_HYPOTHESES
        ) {
          throw new Error("一个 Run 只能同时存在 1–3 个 Active Hypothesis。");
        }
        const statements = new Set(existingActive.map((item) => item.statement.trim().toLowerCase()));
        const hypotheses: Hypothesis[] = decision.hypotheses.map((draft) => {
          const statement = boundedText(draft.statement, "Hypothesis statement");
          const canonical = statement.toLowerCase();
          if (statements.has(canonical)) throw new Error("Planner 返回了重复 Hypothesis。");
          statements.add(canonical);
          return {
            id: createId("HYP"),
            runId: input.runId,
            revision: current.run.currentDiagnosisRevision + 1,
            statement,
            supportIf: boundedText(draft.supportIf, "Hypothesis supportIf"),
            refuteIf: boundedText(draft.refuteIf, "Hypothesis refuteIf"),
            status: "ACTIVE",
            confidence: "LOW",
            supportScore: 0,
            contradictionScore: 0,
            confidenceReason: "等待显式 Evidence Assessment",
            createdBy: "AGENT",
            createdAt: now,
            updatedAt: now,
          };
        });
        await store.saveHypotheses(hypotheses);
        await store.completeIteration(
          iteration.id,
          "COMPLETED",
          decision.type,
          decision.rationale,
          new Date().toISOString(),
        );
        continue;
      }

      if (decision.type === "ASSESS_EVIDENCE") {
        const assessable = getActiveHypotheses(current);
        const pending = getPendingEvidence(current);
        if (assessable.length === 0) throw new Error("没有可评价的 Active Hypothesis。");
        if (pending.length === 0) throw new Error("没有待评价 Evidence。");

        const pendingIds = new Set(pending.map((item) => item.id));
        const activeIds = new Set(assessable.map((item) => item.id));
        const existingPairs = new Map(current.hypothesisEvidenceLinks.map((item) => [
          `${item.evidenceId}\u0000${item.hypothesisId}`,
          item,
        ]));
        const assessmentEvidenceIds = new Set<string>();
        const links: HypothesisEvidenceLink[] = [];
        for (const assessment of decision.assessments) {
          if (!pendingIds.has(assessment.evidenceId)) {
            throw new Error("Evidence 不属于当前 Run、已经评价或不存在。");
          }
          if (assessmentEvidenceIds.has(assessment.evidenceId)) {
            throw new Error("ASSESS_EVIDENCE 包含重复 Evidence。");
          }
          assessmentEvidenceIds.add(assessment.evidenceId);
          const relationHypothesisIds = new Set<string>();
          for (const relation of assessment.relations) {
            if (!["SUPPORTS", "CONTRADICTS", "NEUTRAL"].includes(relation.relation)) {
              throw new Error("Assessment relation 必须是 SUPPORTS、CONTRADICTS 或 NEUTRAL。");
            }
            if (!activeIds.has(relation.targetHypothesisId)) {
              throw new Error("Assessment 引用了不存在、其他 Run 或已 REJECTED 的 Hypothesis。");
            }
            if (relationHypothesisIds.has(relation.targetHypothesisId)) {
              throw new Error("ASSESS_EVIDENCE 包含重复 Evidence/Hypothesis pair。");
            }
            relationHypothesisIds.add(relation.targetHypothesisId);
            const existing = existingPairs.get(
              `${assessment.evidenceId}\u0000${relation.targetHypothesisId}`,
            );
            if (existing) {
              if (existing.relation !== relation.relation) {
                throw new Error(
                  "ASSESS_EVIDENCE 不能改写已经持久化的 Evidence/Hypothesis relation。",
                );
              }
              continue;
            }
            links.push({
              id: createId("HEL"),
              runId: input.runId,
              hypothesisId: relation.targetHypothesisId,
              evidenceId: assessment.evidenceId,
              relation: relation.relation,
              explanation: boundedText(relation.explanation, "Assessment explanation"),
              linkedBy: "AGENT",
              createdAt: new Date().toISOString(),
            });
          }
          if (
            relationHypothesisIds.size !== activeIds.size
            || [...activeIds].some((id) => !relationHypothesisIds.has(id))
          ) {
            throw new Error("每条 pending Evidence 必须评价所有 Active Hypothesis。");
          }
        }
        if (
          assessmentEvidenceIds.size !== pendingIds.size
          || [...pendingIds].some((id) => !assessmentEvidenceIds.has(id))
        ) {
          throw new Error("一次 ASSESS_EVIDENCE 必须覆盖全部 pending Evidence。");
        }

        const effectiveLinks = [
          ...current.hypothesisEvidenceLinks,
          ...links,
        ];
        const updatedHypotheses = assessable.map((hypothesis) => {
          const relevantLinks = effectiveLinks.filter((item) =>
            item.hypothesisId === hypothesis.id);
          const calculated = calculateHypothesisConfidence(current.evidence, relevantLinks);
          return {
            ...hypothesis,
            ...calculated,
            updatedAt: new Date().toISOString(),
          };
        });
        decisionTrace.details = {
          decisionType: decision.type,
          assessedEvidenceIds: [...pendingIds],
          assessments: decision.assessments,
        };
        await store.commitEvidenceAssessment({
          links,
          hypotheses: updatedHypotheses,
          traceEvent: decisionTrace,
          iterationId: iteration.id,
          rationale: decision.rationale,
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      if (decision.type === "CALL_TOOL") {
        if (getPendingEvidence(current).length > 0) {
          throw new Error("PENDING_EVIDENCE_ASSESSMENT: 必须先评价全部新 Evidence。");
        }
        const assessable = getActiveHypotheses(current);
        const activeIds = new Set(assessable.map((item) => item.id));
        const targetIds = new Set(decision.targetHypothesisIds);
        if (
          targetIds.size === 0
          || targetIds.size !== decision.targetHypothesisIds.length
          || [...targetIds].some((id) => !activeIds.has(id))
          || (decision.testIntent === "DISCRIMINATE" && targetIds.size < 2)
        ) {
          throw new Error("CALL_TOOL 必须引用有效且未拒绝的 targetHypothesisIds。");
        }
        if (callsThisInvocation >= maxToolCalls) {
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
            "MAX_TOOL_CALLS",
            "已达到本次调查工具预算，当前证据不足以继续。",
          );
          return store.getAggregate(input.runId);
        }
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
        triggerPending = false;
        if (recorded.evidence.length > 0) {
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
        if (getPendingEvidence(current).length > 0) {
          throw new Error("PENDING_EVIDENCE_ASSESSMENT: 未评价 Evidence 时不能 FINALIZE。");
        }
        const viableHypotheses = getActiveHypotheses(current);
        if (viableHypotheses.length === 0) {
          throw new Error(
            "NO_ACTIVE_HYPOTHESIS: 所有 Hypothesis 均已 REJECTED，必须创建新假设、询问人工或停止为 INCONCLUSIVE。",
          );
        }
        await store.completeIteration(
          iteration.id,
          "COMPLETED",
          decision.type,
          decision.rationale,
          new Date().toISOString(),
        );
        const beforeFinal = await store.getAggregate(input.runId);
        const primary = viableHypotheses
          .sort((left, right) => right.supportScore - left.supportScore)[0];
        const diagnosis = {
          ...decision.diagnosis,
          confidence: primary.confidence,
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
