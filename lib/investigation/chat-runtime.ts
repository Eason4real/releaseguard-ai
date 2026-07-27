import type { AnalyticsStore } from "../analytics/store";
import { runAgentLoop } from "./agent-loop";
import type { InvestigationPlanner } from "./planner";
import type { Phase3InvestigationStore } from "./phase3-store";
import type {
  Hypothesis,
  InvestigationMessage,
  InvestigationMessageIntent,
  InvestigationTraceEvent,
} from "./types";
import type { FeedbackRetriever, IncidentRetriever } from "../retrieval/types";

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export class InvestigationChatError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function submitInvestigationMessage(
  store: Phase3InvestigationStore,
  input: {
    runId: string;
    clientRequestId: string;
    intent: InvestigationMessageIntent;
    content: string;
    citedEvidenceIds?: string[];
    planner?: InvestigationPlanner;
    analytics?: AnalyticsStore;
    feedbackRetriever?: FeedbackRetriever;
    incidentRetriever?: IncidentRetriever;
  },
) {
  const aggregate = await store.getAggregate(input.runId);
  if (!aggregate) throw new InvestigationChatError("RUN_NOT_FOUND", "调查不存在。", 404);
  if (aggregate.run.status === "WAITING_VERIFICATION" || aggregate.run.status === "CLOSED_NO_ACTION") {
    throw new InvestigationChatError("RUN_READ_ONLY", "该调查已经进入只读终态。", 409);
  }
  if (aggregate.run.status === "WAITING_APPROVAL" && input.intent !== "EXPLAIN") {
    throw new InvestigationChatError(
      "CONTINUE_REQUIRED",
      "当前结论已提交审批。请先使用“继续调查”撤回当前审批快照。",
      409,
    );
  }
  const content = input.content.trim().slice(0, 4_000);
  if (!content) throw new InvestigationChatError("MESSAGE_EMPTY", "消息不能为空。", 400);
  const cited = [...new Set(input.citedEvidenceIds ?? [])].slice(0, 20);
  const evidenceIds = new Set(aggregate.evidence.map((item) => item.id));
  if (cited.some((id) => !evidenceIds.has(id))) {
    throw new InvestigationChatError("INVALID_EVIDENCE_CITATION", "消息引用了不属于当前 Run 的证据。", 400);
  }

  const now = new Date().toISOString();
  const message: InvestigationMessage = {
    id: createId("MSG"),
    runId: input.runId,
    clientRequestId: input.clientRequestId,
    role: "USER",
    intent: input.intent,
    content,
    citedEvidenceIds: cited,
    createdAt: now,
  };
  const inserted = await store.saveMessage(message);
  if (!inserted) return store.getAggregate(input.runId);

  const traceSequence = (aggregate.traceEvents.at(-1)?.sequence ?? 0) + 1;
  const trace: InvestigationTraceEvent = {
    id: createId("ITE"),
    runId: input.runId,
    iterationId: null,
    sequence: traceSequence,
    type: "HUMAN_MESSAGE_RECEIVED",
    actor: "HUMAN",
    publicSummary: content,
    details: { intent: input.intent, citedEvidenceIds: cited },
    createdAt: now,
  };
  await store.saveTraceEvents([trace]);

  if (input.intent === "EXPLAIN") {
    const selected = cited.length > 0
      ? aggregate.evidence.filter((item) => cited.includes(item.id))
      : aggregate.evidence.slice(-4);
    const answer = selected.length > 0
      ? `当前判断主要基于：${selected.map((item) => `[${item.id}] ${item.statement}`).join("；")}。这些是可审计证据，不代表所有未验证主张都已成立。`
      : "当前还没有足够的结构化证据可以解释，请选择“继续调查”让 Agent 调用工具补充证据。";
    await store.saveMessage({
      id: createId("MSG"),
      runId: input.runId,
      clientRequestId: `${input.clientRequestId}:assistant`,
      role: "ASSISTANT",
      intent: "EXPLAIN",
      content: answer,
      citedEvidenceIds: selected.map((item) => item.id),
      createdAt: new Date().toISOString(),
    });
    return store.getAggregate(input.runId);
  }

  if (input.intent === "ADD_HYPOTHESIS") {
    const hypothesis: Hypothesis = {
      id: createId("HYP"),
      runId: input.runId,
      revision: aggregate.run.currentDiagnosisRevision + 1,
      statement: content,
      status: "ACTIVE",
      confidence: "LOW",
      supportScore: 0,
      contradictionScore: 0,
      confidenceReason: "产品经理提出，等待工具证据验证",
      createdBy: "HUMAN",
      createdAt: now,
      updatedAt: now,
    };
    await store.saveHypotheses([hypothesis]);
  }

  if (!input.planner) {
    throw new InvestigationChatError("PLANNER_REQUIRED", "调查型消息需要可用的 Planner。", 503);
  }
  if (aggregate.run.status === "WAITING_HUMAN_INPUT") {
    await store.transitionRun(input.runId, "RUNNING");
  }
  return runAgentLoop(store, {
    runId: input.runId,
    planner: input.planner,
    analytics: input.analytics,
    trigger: input.intent === "ADD_HYPOTHESIS" ? "HUMAN_HYPOTHESIS" : "HUMAN_MESSAGE",
    humanMessage: content,
    triggerMessageId: message.id,
    maxToolCalls: 3,
    feedbackRetriever: input.feedbackRetriever,
    incidentRetriever: input.incidentRetriever,
  });
}
