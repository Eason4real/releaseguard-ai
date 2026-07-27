import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  agentIterations,
  approvalSnapshots,
  approvals,
  auditEvents,
  diagnoses,
  diagnosisEvidenceLinks,
  evidence,
  hypotheses,
  hypothesisEvidenceLinks,
  investigationMessages,
  investigationRuns,
  investigationTraceEvents,
  proposedActions,
  runtimeCommands,
  toolCalls,
  toolResults,
} from "@/db/schema";
import { assertRunTransition } from "./state";
import { D1AnalyticsStore } from "../analytics/repository";
import type { InvestigationStore, RunTransitionPatch } from "./store";
import type { Phase3InvestigationStore } from "./phase3-store";
import type {
  Approval,
  ApprovalSnapshot,
  ApprovalStatus,
  AuditEvent,
  AuditEventType,
  Confidence,
  Diagnosis,
  DiagnosisEvidenceLink,
  Evidence,
  EvidenceStrength,
  InvestigationAggregate,
  InvestigationMessage,
  InvestigationRun,
  InvestigationRunStatus,
  ProposedAction,
  Severity,
  ToolCall,
  ToolCallStatus,
  ToolResult,
  ToolResultStatus,
  AgentIteration,
  Hypothesis,
  HypothesisEvidenceLink,
  InvestigationTraceEvent,
} from "./types";

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const mapRun = (row: typeof investigationRuns.$inferSelect): InvestigationRun => ({
  id: row.id,
  incidentId: row.incidentId,
  riskEventId: row.riskEventId,
  releaseId: row.releaseId,
  question: row.question,
  provider: row.provider,
  model: row.model,
  plannerType: row.plannerType as InvestigationRun["plannerType"],
  status: row.status as InvestigationRunStatus,
  currentIteration: row.currentIteration,
  activeIterationId: row.activeIterationId,
  lockVersion: row.lockVersion,
  stopReason: row.stopReason as InvestigationRun["stopReason"],
  currentDiagnosisRevision: row.currentDiagnosisRevision,
  totalTokens: row.totalTokens,
  errorMessage: row.errorMessage,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapToolCall = (row: typeof toolCalls.$inferSelect): ToolCall => ({
  id: row.id,
  runId: row.runId,
  name: row.name,
  arguments: parseJson(row.argumentsJson, {}),
  canonicalSignature: row.canonicalSignature,
  status: row.status as ToolCallStatus,
  proposedActionId: row.proposedActionId,
  approvalId: row.approvalId,
  agentIterationId: row.agentIterationId,
  triggerMessageId: row.triggerMessageId,
  cacheSourceToolCallId: row.cacheSourceToolCallId,
  iteration: row.iteration,
  order: row.orderIndex,
  resultId: row.resultId,
  requestedAt: row.requestedAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

const mapToolResult = (row: typeof toolResults.$inferSelect): ToolResult => ({
  id: row.id,
  runId: row.runId,
  toolCallId: row.toolCallId,
  status: row.status as ToolResultStatus,
  output: parseJson(row.outputJson, null),
  errorMessage: row.errorMessage,
  retryable: row.retryable,
  createdAt: row.createdAt,
});

const mapEvidence = (row: typeof evidence.$inferSelect): Evidence => ({
  id: row.id,
  runId: row.runId,
  toolResultId: row.toolResultId,
  category: row.category,
  statement: row.statement,
  source: row.source,
  strength: row.strength as EvidenceStrength,
  provenance: row.provenance as Evidence["provenance"],
  collectedAt: row.collectedAt,
});

const mapDiagnosis = (row: typeof diagnoses.$inferSelect): Diagnosis => ({
  id: row.id,
  runId: row.runId,
  rootCause: row.rootCause,
  summary: row.summary,
  causalChain: parseJson(row.causalChainJson, []),
  affectedMetrics: parseJson(row.affectedMetricsJson, []),
  affectedSegments: parseJson(row.affectedSegmentsJson, []),
  validatedClaims: parseJson(row.validatedClaimsJson, []),
  unvalidatedClaims: parseJson(row.unvalidatedClaimsJson, []),
  confidence: row.confidence as Confidence,
  severity: row.severity as Severity,
  recommendedAction: row.recommendedAction,
  revision: row.revision,
  status: row.status as Diagnosis["status"],
  supersedesDiagnosisId: row.supersedesDiagnosisId,
  supersededAt: row.supersededAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt || row.createdAt,
});

const mapAction = (row: typeof proposedActions.$inferSelect): ProposedAction => ({
  id: row.id,
  runId: row.runId,
  diagnosisId: row.diagnosisId,
  type: row.type as ProposedAction["type"],
  status: row.status as ProposedAction["status"],
  title: row.title,
  arguments: parseJson(row.argumentsJson, {}),
  rationale: row.rationale,
  revision: row.revision,
  supersedesProposedActionId: row.supersedesProposedActionId,
  supersededAt: row.supersededAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapApproval = (row: typeof approvals.$inferSelect): Approval => ({
  id: row.id,
  runId: row.runId,
  proposedActionId: row.proposedActionId,
  status: row.status as ApprovalStatus,
  decision: row.decision as Approval["decision"],
  reason: row.reason,
  requestedBy: row.requestedBy,
  decidedBy: row.decidedBy,
  targetOwner: row.targetOwner,
  targetRepo: row.targetRepo,
  revision: row.revision,
  supersedesApprovalId: row.supersedesApprovalId,
  withdrawnAt: row.withdrawnAt,
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
});

const mapAuditEvent = (row: typeof auditEvents.$inferSelect): AuditEvent => ({
  id: row.id,
  runId: row.runId,
  proposedActionId: row.proposedActionId,
  approvalId: row.approvalId,
  toolCallId: row.toolCallId,
  type: row.type as AuditEventType,
  actor: row.actor,
  details: parseJson(row.detailsJson, {}),
  createdAt: row.createdAt,
});

const mapIteration = (row: typeof agentIterations.$inferSelect): AgentIteration => ({
  id: row.id,
  runId: row.runId,
  sequence: row.sequence,
  trigger: row.trigger as AgentIteration["trigger"],
  plannerType: row.plannerType as AgentIteration["plannerType"],
  status: row.status as AgentIteration["status"],
  decisionType: row.decisionType as AgentIteration["decisionType"],
  publicRationale: row.publicRationale,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

const mapHypothesis = (row: typeof hypotheses.$inferSelect): Hypothesis => ({
  id: row.id,
  runId: row.runId,
  revision: row.revision,
  statement: row.statement,
  status: row.status as Hypothesis["status"],
  confidence: row.confidence as Confidence,
  supportScore: row.supportScore,
  contradictionScore: row.contradictionScore,
  confidenceReason: row.confidenceReason,
  createdBy: row.createdBy as Hypothesis["createdBy"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapHypothesisLink = (
  row: typeof hypothesisEvidenceLinks.$inferSelect,
): HypothesisEvidenceLink => ({
  id: row.id,
  runId: row.runId,
  hypothesisId: row.hypothesisId,
  evidenceId: row.evidenceId,
  relation: row.relation as HypothesisEvidenceLink["relation"],
  explanation: row.explanation,
  linkedBy: row.linkedBy as HypothesisEvidenceLink["linkedBy"],
  createdAt: row.createdAt,
});

const mapTraceEvent = (
  row: typeof investigationTraceEvents.$inferSelect,
): InvestigationTraceEvent => ({
  id: row.id,
  runId: row.runId,
  iterationId: row.iterationId,
  sequence: row.sequence,
  type: row.type,
  actor: row.actor as InvestigationTraceEvent["actor"],
  publicSummary: row.publicSummary,
  details: parseJson(row.detailsJson, {}),
  createdAt: row.createdAt,
});

const mapMessage = (row: typeof investigationMessages.$inferSelect): InvestigationMessage => ({
  id: row.id,
  runId: row.runId,
  clientRequestId: row.clientRequestId,
  role: row.role as InvestigationMessage["role"],
  intent: row.intent as InvestigationMessage["intent"],
  content: row.content,
  citedEvidenceIds: parseJson(row.citedEvidenceIdsJson, []),
  createdAt: row.createdAt,
});

const mapDiagnosisLink = (
  row: typeof diagnosisEvidenceLinks.$inferSelect,
): DiagnosisEvidenceLink => ({
  id: row.id,
  runId: row.runId,
  diagnosisId: row.diagnosisId,
  evidenceId: row.evidenceId,
  relationship: row.relationship as DiagnosisEvidenceLink["relationship"],
  createdAt: row.createdAt,
});

const mapApprovalSnapshot = (
  row: typeof approvalSnapshots.$inferSelect,
): ApprovalSnapshot => ({
  id: row.id,
  approvalId: row.approvalId,
  runId: row.runId,
  diagnosisId: row.diagnosisId,
  proposedActionId: row.proposedActionId,
  revision: row.revision,
  frozenPayload: parseJson(row.frozenPayloadJson, {}),
  checksum: row.checksum,
  lifecycleStatus: row.lifecycleStatus as ApprovalSnapshot["lifecycleStatus"],
  createdAt: row.createdAt,
  withdrawnAt: row.withdrawnAt,
});

export class D1InvestigationStore implements InvestigationStore, Phase3InvestigationStore {
  async createRun(run: InvestigationRun) {
    await (await getDb()).insert(investigationRuns).values(run);
  }

  async transitionRun(
    runId: string,
    to: InvestigationRunStatus,
    patch: RunTransitionPatch = {},
  ) {
    const db = await getDb();
    const current = await db
      .select({ status: investigationRuns.status })
      .from(investigationRuns)
      .where(eq(investigationRuns.id, runId))
      .limit(1);
    if (!current[0]) throw new Error(`InvestigationRun not found: ${runId}`);
    const from = current[0].status as InvestigationRunStatus;
    assertRunTransition(from, to);
    const updatedAt = new Date().toISOString();
    const result = await db
      .update(investigationRuns)
      .set({ status: to, updatedAt, ...patch })
      .where(and(eq(investigationRuns.id, runId), eq(investigationRuns.status, from)))
      .returning({ id: investigationRuns.id });
    if (!result[0]) throw new Error(`InvestigationRun transition raced: ${runId}`);
    await this.saveAuditEvents([{
      id: `AE-${crypto.randomUUID()}`,
      runId,
      proposedActionId: null,
      approvalId: null,
      toolCallId: null,
      type: "RUN_STATE_CHANGED",
      actor: "ReleaseGuard Runtime",
      details: { from, to },
      createdAt: updatedAt,
    }]);
  }

  async createToolCall(call: ToolCall) {
    await (await getDb()).insert(toolCalls).values({
      id: call.id,
      runId: call.runId,
      name: call.name,
      argumentsJson: JSON.stringify(call.arguments),
      canonicalSignature: call.canonicalSignature,
      status: call.status,
      proposedActionId: call.proposedActionId,
      approvalId: call.approvalId,
      agentIterationId: call.agentIterationId,
      triggerMessageId: call.triggerMessageId,
      cacheSourceToolCallId: call.cacheSourceToolCallId,
      iteration: call.iteration,
      orderIndex: call.order,
      resultId: call.resultId,
      requestedAt: call.requestedAt,
      startedAt: call.startedAt,
      completedAt: call.completedAt,
    });
  }

  async markToolCallRunning(callId: string, startedAt: string) {
    await (await getDb())
      .update(toolCalls)
      .set({ status: "RUNNING", startedAt })
      .where(eq(toolCalls.id, callId));
  }

  async completeToolCall(callId: string, result: ToolResult, completedAt: string) {
    const db = await getDb();
    await db.insert(toolResults).values({
      id: result.id,
      runId: result.runId,
      toolCallId: result.toolCallId,
      status: result.status,
      outputJson: result.output === null ? null : JSON.stringify(result.output),
      errorMessage: result.errorMessage,
      retryable: result.retryable,
      createdAt: result.createdAt,
    });
    await db
      .update(toolCalls)
      .set({
        status: "COMPLETED",
        resultId: result.id,
        completedAt,
      })
      .where(eq(toolCalls.id, callId));
  }

  async saveEvidence(items: Evidence[]) {
    if (items.length === 0) return;
    await (await getDb()).insert(evidence).values(items);
  }

  async saveDiagnosis(diagnosis: Diagnosis) {
    await (await getDb()).insert(diagnoses).values({
      id: diagnosis.id,
      runId: diagnosis.runId,
      rootCause: diagnosis.rootCause,
      summary: diagnosis.summary,
      causalChainJson: JSON.stringify(diagnosis.causalChain),
      affectedMetricsJson: JSON.stringify(diagnosis.affectedMetrics),
      affectedSegmentsJson: JSON.stringify(diagnosis.affectedSegments),
      validatedClaimsJson: JSON.stringify(diagnosis.validatedClaims),
      unvalidatedClaimsJson: JSON.stringify(diagnosis.unvalidatedClaims),
      confidence: diagnosis.confidence,
      severity: diagnosis.severity,
      recommendedAction: diagnosis.recommendedAction,
      revision: diagnosis.revision,
      status: diagnosis.status,
      supersedesDiagnosisId: diagnosis.supersedesDiagnosisId,
      supersededAt: diagnosis.supersededAt,
      createdAt: diagnosis.createdAt,
      updatedAt: diagnosis.updatedAt,
    });
  }

  async saveProposedAction(action: ProposedAction) {
    await (await getDb()).insert(proposedActions).values({
      id: action.id,
      runId: action.runId,
      diagnosisId: action.diagnosisId,
      type: action.type,
      status: action.status,
      title: action.title,
      argumentsJson: JSON.stringify(action.arguments),
      rationale: action.rationale,
      revision: action.revision,
      supersedesProposedActionId: action.supersedesProposedActionId,
      supersededAt: action.supersededAt,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
    });
  }

  async saveApproval(approval: Approval) {
    await (await getDb()).insert(approvals).values(approval);
  }

  async saveAuditEvents(events: AuditEvent[]) {
    if (events.length === 0) return;
    await (await getDb()).insert(auditEvents).values(events.map((event) => ({
      id: event.id,
      runId: event.runId,
      proposedActionId: event.proposedActionId,
      approvalId: event.approvalId,
      toolCallId: event.toolCallId,
      type: event.type,
      actor: event.actor,
      detailsJson: JSON.stringify(event.details),
      createdAt: event.createdAt,
    })));
  }

  async decideApproval(
    approvalId: string,
    decision: "APPROVE" | "REJECT",
    patch: {
      reason: string | null;
      decidedBy: string;
      targetOwner: string | null;
      targetRepo: string | null;
      decidedAt: string;
    },
  ) {
    const rows = await (await getDb())
      .update(approvals)
      .set({
        status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
        decision,
        reason: patch.reason,
        decidedBy: patch.decidedBy,
        targetOwner: patch.targetOwner,
        targetRepo: patch.targetRepo,
        decidedAt: patch.decidedAt,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "PENDING")))
      .returning({ id: approvals.id });
    return Boolean(rows[0]);
  }

  async updateProposedActionStatus(
    actionId: string,
    from: ProposedAction["status"],
    to: ProposedAction["status"],
  ) {
    const rows = await (await getDb())
      .update(proposedActions)
      .set({ status: to, updatedAt: new Date().toISOString() })
      .where(and(eq(proposedActions.id, actionId), eq(proposedActions.status, from)))
      .returning({ id: proposedActions.id });
    return Boolean(rows[0]);
  }

  async updateActionToolCall(
    callId: string,
    from: ToolCall["status"],
    to: ToolCall["status"],
    patch: {
      approvalId?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    } = {},
  ) {
    const rows = await (await getDb())
      .update(toolCalls)
      .set({ status: to, ...patch })
      .where(and(eq(toolCalls.id, callId), eq(toolCalls.status, from)))
      .returning({ id: toolCalls.id });
    return Boolean(rows[0]);
  }

  async completeActionToolCall(
    callId: string,
    from: ToolCall["status"],
    result: ToolResult,
    completedAt: string,
  ) {
    const db = await getDb();
    const changed = await db
      .update(toolCalls)
      .set({
        status: result.status === "SUCCESS" ? "SUCCESS" : "ERROR",
        resultId: result.id,
        completedAt,
      })
      .where(and(eq(toolCalls.id, callId), eq(toolCalls.status, from)))
      .returning({ id: toolCalls.id });
    if (!changed[0]) return false;
    await db.insert(toolResults).values({
      id: result.id,
      runId: result.runId,
      toolCallId: result.toolCallId,
      status: result.status,
      outputJson: result.output === null ? null : JSON.stringify(result.output),
      errorMessage: result.errorMessage,
      retryable: result.retryable,
      createdAt: result.createdAt,
    });
    return true;
  }

  async claimIteration(iteration: AgentIteration, expectedLockVersion: number) {
    const db = await getDb();
    const claimed = await db
      .update(investigationRuns)
      .set({
        activeIterationId: iteration.id,
        currentIteration: iteration.sequence,
        lockVersion: expectedLockVersion + 1,
        updatedAt: iteration.startedAt,
      })
      .where(and(
        eq(investigationRuns.id, iteration.runId),
        eq(investigationRuns.status, "RUNNING"),
        eq(investigationRuns.lockVersion, expectedLockVersion),
        isNull(investigationRuns.activeIterationId),
      ))
      .returning({ id: investigationRuns.id });
    if (!claimed[0]) return false;
    await db.insert(agentIterations).values({
      id: iteration.id,
      runId: iteration.runId,
      sequence: iteration.sequence,
      trigger: iteration.trigger,
      plannerType: iteration.plannerType,
      status: iteration.status,
      decisionType: iteration.decisionType,
      publicRationale: iteration.publicRationale,
      startedAt: iteration.startedAt,
      completedAt: iteration.completedAt,
    });
    return true;
  }

  async completeIteration(
    iterationId: string,
    status: AgentIteration["status"],
    decisionType: AgentIteration["decisionType"],
    publicRationale: string | null,
    completedAt: string,
  ) {
    const db = await getDb();
    const rows = await db
      .update(agentIterations)
      .set({ status, decisionType, publicRationale, completedAt })
      .where(eq(agentIterations.id, iterationId))
      .returning({ runId: agentIterations.runId });
    if (rows[0]) {
      await db
        .update(investigationRuns)
        .set({ activeIterationId: null, updatedAt: completedAt })
        .where(and(
          eq(investigationRuns.id, rows[0].runId),
          eq(investigationRuns.activeIterationId, iterationId),
        ));
    }
  }

  async saveHypotheses(items: Hypothesis[]) {
    if (items.length === 0) return;
    await (await getDb()).insert(hypotheses).values(items);
  }

  async updateHypothesis(item: Hypothesis) {
    await (await getDb())
      .update(hypotheses)
      .set({
        status: item.status,
        confidence: item.confidence,
        supportScore: item.supportScore,
        contradictionScore: item.contradictionScore,
        confidenceReason: item.confidenceReason,
        updatedAt: item.updatedAt,
      })
      .where(eq(hypotheses.id, item.id));
  }

  async saveHypothesisEvidenceLinks(items: HypothesisEvidenceLink[]) {
    if (items.length === 0) return;
    await (await getDb()).insert(hypothesisEvidenceLinks).values(items).onConflictDoNothing();
  }

  async saveTraceEvents(items: InvestigationTraceEvent[]) {
    if (items.length === 0) return;
    await (await getDb()).insert(investigationTraceEvents).values(items.map((item) => ({
      id: item.id,
      runId: item.runId,
      iterationId: item.iterationId,
      sequence: item.sequence,
      type: item.type,
      actor: item.actor,
      publicSummary: item.publicSummary,
      detailsJson: JSON.stringify(item.details),
      createdAt: item.createdAt,
    })));
  }

  async saveMessage(message: InvestigationMessage) {
    const result = await (await getDb()).insert(investigationMessages).values({
      id: message.id,
      runId: message.runId,
      clientRequestId: message.clientRequestId,
      role: message.role,
      intent: message.intent,
      content: message.content,
      citedEvidenceIdsJson: JSON.stringify(message.citedEvidenceIds),
      createdAt: message.createdAt,
    }).onConflictDoNothing().returning({ id: investigationMessages.id });
    return Boolean(result[0]);
  }

  async saveDiagnosisEvidenceLinks(items: DiagnosisEvidenceLink[]) {
    if (items.length === 0) return;
    await (await getDb()).insert(diagnosisEvidenceLinks).values(items).onConflictDoNothing();
  }

  async saveApprovalSnapshot(snapshot: ApprovalSnapshot) {
    await (await getDb()).insert(approvalSnapshots).values({
      id: snapshot.id,
      approvalId: snapshot.approvalId,
      runId: snapshot.runId,
      diagnosisId: snapshot.diagnosisId,
      proposedActionId: snapshot.proposedActionId,
      revision: snapshot.revision,
      frozenPayloadJson: JSON.stringify(snapshot.frozenPayload),
      checksum: snapshot.checksum,
      lifecycleStatus: snapshot.lifecycleStatus,
      createdAt: snapshot.createdAt,
      withdrawnAt: snapshot.withdrawnAt,
    });
  }

  async recordRuntimeCommand(input: {
    id: string;
    runId: string;
    clientRequestId: string;
    commandType: string;
    resultReference: string | null;
    createdAt: string;
  }) {
    const rows = await (await getDb()).insert(runtimeCommands).values(input)
      .onConflictDoNothing()
      .returning({ id: runtimeCommands.id });
    return Boolean(rows[0]);
  }

  async withdrawPendingRevision(input: {
    runId: string;
    approvalId: string;
    proposedActionId: string;
    actionToolCallId: string;
    snapshotId: string | null;
    now: string;
  }) {
    const db = await getDb();
    const approvalRows = await db.update(approvals)
      .set({ status: "WITHDRAWN", withdrawnAt: input.now, reason: "继续调查，撤回当前审批快照" })
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.status, "PENDING")))
      .returning({ id: approvals.id });
    if (!approvalRows[0]) return false;
    const actionRows = await db.update(proposedActions)
      .set({ status: "SUPERSEDED", supersededAt: input.now, updatedAt: input.now })
      .where(and(
        eq(proposedActions.id, input.proposedActionId),
        eq(proposedActions.status, "PENDING_APPROVAL"),
      ))
      .returning({ id: proposedActions.id });
    const callRows = await db.update(toolCalls)
      .set({ status: "CANCELLED", completedAt: input.now })
      .where(and(
        eq(toolCalls.id, input.actionToolCallId),
        eq(toolCalls.status, "WAITING_APPROVAL"),
      ))
      .returning({ id: toolCalls.id });
    if (input.snapshotId) {
      await db.update(approvalSnapshots)
        .set({ lifecycleStatus: "WITHDRAWN", withdrawnAt: input.now })
        .where(and(
          eq(approvalSnapshots.id, input.snapshotId),
          eq(approvalSnapshots.lifecycleStatus, "ACTIVE"),
        ));
    }
    return Boolean(actionRows[0] && callRows[0]);
  }

  async getAggregate(runId: string) {
    const db = await getDb();
    const runRows = await db
      .select()
      .from(investigationRuns)
      .where(eq(investigationRuns.id, runId))
      .limit(1);
    if (!runRows[0]) return null;
    return this.loadAggregate(mapRun(runRows[0]));
  }

  async getLatestAggregate() {
    const rows = await (await getDb())
      .select()
      .from(investigationRuns)
      .orderBy(desc(investigationRuns.createdAt))
      .limit(1);
    if (!rows[0]) return null;
    return this.loadAggregate(mapRun(rows[0]));
  }

  private async loadAggregate(run: InvestigationRun): Promise<InvestigationAggregate> {
    const db = await getDb();
    const analytics = new D1AnalyticsStore();
    const [
      callRows,
      resultRows,
      evidenceRows,
      diagnosisRows,
      actionRows,
      approvalRows,
      auditRows,
      iterationRows,
      hypothesisRows,
      hypothesisLinkRows,
      traceRows,
      messageRows,
      diagnosisLinkRows,
      snapshotRows,
    ] = await Promise.all([
      db.select().from(toolCalls).where(eq(toolCalls.runId, run.id)).orderBy(asc(toolCalls.orderIndex)),
      db.select().from(toolResults).where(eq(toolResults.runId, run.id)),
      db.select().from(evidence).where(eq(evidence.runId, run.id)).orderBy(asc(evidence.collectedAt)),
      db.select().from(diagnoses).where(eq(diagnoses.runId, run.id)).orderBy(asc(diagnoses.revision)),
      db.select().from(proposedActions).where(eq(proposedActions.runId, run.id)).orderBy(asc(proposedActions.revision)),
      db.select().from(approvals).where(eq(approvals.runId, run.id)).orderBy(asc(approvals.revision)),
      db.select().from(auditEvents).where(eq(auditEvents.runId, run.id)).orderBy(asc(auditEvents.createdAt)),
      db.select().from(agentIterations).where(eq(agentIterations.runId, run.id)).orderBy(asc(agentIterations.sequence)),
      db.select().from(hypotheses).where(eq(hypotheses.runId, run.id)).orderBy(asc(hypotheses.createdAt)),
      db.select().from(hypothesisEvidenceLinks).where(eq(hypothesisEvidenceLinks.runId, run.id)).orderBy(asc(hypothesisEvidenceLinks.createdAt)),
      db.select().from(investigationTraceEvents).where(eq(investigationTraceEvents.runId, run.id)).orderBy(asc(investigationTraceEvents.sequence)),
      db.select().from(investigationMessages).where(eq(investigationMessages.runId, run.id)).orderBy(asc(investigationMessages.createdAt)),
      db.select().from(diagnosisEvidenceLinks).where(eq(diagnosisEvidenceLinks.runId, run.id)).orderBy(asc(diagnosisEvidenceLinks.createdAt)),
      db.select().from(approvalSnapshots).where(eq(approvalSnapshots.runId, run.id)).orderBy(asc(approvalSnapshots.revision)),
    ]);
    const [riskEvent, release] = await Promise.all([
      run.riskEventId ? analytics.getRiskEvent(run.riskEventId) : null,
      run.releaseId ? analytics.getRelease(run.releaseId) : null,
    ]);
    const resultById = new Map(resultRows.map((row) => [row.id, mapToolResult(row)]));
    const mappedDiagnoses = diagnosisRows.map(mapDiagnosis);
    const mappedActions = actionRows.map(mapAction);
    const mappedApprovals = approvalRows.map(mapApproval);
    return {
      run,
      riskEvent,
      release,
      toolCalls: callRows.map((row) => {
        const call = mapToolCall(row);
        return { ...call, result: call.resultId ? resultById.get(call.resultId) ?? null : null };
      }),
      evidence: evidenceRows.map(mapEvidence),
      diagnosis: mappedDiagnoses.at(-1) ?? null,
      diagnoses: mappedDiagnoses,
      proposedAction: mappedActions.at(-1) ?? null,
      proposedActions: mappedActions,
      approval: mappedApprovals.at(-1) ?? null,
      approvals: mappedApprovals,
      auditEvents: auditRows.map(mapAuditEvent),
      iterations: iterationRows.map(mapIteration),
      hypotheses: hypothesisRows.map(mapHypothesis),
      hypothesisEvidenceLinks: hypothesisLinkRows.map(mapHypothesisLink),
      traceEvents: traceRows.map(mapTraceEvent),
      messages: messageRows.map(mapMessage),
      diagnosisEvidenceLinks: diagnosisLinkRows.map(mapDiagnosisLink),
      approvalSnapshots: snapshotRows.map(mapApprovalSnapshot),
    };
  }
}
