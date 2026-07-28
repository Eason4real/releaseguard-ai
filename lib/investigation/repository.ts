import { and, asc, desc, eq, exists, gte, isNull, lt, notExists, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionCompletions,
  agentIterations,
  approvalSnapshots,
  approvals,
  auditEvents,
  diagnoses,
  diagnosisClaimEvidenceLinks,
  diagnosisClaims,
  diagnosisEvidenceLinks,
  evidence,
  feedbackRecords,
  hypotheses,
  hypothesisEvidenceLinks,
  investigationMessages,
  investigationRuns,
  investigationTraceEvents,
  proposedActions,
  runtimeCommands,
  toolCalls,
  toolResults,
  verificationPolicySnapshots,
  verificationRuns,
  verificationEvidence,
  verificationEvaluations,
} from "@/db/schema";
import { assertGenericRunTransition } from "./state";
import { D1AnalyticsStore } from "../analytics/repository";
import type { InvestigationStore, RunTransitionPatch } from "./store";
import {
  assertGroundedFinalizationCommit,
  type GroundedFinalizationCommit,
} from "./phase3-store";
import type {
  ActionCompletionCommit,
  Phase4InvestigationStore,
  VerificationAttemptCommit,
  VerificationEvaluationCommit,
  VerificationReopenCommit,
  VerificationRetryCommit,
} from "./phase4-store";
import type {
  ActionCompletion,
  Approval,
  ApprovalSnapshot,
  ApprovalStatus,
  AuditEvent,
  AuditEventType,
  Confidence,
  Diagnosis,
  DiagnosisClaim,
  DiagnosisClaimEvidenceLink,
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
  VerificationPolicySnapshot,
  VerificationRun,
  VerificationEvidence,
  VerificationEvaluation,
} from "./types";

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const batchChanged = (result: unknown) => {
  if (Array.isArray(result)) return result.length > 0;
  return Boolean((result as { meta?: { changes?: number } } | null)?.meta?.changes);
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
  selectedHypothesisId: row.selectedHypothesisId,
  groundingStatus: row.groundingStatus as Diagnosis["groundingStatus"],
  disposition: row.disposition as Diagnosis["disposition"],
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

const mapDiagnosisClaim = (
  row: typeof diagnosisClaims.$inferSelect,
): DiagnosisClaim => ({
  id: row.id,
  runId: row.runId,
  diagnosisId: row.diagnosisId,
  type: row.type as DiagnosisClaim["type"],
  limitationType: row.limitationType as DiagnosisClaim["limitationType"],
  statement: row.statement,
  groundingStatus: row.groundingStatus as DiagnosisClaim["groundingStatus"],
  createdAt: row.createdAt,
});

const mapDiagnosisClaimEvidenceLink = (
  row: typeof diagnosisClaimEvidenceLinks.$inferSelect,
): DiagnosisClaimEvidenceLink => ({
  id: row.id,
  runId: row.runId,
  diagnosisId: row.diagnosisId,
  claimId: row.claimId,
  evidenceId: row.evidenceId,
  createdAt: row.createdAt,
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
  supportIf: row.supportIf,
  refuteIf: row.refuteIf,
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

const mapActionCompletion = (
  row: typeof actionCompletions.$inferSelect,
): ActionCompletion => ({
  id: row.id,
  runId: row.runId,
  proposedActionId: row.proposedActionId,
  approvalId: row.approvalId,
  diagnosisId: row.diagnosisId,
  revision: row.revision,
  clientRequestId: row.clientRequestId,
  effectiveAt: row.effectiveAt,
  changeReference: row.changeReference,
  note: row.note,
  confirmedBy: row.confirmedBy,
  createdAt: row.createdAt,
});

const mapVerificationRun = (
  row: typeof verificationRuns.$inferSelect,
): VerificationRun => ({
  id: row.id,
  runId: row.runId,
  diagnosisId: row.diagnosisId,
  actionCompletionId: row.actionCompletionId,
  attempt: row.attempt,
  clientRequestId: row.clientRequestId,
  status: row.status as VerificationRun["status"],
  anchorType: row.anchorType as VerificationRun["anchorType"],
  anchorAt: row.anchorAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
});

const mapVerificationPolicySnapshot = (
  row: typeof verificationPolicySnapshots.$inferSelect,
): VerificationPolicySnapshot => ({
  id: row.id,
  verificationRunId: row.verificationRunId,
  runId: row.runId,
  policyVersion: row.policyVersion,
  anchorAt: row.anchorAt,
  settlingPeriodMinutes: row.settlingPeriodMinutes,
  verificationWindowMinutes: row.verificationWindowMinutes,
  metricKey: row.metricKey,
  baselineValue: row.baselineValue,
  incidentObservedValue: row.incidentObservedValue,
  direction: row.direction as VerificationPolicySnapshot["direction"],
  granularityMinutes: row.granularityMinutes,
  affectedFilters: parseJson(row.affectedFiltersJson, {}),
  controlFilters: parseJson(row.controlFiltersJson, null),
  controlBaselineValue: row.controlBaselineValue,
  minimumSampleSize: row.minimumSampleSize,
  requiredConsecutiveBuckets: row.requiredConsecutiveBuckets,
  metricRecoveryThreshold: row.metricRecoveryThreshold,
  minimumImprovementThreshold: row.minimumImprovementThreshold,
  feedbackTrendThreshold: row.feedbackTrendThreshold,
  feedbackRequired: row.feedbackRequired,
  feedbackMinimumSampleSize: row.feedbackMinimumSampleSize,
  createdAt: row.createdAt,
});

const mapVerificationEvidence = (
  row: typeof verificationEvidence.$inferSelect,
): VerificationEvidence => ({
  id: row.id, runId: row.runId, verificationRunId: row.verificationRunId,
  kind: row.kind as VerificationEvidence["kind"], source: row.source,
  query: parseJson(row.queryJson, {}), windowStart: row.windowStart, windowEnd: row.windowEnd,
  sampleSize: row.sampleSize, observedValue: row.observedValue, baselineValue: row.baselineValue,
  recoveryRatio: row.recoveryRatio, qualityStatus: row.qualityStatus as VerificationEvidence["qualityStatus"],
  details: parseJson(row.detailsJson, {}), provenance: row.provenance, createdAt: row.createdAt,
});

const mapVerificationEvaluation = (
  row: typeof verificationEvaluations.$inferSelect,
): VerificationEvaluation => ({
  id: row.id, runId: row.runId, verificationRunId: row.verificationRunId,
  clientRequestId: row.clientRequestId, outcome: row.outcome as VerificationEvaluation["outcome"],
  reasonCode: row.reasonCode, result: parseJson(row.resultJson, {}), createdAt: row.createdAt,
});

export class D1InvestigationStore implements InvestigationStore, Phase4InvestigationStore {
  constructor(private readonly dbProvider: typeof getDb = getDb) {}

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
    assertGenericRunTransition(from, to);
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

  async finalizeGroundedInvestigation(input: GroundedFinalizationCommit) {
    assertGroundedFinalizationCommit(input);
    const db = await this.dbProvider();
    const diagnosis = input.diagnosis;
    const guardToken = `FINALIZE:${diagnosis.id}`;
    const selectedHypothesisStillCurrent = exists(
      db.select({ id: hypotheses.id })
        .from(hypotheses)
        .where(and(
          eq(hypotheses.id, input.selectedHypothesis.id),
          eq(hypotheses.runId, input.runId),
          eq(hypotheses.status, input.selectedHypothesis.status),
          eq(hypotheses.confidence, input.selectedHypothesis.confidence),
          eq(hypotheses.updatedAt, input.selectedHypothesis.updatedAt),
        )),
    );
    const iterationStillCurrent = exists(
      db.select({ id: agentIterations.id })
        .from(agentIterations)
        .where(and(
          eq(agentIterations.id, input.iterationId),
          eq(agentIterations.runId, input.runId),
          eq(agentIterations.status, "RUNNING"),
        )),
    );
    const claimStatements = input.claims.map((claim) => db.insert(diagnosisClaims).values({
      id: claim.id,
      runId: claim.runId,
      diagnosisId: claim.diagnosisId,
      type: claim.type,
      limitationType: claim.limitationType,
      statement: claim.statement,
      groundingStatus: claim.groundingStatus,
      createdAt: claim.createdAt,
    }));
    const actionStatements = input.proposedAction
      && input.approval
      && input.approvalSnapshot
      && input.actionToolCall
      ? [
          db.insert(proposedActions).values({
            id: input.proposedAction.id,
            runId: input.proposedAction.runId,
            diagnosisId: input.proposedAction.diagnosisId,
            type: input.proposedAction.type,
            status: input.proposedAction.status,
            title: input.proposedAction.title,
            argumentsJson: JSON.stringify(input.proposedAction.arguments),
            rationale: input.proposedAction.rationale,
            revision: input.proposedAction.revision,
            supersedesProposedActionId: input.proposedAction.supersedesProposedActionId,
            supersededAt: input.proposedAction.supersededAt,
            createdAt: input.proposedAction.createdAt,
            updatedAt: input.proposedAction.updatedAt,
          }),
          db.insert(approvals).values(input.approval),
          db.insert(approvalSnapshots).values({
            id: input.approvalSnapshot.id,
            approvalId: input.approvalSnapshot.approvalId,
            runId: input.approvalSnapshot.runId,
            diagnosisId: input.approvalSnapshot.diagnosisId,
            proposedActionId: input.approvalSnapshot.proposedActionId,
            revision: input.approvalSnapshot.revision,
            frozenPayloadJson: JSON.stringify(input.approvalSnapshot.frozenPayload),
            checksum: input.approvalSnapshot.checksum,
            lifecycleStatus: input.approvalSnapshot.lifecycleStatus,
            createdAt: input.approvalSnapshot.createdAt,
            withdrawnAt: input.approvalSnapshot.withdrawnAt,
          }),
          db.insert(toolCalls).values({
            id: input.actionToolCall.id,
            runId: input.actionToolCall.runId,
            name: input.actionToolCall.name,
            argumentsJson: JSON.stringify(input.actionToolCall.arguments),
            canonicalSignature: input.actionToolCall.canonicalSignature,
            status: input.actionToolCall.status,
            proposedActionId: input.actionToolCall.proposedActionId,
            approvalId: input.actionToolCall.approvalId,
            agentIterationId: input.actionToolCall.agentIterationId,
            triggerMessageId: input.actionToolCall.triggerMessageId,
            cacheSourceToolCallId: input.actionToolCall.cacheSourceToolCallId,
            iteration: input.actionToolCall.iteration,
            orderIndex: input.actionToolCall.order,
            resultId: input.actionToolCall.resultId,
            requestedAt: input.actionToolCall.requestedAt,
            startedAt: input.actionToolCall.startedAt,
            completedAt: input.actionToolCall.completedAt,
          }),
        ]
      : [];
    const statements = [
      db.update(investigationRuns)
        .set({
          status: input.targetRunStatus,
          activeIterationId: guardToken,
          lockVersion: input.expectedLockVersion + 1,
          currentDiagnosisRevision: diagnosis.revision,
          totalTokens: input.totalTokens,
          completedAt: null,
          updatedAt: input.completedAt,
        })
        .where(and(
          eq(investigationRuns.id, input.runId),
          eq(investigationRuns.status, "RUNNING"),
          eq(investigationRuns.activeIterationId, input.iterationId),
          eq(investigationRuns.lockVersion, input.expectedLockVersion),
          eq(investigationRuns.currentDiagnosisRevision, input.expectedDiagnosisRevision),
          selectedHypothesisStillCurrent,
          iterationStillCurrent,
        ))
        .returning({ id: investigationRuns.id }),
      db.insert(diagnoses).select(sql`
        SELECT
          ${diagnosis.id}, ${diagnosis.runId}, ${diagnosis.selectedHypothesisId},
          ${diagnosis.groundingStatus}, ${diagnosis.disposition}, ${diagnosis.rootCause},
          ${diagnosis.summary}, ${JSON.stringify(diagnosis.causalChain)},
          ${JSON.stringify(diagnosis.affectedMetrics)}, ${JSON.stringify(diagnosis.affectedSegments)},
          ${JSON.stringify(diagnosis.validatedClaims)}, ${JSON.stringify(diagnosis.unvalidatedClaims)},
          ${diagnosis.confidence}, ${diagnosis.severity}, ${diagnosis.recommendedAction},
          ${diagnosis.revision}, ${diagnosis.status}, ${diagnosis.supersedesDiagnosisId},
          ${diagnosis.supersededAt}, ${diagnosis.createdAt}, ${diagnosis.updatedAt}
        FROM ${investigationRuns}
        WHERE ${investigationRuns.id} = ${input.runId}
          AND ${investigationRuns.status} = ${input.targetRunStatus}
          AND ${investigationRuns.activeIterationId} = ${guardToken}
          AND ${investigationRuns.lockVersion} = ${input.expectedLockVersion + 1}
          AND ${investigationRuns.currentDiagnosisRevision} = ${diagnosis.revision}
      `),
      ...claimStatements,
      ...input.claimEvidenceLinks.map((link) =>
        db.insert(diagnosisClaimEvidenceLinks).values(link)),
      ...actionStatements,
      ...input.auditEvents.map((event) => db.insert(auditEvents).values({
        id: event.id,
        runId: event.runId,
        proposedActionId: event.proposedActionId,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        type: event.type,
        actor: event.actor,
        detailsJson: JSON.stringify(event.details),
        createdAt: event.createdAt,
      })),
      db.insert(investigationTraceEvents).values({
        id: input.traceEvent.id,
        runId: input.traceEvent.runId,
        iterationId: input.traceEvent.iterationId,
        sequence: input.traceEvent.sequence,
        type: input.traceEvent.type,
        actor: input.traceEvent.actor,
        publicSummary: input.traceEvent.publicSummary,
        detailsJson: JSON.stringify(input.traceEvent.details),
        createdAt: input.traceEvent.createdAt,
      }),
      db.update(agentIterations)
        .set({
          status: "COMPLETED",
          decisionType: "FINALIZE",
          publicRationale: input.publicRationale,
          completedAt: input.completedAt,
        })
        .where(and(
          eq(agentIterations.id, input.iterationId),
          eq(agentIterations.runId, input.runId),
          eq(agentIterations.status, "RUNNING"),
        )),
      db.update(investigationRuns)
        .set({ activeIterationId: null, updatedAt: input.completedAt })
        .where(and(
          eq(investigationRuns.id, input.runId),
          eq(investigationRuns.activeIterationId, guardToken),
          eq(investigationRuns.lockVersion, input.expectedLockVersion + 1),
        )),
    ];
    await db.batch(statements as [typeof statements[number], ...typeof statements]);
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

  async commitEvidenceAssessment(input: {
    links: HypothesisEvidenceLink[];
    hypotheses: Hypothesis[];
    traceEvent: InvestigationTraceEvent;
    iterationId: string;
    rationale: string;
    completedAt: string;
  }) {
    if (input.links.length === 0 || input.hypotheses.length === 0) {
      throw new Error("Evidence Assessment 原子提交缺少 links 或 hypotheses。");
    }
    const db = await getDb();
    await db.batch([
      db.insert(hypothesisEvidenceLinks).values(input.links),
      ...input.hypotheses.map((item) => db
        .update(hypotheses)
        .set({
          status: item.status,
          confidence: item.confidence,
          supportScore: item.supportScore,
          contradictionScore: item.contradictionScore,
          confidenceReason: item.confidenceReason,
          updatedAt: item.updatedAt,
        })
        .where(and(eq(hypotheses.id, item.id), eq(hypotheses.runId, item.runId)))),
      db.insert(investigationTraceEvents).values({
        id: input.traceEvent.id,
        runId: input.traceEvent.runId,
        iterationId: input.traceEvent.iterationId,
        sequence: input.traceEvent.sequence,
        type: input.traceEvent.type,
        actor: input.traceEvent.actor,
        publicSummary: input.traceEvent.publicSummary,
        detailsJson: JSON.stringify(input.traceEvent.details),
        createdAt: input.traceEvent.createdAt,
      }),
      db.update(agentIterations)
        .set({
          status: "COMPLETED",
          decisionType: "ASSESS_EVIDENCE",
          publicRationale: input.rationale,
          completedAt: input.completedAt,
        })
        .where(and(
          eq(agentIterations.id, input.iterationId),
          eq(agentIterations.status, "RUNNING"),
        )),
      db.update(investigationRuns)
        .set({ activeIterationId: null, updatedAt: input.completedAt })
        .where(and(
          eq(investigationRuns.id, input.traceEvent.runId),
          eq(investigationRuns.activeIterationId, input.iterationId),
        )),
    ]);
  }

  async commitHumanHypothesis(input: {
    hypothesis: Hypothesis;
    message: InvestigationMessage;
    traceEvent: InvestigationTraceEvent;
    iterationId: string;
    completedAt: string;
  }) {
    const db = await getDb();
    await db.batch([
      db.insert(hypotheses).values(input.hypothesis),
      db.insert(investigationMessages).values({
        id: input.message.id,
        runId: input.message.runId,
        clientRequestId: input.message.clientRequestId,
        role: input.message.role,
        intent: input.message.intent,
        content: input.message.content,
        citedEvidenceIdsJson: JSON.stringify(input.message.citedEvidenceIds),
        createdAt: input.message.createdAt,
      }),
      db.insert(investigationTraceEvents).values({
        id: input.traceEvent.id,
        runId: input.traceEvent.runId,
        iterationId: input.traceEvent.iterationId,
        sequence: input.traceEvent.sequence,
        type: input.traceEvent.type,
        actor: input.traceEvent.actor,
        publicSummary: input.traceEvent.publicSummary,
        detailsJson: JSON.stringify(input.traceEvent.details),
        createdAt: input.traceEvent.createdAt,
      }),
      db.update(agentIterations)
        .set({
          status: "COMPLETED",
          decisionType: "CREATE_HYPOTHESES",
          publicRationale: "产品经理新增竞争假设",
          completedAt: input.completedAt,
        })
        .where(and(
          eq(agentIterations.id, input.iterationId),
          eq(agentIterations.status, "RUNNING"),
        )),
      db.update(investigationRuns)
        .set({ activeIterationId: null, updatedAt: input.completedAt })
        .where(and(
          eq(investigationRuns.id, input.hypothesis.runId),
          eq(investigationRuns.activeIterationId, input.iterationId),
        )),
    ]);
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

  async commitActionCompletion(input: ActionCompletionCommit) {
    const db = await this.dbProvider();
    const completion = input.completion;
    const guardToken = `ACTION_COMPLETION:${completion.id}`;
    const actionContextStillCurrent = exists(
      db.select({ id: proposedActions.id })
        .from(proposedActions)
        .innerJoin(approvals, and(
          eq(approvals.id, completion.approvalId),
          eq(approvals.proposedActionId, proposedActions.id),
        ))
        .innerJoin(diagnoses, and(
          eq(diagnoses.id, completion.diagnosisId),
          eq(diagnoses.runId, completion.runId),
        ))
        .innerJoin(toolCalls, and(
          eq(toolCalls.proposedActionId, proposedActions.id),
          eq(toolCalls.approvalId, approvals.id),
        ))
        .where(and(
          eq(proposedActions.id, completion.proposedActionId),
          eq(proposedActions.runId, completion.runId),
          eq(proposedActions.diagnosisId, diagnoses.id),
          eq(proposedActions.status, "SUCCEEDED"),
          eq(proposedActions.revision, completion.revision),
          eq(approvals.runId, completion.runId),
          eq(approvals.status, "APPROVED"),
          eq(approvals.decision, "APPROVE"),
          eq(approvals.revision, completion.revision),
          eq(diagnoses.revision, completion.revision),
          eq(diagnoses.groundingStatus, "GROUNDED"),
          eq(toolCalls.status, "SUCCESS"),
          eq(toolCalls.completedAt, input.expectedActionCompletedAt),
        )),
    );
    const statements = [
      db.update(investigationRuns)
        .set({
          status: "WAITING_VERIFICATION",
          activeIterationId: guardToken,
          lockVersion: input.expectedLockVersion + 1,
          completedAt: null,
          updatedAt: completion.createdAt,
        })
        .where(and(
          eq(investigationRuns.id, completion.runId),
          eq(investigationRuns.status, "WAITING_ACTION_COMPLETION"),
          eq(investigationRuns.currentDiagnosisRevision, completion.revision),
          eq(investigationRuns.lockVersion, input.expectedLockVersion),
          isNull(investigationRuns.activeIterationId),
          actionContextStillCurrent,
        ))
        .returning({ id: investigationRuns.id }),
      db.insert(actionCompletions).select(sql`
        SELECT
          ${completion.id}, ${completion.runId}, ${completion.proposedActionId},
          ${completion.approvalId}, ${completion.diagnosisId}, ${completion.revision},
          ${completion.clientRequestId}, ${completion.effectiveAt},
          ${completion.changeReference}, ${completion.note}, ${completion.confirmedBy},
          ${completion.createdAt}
        FROM ${investigationRuns}
        WHERE ${investigationRuns.id} = ${completion.runId}
          AND ${investigationRuns.status} = 'WAITING_VERIFICATION'
          AND ${investigationRuns.activeIterationId} = ${guardToken}
          AND ${investigationRuns.lockVersion} = ${input.expectedLockVersion + 1}
      `),
      ...input.auditEvents.map((event) => db.insert(auditEvents).select(sql`
          SELECT
            ${event.id}, ${event.runId}, ${event.proposedActionId}, ${event.approvalId},
            ${event.toolCallId}, ${event.type}, ${event.actor},
            ${JSON.stringify(event.details)}, ${event.createdAt}
          FROM ${actionCompletions}
          WHERE ${actionCompletions.id} = ${completion.id}
        `)),
      db.insert(investigationTraceEvents).select(sql`
        SELECT
          ${input.traceEvent.id}, ${input.traceEvent.runId}, ${input.traceEvent.iterationId},
          ${input.traceEvent.sequence}, ${input.traceEvent.type}, ${input.traceEvent.actor},
          ${input.traceEvent.publicSummary}, ${JSON.stringify(input.traceEvent.details)},
          ${input.traceEvent.createdAt}
        FROM ${actionCompletions}
        WHERE ${actionCompletions.id} = ${completion.id}
      `),
      db.update(investigationRuns)
        .set({ activeIterationId: null, updatedAt: completion.createdAt })
        .where(and(
          eq(investigationRuns.id, completion.runId),
          eq(investigationRuns.activeIterationId, guardToken),
          eq(investigationRuns.lockVersion, input.expectedLockVersion + 1),
        )),
    ];
    const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
    return batchChanged(results[0]);
  }

  async commitVerificationAttempt(input: VerificationAttemptCommit) {
    const db = await this.dbProvider();
    const verification = input.verificationRun;
    const policy = input.policySnapshot;
    if (
      policy.verificationRunId !== verification.id
      || policy.runId !== verification.runId
      || policy.anchorAt !== verification.anchorAt
      || !policy.metricKey.trim()
      || (verification.anchorType === "OBSERVE_DIAGNOSIS"
        ? verification.actionCompletionId !== null
        : verification.actionCompletionId === null)
    ) return false;
    const guardToken = `VERIFICATION_ATTEMPT:${verification.id}`;
    const currentDiagnosisStillValid = exists(
      db.select({ id: diagnoses.id })
        .from(diagnoses)
        .where(and(
          eq(diagnoses.id, verification.diagnosisId),
          eq(diagnoses.runId, verification.runId),
          eq(diagnoses.groundingStatus, "GROUNDED"),
          eq(diagnoses.revision, input.expectedDiagnosisRevision),
        )),
    );
    const noActiveVerification = notExists(
      db.select({ id: verificationRuns.id })
        .from(verificationRuns)
        .where(and(
          eq(verificationRuns.runId, verification.runId),
          sql`${verificationRuns.status} in ('PENDING', 'WAITING_WINDOW', 'RUNNING')`,
        )),
    );
    const verificationSourceStillValid = verification.anchorType === "OBSERVE_DIAGNOSIS"
      ? exists(
          db.select({ id: diagnoses.id })
            .from(diagnoses)
            .where(and(
              eq(diagnoses.id, verification.diagnosisId),
              eq(diagnoses.runId, verification.runId),
              eq(diagnoses.revision, input.expectedDiagnosisRevision),
              eq(diagnoses.disposition, "OBSERVE"),
              eq(diagnoses.createdAt, verification.anchorAt),
            )),
        )
      : exists(
          db.select({ id: actionCompletions.id })
            .from(actionCompletions)
            .innerJoin(proposedActions, and(
              eq(proposedActions.id, actionCompletions.proposedActionId),
              eq(proposedActions.runId, actionCompletions.runId),
            ))
            .innerJoin(approvals, and(
              eq(approvals.id, actionCompletions.approvalId),
              eq(approvals.proposedActionId, proposedActions.id),
            ))
            .where(and(
              eq(actionCompletions.id, verification.actionCompletionId ?? ""),
              eq(actionCompletions.runId, verification.runId),
              eq(actionCompletions.diagnosisId, verification.diagnosisId),
              eq(actionCompletions.revision, input.expectedDiagnosisRevision),
              eq(actionCompletions.effectiveAt, verification.anchorAt),
              eq(proposedActions.diagnosisId, verification.diagnosisId),
              eq(proposedActions.revision, input.expectedDiagnosisRevision),
              eq(proposedActions.status, "SUCCEEDED"),
              eq(approvals.runId, verification.runId),
              eq(approvals.revision, input.expectedDiagnosisRevision),
              eq(approvals.status, "APPROVED"),
              eq(approvals.decision, "APPROVE"),
            )),
        );
    const statements = [
      db.update(investigationRuns)
        .set({
          activeIterationId: guardToken,
          lockVersion: input.expectedLockVersion + 1,
          updatedAt: verification.createdAt,
        })
        .where(and(
          eq(investigationRuns.id, verification.runId),
          eq(investigationRuns.status, "WAITING_VERIFICATION"),
          eq(investigationRuns.currentDiagnosisRevision, input.expectedDiagnosisRevision),
          eq(investigationRuns.lockVersion, input.expectedLockVersion),
          isNull(investigationRuns.activeIterationId),
          currentDiagnosisStillValid,
          verificationSourceStillValid,
          noActiveVerification,
        ))
        .returning({ id: investigationRuns.id }),
      db.insert(verificationRuns).select(sql`
        SELECT
          ${verification.id}, ${verification.runId}, ${verification.diagnosisId},
          ${verification.actionCompletionId}, ${verification.attempt},
          ${verification.clientRequestId}, ${verification.status}, ${verification.anchorType},
          ${verification.anchorAt}, ${verification.createdAt}, ${verification.updatedAt},
          ${verification.completedAt}
        FROM ${investigationRuns}
        WHERE ${investigationRuns.id} = ${verification.runId}
          AND ${investigationRuns.status} = 'WAITING_VERIFICATION'
          AND ${investigationRuns.activeIterationId} = ${guardToken}
          AND ${investigationRuns.lockVersion} = ${input.expectedLockVersion + 1}
      `),
      db.insert(verificationPolicySnapshots).select(sql`
        SELECT
          ${policy.id}, ${policy.verificationRunId}, ${policy.runId}, ${policy.policyVersion},
          ${policy.anchorAt}, ${policy.settlingPeriodMinutes},
          ${policy.verificationWindowMinutes}, ${policy.metricKey},
          ${policy.baselineValue}, ${policy.incidentObservedValue}, ${policy.direction},
          ${policy.granularityMinutes},
          ${JSON.stringify(policy.affectedFilters)}, ${policy.controlFilters === null
            ? null
            : JSON.stringify(policy.controlFilters)}, ${policy.controlBaselineValue},
          ${policy.minimumSampleSize},
          ${policy.requiredConsecutiveBuckets}, ${policy.metricRecoveryThreshold},
          ${policy.minimumImprovementThreshold},
          ${policy.feedbackTrendThreshold}, ${policy.feedbackRequired ? 1 : 0},
          ${policy.feedbackMinimumSampleSize}, ${policy.createdAt}
        FROM ${verificationRuns}
        WHERE ${verificationRuns.id} = ${verification.id}
      `),
      db.insert(auditEvents).select(sql`
        SELECT
          ${input.auditEvent.id}, ${input.auditEvent.runId},
          ${input.auditEvent.proposedActionId}, ${input.auditEvent.approvalId},
          ${input.auditEvent.toolCallId}, ${input.auditEvent.type}, ${input.auditEvent.actor},
          ${JSON.stringify(input.auditEvent.details)}, ${input.auditEvent.createdAt}
        FROM ${verificationRuns}
        WHERE ${verificationRuns.id} = ${verification.id}
      `),
      db.insert(investigationTraceEvents).select(sql`
        SELECT
          ${input.traceEvent.id}, ${input.traceEvent.runId}, ${input.traceEvent.iterationId},
          ${input.traceEvent.sequence}, ${input.traceEvent.type}, ${input.traceEvent.actor},
          ${input.traceEvent.publicSummary}, ${JSON.stringify(input.traceEvent.details)},
          ${input.traceEvent.createdAt}
        FROM ${verificationRuns}
        WHERE ${verificationRuns.id} = ${verification.id}
      `),
      db.update(investigationRuns)
        .set({ activeIterationId: null, updatedAt: verification.createdAt })
        .where(and(
          eq(investigationRuns.id, verification.runId),
          eq(investigationRuns.activeIterationId, guardToken),
          eq(investigationRuns.lockVersion, input.expectedLockVersion + 1),
        )),
    ];
    const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
    return batchChanged(results[0]);
  }

  async queryVerificationMetricBuckets(input: {
    metricKey: string; filters: import("../analytics/types").MetricFilters;
    startTime: string; endTime: string;
  }) {
    return new D1AnalyticsStore().queryMetricBuckets(input);
  }

  async queryVerificationFeedback(input: {
    filters: import("../analytics/types").MetricFilters; startTime: string; endTime: string;
  }) {
    const clauses = [gte(feedbackRecords.timestamp, input.startTime), lt(feedbackRecords.timestamp, input.endTime)];
    if (input.filters.platform) clauses.push(eq(feedbackRecords.platform, input.filters.platform));
    if (input.filters.appVersion) clauses.push(eq(feedbackRecords.appVersion, input.filters.appVersion));
    if (input.filters.region) clauses.push(eq(feedbackRecords.region, input.filters.region));
    if (input.filters.userType) clauses.push(eq(feedbackRecords.userType, input.filters.userType));
    const rows = await (await this.dbProvider()).select().from(feedbackRecords)
      .where(and(...clauses)).orderBy(asc(feedbackRecords.timestamp));
    return rows.map((row) => ({
      id: row.id, timestamp: row.timestamp, tags: parseJson<string[]>(row.tagsJson, []),
      source: row.source, sourceReference: row.sourceReference,
    }));
  }

  async markVerificationWaitingWindow(input: {
    runId: string; verificationRunId: string; expectedLockVersion: number; updatedAt: string;
  }) {
    const db = await this.dbProvider();
    const rows = await db.update(verificationRuns).set({ status: "WAITING_WINDOW", updatedAt: input.updatedAt })
      .where(and(
        eq(verificationRuns.id, input.verificationRunId), eq(verificationRuns.runId, input.runId),
        sql`${verificationRuns.status} in ('PENDING', 'WAITING_WINDOW')`,
        exists(db.select({ id: investigationRuns.id }).from(investigationRuns).where(and(
          eq(investigationRuns.id, input.runId), eq(investigationRuns.status, "WAITING_VERIFICATION"),
          eq(investigationRuns.lockVersion, input.expectedLockVersion), isNull(investigationRuns.activeIterationId),
        ))),
      )).returning({ id: verificationRuns.id });
    return Boolean(rows[0]);
  }

  async beginVerificationEvaluation(input: {
    runId: string; verificationRunId: string; clientRequestId: string;
    expectedLockVersion: number; startedAt: string;
  }) {
    const db = await this.dbProvider();
    const guard = `VERIFICATION_EVALUATION:${input.verificationRunId}:${input.clientRequestId}`;
    const statements = [
      db.update(investigationRuns).set({
        status: "VERIFYING", activeIterationId: guard,
        lockVersion: input.expectedLockVersion + 1, updatedAt: input.startedAt,
      }).where(and(
        eq(investigationRuns.id, input.runId), eq(investigationRuns.status, "WAITING_VERIFICATION"),
        eq(investigationRuns.lockVersion, input.expectedLockVersion), isNull(investigationRuns.activeIterationId),
        exists(db.select({ id: verificationRuns.id }).from(verificationRuns).where(and(
          eq(verificationRuns.id, input.verificationRunId), eq(verificationRuns.runId, input.runId),
          sql`${verificationRuns.status} in ('PENDING', 'WAITING_WINDOW')`,
        ))),
      )).returning({ id: investigationRuns.id }),
      db.update(verificationRuns).set({ status: "RUNNING", updatedAt: input.startedAt })
        .where(and(eq(verificationRuns.id, input.verificationRunId), eq(verificationRuns.runId, input.runId),
          exists(db.select({ id: investigationRuns.id }).from(investigationRuns).where(and(
            eq(investigationRuns.id, input.runId), eq(investigationRuns.activeIterationId, guard),
          ))))),
      db.insert(runtimeCommands).select(sql`
        SELECT ${`CMD-${crypto.randomUUID()}`}, ${input.runId}, ${input.clientRequestId},
          'EVALUATE_VERIFICATION', ${input.verificationRunId}, ${input.startedAt}
        FROM ${investigationRuns} WHERE ${investigationRuns.id} = ${input.runId}
          AND ${investigationRuns.activeIterationId} = ${guard}
      `),
    ];
    const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
    return batchChanged(results[0]);
  }

  async commitVerificationEvaluation(input: VerificationEvaluationCommit) {
    const db = await this.dbProvider();
    const evaluation = input.evaluation;
    if (input.evidence.some((item) => item.runId !== evaluation.runId
      || item.verificationRunId !== evaluation.verificationRunId)) return false;
    const guard = `VERIFICATION_EVALUATION:${evaluation.verificationRunId}:${evaluation.clientRequestId}`;
    const runStatus = evaluation.outcome === "INCONCLUSIVE" ? "VERIFICATION_INCONCLUSIVE" : evaluation.outcome;
    const statements = [
      db.update(verificationRuns).set({
        status: "COMMITTING", updatedAt: evaluation.createdAt,
      }).where(and(
        eq(verificationRuns.id, evaluation.verificationRunId),
        eq(verificationRuns.runId, evaluation.runId),
        eq(verificationRuns.attempt, input.expectedVerificationAttempt),
        eq(verificationRuns.status, "RUNNING"),
        notExists(db.select({ id: verificationEvaluations.id }).from(verificationEvaluations)
          .where(eq(verificationEvaluations.verificationRunId, evaluation.verificationRunId))),
        exists(db.select({ id: investigationRuns.id }).from(investigationRuns).where(and(
          eq(investigationRuns.id, evaluation.runId),
          eq(investigationRuns.status, "VERIFYING"),
          eq(investigationRuns.activeIterationId, guard),
          eq(investigationRuns.lockVersion, input.expectedLockVersion),
        ))),
      )).returning({ id: verificationRuns.id }),
      db.insert(verificationEvaluations).select(sql`
        SELECT ${evaluation.id}, ${evaluation.runId}, ${evaluation.verificationRunId},
          ${evaluation.clientRequestId}, ${evaluation.outcome}, ${evaluation.reasonCode},
          ${JSON.stringify(evaluation.result)}, ${evaluation.createdAt}
        FROM ${verificationRuns} WHERE ${verificationRuns.id} = ${evaluation.verificationRunId}
          AND ${verificationRuns.runId} = ${evaluation.runId}
          AND ${verificationRuns.attempt} = ${input.expectedVerificationAttempt}
          AND ${verificationRuns.status} = 'COMMITTING'
      `),
      ...input.evidence.map((item) => db.insert(verificationEvidence).select(sql`
        SELECT ${item.id}, ${item.runId}, ${item.verificationRunId}, ${item.kind}, ${item.source},
          ${JSON.stringify(item.query)}, ${item.windowStart}, ${item.windowEnd}, ${item.sampleSize},
          ${item.observedValue}, ${item.baselineValue}, ${item.recoveryRatio}, ${item.qualityStatus},
          ${JSON.stringify(item.details)}, ${item.provenance}, ${item.createdAt}
        FROM ${verificationEvaluations} WHERE ${verificationEvaluations.id} = ${evaluation.id}
      `)),
      db.update(verificationRuns).set({ status: evaluation.outcome, updatedAt: evaluation.createdAt, completedAt: evaluation.createdAt })
        .where(and(eq(verificationRuns.id, evaluation.verificationRunId), eq(verificationRuns.status, "COMMITTING"),
          eq(verificationRuns.attempt, input.expectedVerificationAttempt),
          exists(db.select({ id: verificationEvaluations.id }).from(verificationEvaluations)
            .where(eq(verificationEvaluations.id, evaluation.id))))),
      ...input.auditEvents.map((event) => db.insert(auditEvents).select(sql`
        SELECT ${event.id}, ${event.runId}, ${event.proposedActionId}, ${event.approvalId},
          ${event.toolCallId}, ${event.type}, ${event.actor}, ${JSON.stringify(event.details)}, ${event.createdAt}
        FROM ${verificationEvaluations} WHERE ${verificationEvaluations.id} = ${evaluation.id}
      `)),
      db.insert(investigationTraceEvents).select(sql`
        SELECT ${input.traceEvent.id}, ${input.traceEvent.runId}, ${input.traceEvent.iterationId},
          ${input.traceEvent.sequence}, ${input.traceEvent.type}, ${input.traceEvent.actor},
          ${input.traceEvent.publicSummary}, ${JSON.stringify(input.traceEvent.details)}, ${input.traceEvent.createdAt}
        FROM ${verificationEvaluations} WHERE ${verificationEvaluations.id} = ${evaluation.id}
      `),
      db.update(investigationRuns).set({
        status: runStatus, activeIterationId: null, lockVersion: input.expectedLockVersion + 1,
        completedAt: evaluation.createdAt, updatedAt: evaluation.createdAt,
      }).where(and(eq(investigationRuns.id, evaluation.runId), eq(investigationRuns.status, "VERIFYING"),
        eq(investigationRuns.activeIterationId, guard), eq(investigationRuns.lockVersion, input.expectedLockVersion),
        exists(db.select({ id: verificationRuns.id }).from(verificationRuns).where(and(
          eq(verificationRuns.id, evaluation.verificationRunId),
          eq(verificationRuns.runId, evaluation.runId),
          eq(verificationRuns.attempt, input.expectedVerificationAttempt),
          eq(verificationRuns.status, evaluation.outcome),
          exists(db.select({ id: verificationEvaluations.id }).from(verificationEvaluations)
            .where(and(eq(verificationEvaluations.id, evaluation.id),
              eq(verificationEvaluations.verificationRunId, verificationRuns.id)))),
        ))))),
    ];
    const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
    return batchChanged(results[0]);
  }

  async commitVerificationReopen(input: VerificationReopenCommit) {
    const db = await this.dbProvider();
    const commandId = `CMD-${crypto.randomUUID()}`;
    const statements = [
      db.update(investigationRuns).set({ status: "RUNNING", completedAt: null, stopReason: null,
        lockVersion: input.expectedLockVersion + 1, updatedAt: input.createdAt })
        .where(and(eq(investigationRuns.id, input.runId), eq(investigationRuns.lockVersion, input.expectedLockVersion),
          isNull(investigationRuns.activeIterationId),
          notExists(db.select({ id: runtimeCommands.id }).from(runtimeCommands).where(and(
            eq(runtimeCommands.runId, input.runId),
            eq(runtimeCommands.clientRequestId, input.clientRequestId),
            eq(runtimeCommands.commandType, "REOPEN_VERIFICATION"),
          ))),
          exists(db.select({ id: verificationRuns.id }).from(verificationRuns)
            .where(and(
              eq(verificationRuns.id, input.verificationRunId),
              eq(verificationRuns.runId, input.runId),
              sql`((${verificationRuns.status} = 'PARTIALLY_RESOLVED' AND ${investigationRuns.status} = 'PARTIALLY_RESOLVED')
                OR (${verificationRuns.status} = 'NOT_RECOVERED' AND ${investigationRuns.status} = 'NOT_RECOVERED')
                OR (${verificationRuns.status} = 'INCONCLUSIVE' AND ${investigationRuns.status} = 'VERIFICATION_INCONCLUSIVE'))`,
              sql`${verificationRuns.attempt} = (
                SELECT MAX(vr_latest.attempt) FROM verification_runs vr_latest
                WHERE vr_latest.run_id = ${input.runId}
              )`,
            )))))
        .returning({ id: investigationRuns.id }),
      db.insert(runtimeCommands).select(sql`
        SELECT ${commandId}, ${input.runId}, ${input.clientRequestId},
          'REOPEN_VERIFICATION', ${input.verificationRunId}, ${input.createdAt}
        FROM ${investigationRuns} WHERE ${investigationRuns.id} = ${input.runId}
          AND ${investigationRuns.status} = 'RUNNING'
          AND ${investigationRuns.lockVersion} = ${input.expectedLockVersion + 1}
      `),
      db.insert(auditEvents).select(sql`
        SELECT ${input.auditEvent.id}, ${input.auditEvent.runId}, ${input.auditEvent.proposedActionId},
          ${input.auditEvent.approvalId}, ${input.auditEvent.toolCallId}, ${input.auditEvent.type},
          ${input.auditEvent.actor}, ${JSON.stringify(input.auditEvent.details)}, ${input.auditEvent.createdAt}
        FROM ${runtimeCommands} WHERE ${runtimeCommands.id} = ${commandId}
      `),
      db.insert(investigationTraceEvents).select(sql`
        SELECT ${input.traceEvent.id}, ${input.traceEvent.runId}, ${input.traceEvent.iterationId},
          ${input.traceEvent.sequence}, ${input.traceEvent.type}, ${input.traceEvent.actor},
          ${input.traceEvent.publicSummary}, ${JSON.stringify(input.traceEvent.details)}, ${input.traceEvent.createdAt}
        FROM ${runtimeCommands} WHERE ${runtimeCommands.id} = ${commandId}
      `),
    ];
    const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
    return batchChanged(results[0]);
  }

  async commitVerificationRetry(input: VerificationRetryCommit) {
    const db = await this.dbProvider();
    const verification = input.verificationRun;
    const policy = input.policySnapshot;
    const guard = `VERIFICATION_RETRY:${verification.id}`;
    const statements = [
      db.update(investigationRuns).set({
        status: "WAITING_VERIFICATION", activeIterationId: guard, completedAt: null,
        lockVersion: input.expectedLockVersion + 1, updatedAt: verification.createdAt,
      }).where(and(
        eq(investigationRuns.id, verification.runId), eq(investigationRuns.lockVersion, input.expectedLockVersion),
        eq(investigationRuns.currentDiagnosisRevision, input.expectedDiagnosisRevision),
        sql`${verification.attempt} <= 3`,
        sql`${policy.verificationWindowMinutes} <= 480`,
        isNull(investigationRuns.activeIterationId),
        exists(db.select({ id: verificationRuns.id }).from(verificationRuns).where(and(
          eq(verificationRuns.id, input.previousVerificationRunId),
          eq(verificationRuns.runId, verification.runId),
          sql`${verification.attempt} = ${verificationRuns.attempt} + 1`,
          sql`${verificationRuns.attempt} = (
            SELECT MAX(vr_latest.attempt) FROM verification_runs vr_latest
            WHERE vr_latest.run_id = ${verification.runId}
          )`,
          sql`((${verificationRuns.status} = 'PARTIALLY_RESOLVED' AND ${investigationRuns.status} = 'PARTIALLY_RESOLVED')
            OR (${verificationRuns.status} = 'NOT_RECOVERED' AND ${investigationRuns.status} = 'NOT_RECOVERED')
            OR (${verificationRuns.status} = 'INCONCLUSIVE' AND ${investigationRuns.status} = 'VERIFICATION_INCONCLUSIVE'))`,
        ))),
      )).returning({ id: investigationRuns.id }),
      db.insert(verificationRuns).select(sql`
        SELECT ${verification.id}, ${verification.runId}, ${verification.diagnosisId},
          ${verification.actionCompletionId}, ${verification.attempt}, ${verification.clientRequestId},
          ${verification.status}, ${verification.anchorType}, ${verification.anchorAt},
          ${verification.createdAt}, ${verification.updatedAt}, ${verification.completedAt}
        FROM ${investigationRuns} WHERE ${investigationRuns.id} = ${verification.runId}
          AND ${investigationRuns.activeIterationId} = ${guard}
      `),
      db.insert(verificationPolicySnapshots).select(sql`
        SELECT ${policy.id}, ${policy.verificationRunId}, ${policy.runId}, ${policy.policyVersion},
          ${policy.anchorAt}, ${policy.settlingPeriodMinutes}, ${policy.verificationWindowMinutes},
          ${policy.metricKey}, ${policy.baselineValue}, ${policy.incidentObservedValue}, ${policy.direction},
          ${policy.granularityMinutes}, ${JSON.stringify(policy.affectedFilters)},
          ${policy.controlFilters === null ? null : JSON.stringify(policy.controlFilters)},
          ${policy.controlBaselineValue}, ${policy.minimumSampleSize}, ${policy.requiredConsecutiveBuckets},
          ${policy.metricRecoveryThreshold}, ${policy.minimumImprovementThreshold},
          ${policy.feedbackTrendThreshold}, ${policy.feedbackRequired ? 1 : 0},
          ${policy.feedbackMinimumSampleSize}, ${policy.createdAt}
        FROM ${verificationRuns} WHERE ${verificationRuns.id} = ${verification.id}
      `),
      db.insert(runtimeCommands).select(sql`
        SELECT ${`CMD-${crypto.randomUUID()}`}, ${verification.runId}, ${input.clientRequestId},
          'RETRY_VERIFICATION', ${verification.id}, ${verification.createdAt}
        FROM ${verificationRuns} WHERE ${verificationRuns.id} = ${verification.id}
      `),
      db.insert(auditEvents).select(sql`
        SELECT ${input.auditEvent.id}, ${input.auditEvent.runId}, ${input.auditEvent.proposedActionId},
          ${input.auditEvent.approvalId}, ${input.auditEvent.toolCallId}, ${input.auditEvent.type},
          ${input.auditEvent.actor}, ${JSON.stringify(input.auditEvent.details)}, ${input.auditEvent.createdAt}
        FROM ${verificationRuns} WHERE ${verificationRuns.id} = ${verification.id}
      `),
      db.insert(investigationTraceEvents).select(sql`
        SELECT ${input.traceEvent.id}, ${input.traceEvent.runId}, ${input.traceEvent.iterationId},
          ${input.traceEvent.sequence}, ${input.traceEvent.type}, ${input.traceEvent.actor},
          ${input.traceEvent.publicSummary}, ${JSON.stringify(input.traceEvent.details)}, ${input.traceEvent.createdAt}
        FROM ${verificationRuns} WHERE ${verificationRuns.id} = ${verification.id}
      `),
      db.update(investigationRuns).set({ activeIterationId: null })
        .where(and(eq(investigationRuns.id, verification.runId), eq(investigationRuns.activeIterationId, guard))),
    ];
    const results = await db.batch(statements as [typeof statements[number], ...typeof statements]);
    return batchChanged(results[0]);
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
      diagnosisClaimRows,
      diagnosisClaimLinkRows,
      diagnosisLinkRows,
      snapshotRows,
      actionCompletionRows,
      verificationRunRows,
      verificationPolicyRows,
      verificationEvidenceRows,
      verificationEvaluationRows,
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
      db.select().from(diagnosisClaims).where(eq(diagnosisClaims.runId, run.id)).orderBy(asc(diagnosisClaims.createdAt)),
      db.select().from(diagnosisClaimEvidenceLinks).where(eq(diagnosisClaimEvidenceLinks.runId, run.id)).orderBy(asc(diagnosisClaimEvidenceLinks.createdAt)),
      db.select().from(diagnosisEvidenceLinks).where(eq(diagnosisEvidenceLinks.runId, run.id)).orderBy(asc(diagnosisEvidenceLinks.createdAt)),
      db.select().from(approvalSnapshots).where(eq(approvalSnapshots.runId, run.id)).orderBy(asc(approvalSnapshots.revision)),
      db.select().from(actionCompletions).where(eq(actionCompletions.runId, run.id)).orderBy(asc(actionCompletions.createdAt)),
      db.select().from(verificationRuns).where(eq(verificationRuns.runId, run.id)).orderBy(asc(verificationRuns.attempt)),
      db.select().from(verificationPolicySnapshots).where(eq(verificationPolicySnapshots.runId, run.id)).orderBy(asc(verificationPolicySnapshots.createdAt)),
      db.select().from(verificationEvidence).where(eq(verificationEvidence.runId, run.id)).orderBy(asc(verificationEvidence.createdAt)),
      db.select().from(verificationEvaluations).where(eq(verificationEvaluations.runId, run.id)).orderBy(asc(verificationEvaluations.createdAt)),
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
      diagnosisClaims: diagnosisClaimRows.map(mapDiagnosisClaim),
      diagnosisClaimEvidenceLinks: diagnosisClaimLinkRows.map(mapDiagnosisClaimEvidenceLink),
      diagnosisEvidenceLinks: diagnosisLinkRows.map(mapDiagnosisLink),
      approvalSnapshots: snapshotRows.map(mapApprovalSnapshot),
      actionCompletions: actionCompletionRows.map(mapActionCompletion),
      verificationRuns: verificationRunRows.map(mapVerificationRun),
      verificationPolicySnapshots: verificationPolicyRows.map(mapVerificationPolicySnapshot),
      verificationEvidence: verificationEvidenceRows.map(mapVerificationEvidence),
      verificationEvaluations: verificationEvaluationRows.map(mapVerificationEvaluation),
    };
  }
}
