import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const releases = sqliteTable("releases", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  platform: text("platform").notNull(),
  releasedAt: text("released_at").notNull(),
  rolloutStatus: text("rollout_status").notNull(),
  rolloutPercentage: real("rollout_percentage").notNull(),
  featureFlagsJson: text("feature_flags_json").notNull(),
  changedModulesJson: text("changed_modules_json").notNull(),
  provenance: text("provenance").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("releases_platform_version_unique").on(table.platform, table.version),
  index("releases_released_idx").on(table.releasedAt),
]);

export const metricBuckets = sqliteTable("metric_buckets", {
  id: text("id").primaryKey(),
  metricKey: text("metric_key").notNull(),
  bucketStart: text("bucket_start").notNull(),
  bucketEnd: text("bucket_end").notNull(),
  granularityMinutes: integer("granularity_minutes").notNull(),
  numerator: integer("numerator"),
  denominator: integer("denominator"),
  value: real("value").notNull(),
  sampleSize: integer("sample_size").notNull(),
  platform: text("platform"),
  appVersion: text("app_version"),
  region: text("region"),
  userType: text("user_type"),
  dimensionSignature: text("dimension_signature").notNull(),
  releaseId: text("release_id").references(() => releases.id),
  provenance: text("provenance").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("metric_buckets_fact_unique").on(
    table.metricKey,
    table.bucketStart,
    table.dimensionSignature,
  ),
  index("metric_buckets_metric_time_idx").on(table.metricKey, table.bucketStart),
  index("metric_buckets_release_idx").on(table.releaseId),
]);

export const riskEvents = sqliteTable("risk_events", {
  id: text("id").primaryKey(),
  correlatedReleaseId: text("correlated_release_id").references(() => releases.id),
  metricKey: text("metric_key").notNull(),
  status: text("status").notNull(),
  direction: text("direction").notNull(),
  filtersJson: text("filters_json").notNull(),
  segmentSignature: text("segment_signature").notNull(),
  detectedAt: text("detected_at").notNull(),
  firstBreachedAt: text("first_breached_at").notNull(),
  lastBreachedAt: text("last_breached_at").notNull(),
  observedValue: real("observed_value").notNull(),
  baselineValue: real("baseline_value").notNull(),
  absoluteDeviation: real("absolute_deviation").notNull(),
  relativeDeviation: real("relative_deviation").notNull(),
  sampleSize: integer("sample_size").notNull(),
  thresholdPct: real("threshold_pct").notNull(),
  minSampleSize: integer("min_sample_size").notNull(),
  requiredConsecutiveBuckets: integer("required_consecutive_buckets").notNull(),
  triggerBucketIdsJson: text("trigger_bucket_ids_json").notNull(),
  baselineMethod: text("baseline_method").notNull(),
  baselinePointCount: integer("baseline_point_count").notNull(),
  triggerSignature: text("trigger_signature").notNull(),
  provenance: text("provenance").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("risk_events_trigger_unique").on(table.triggerSignature),
  index("risk_events_release_idx").on(table.correlatedReleaseId),
  index("risk_events_metric_detected_idx").on(table.metricKey, table.detectedAt),
]);

export const investigationRuns = sqliteTable("investigation_runs", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull(),
  riskEventId: text("risk_event_id").references(() => riskEvents.id),
  releaseId: text("release_id").references(() => releases.id),
  question: text("question").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  plannerType: text("planner_type").notNull().default("DETERMINISTIC"),
  status: text("status").notNull(),
  currentIteration: integer("current_iteration").notNull().default(0),
  activeIterationId: text("active_iteration_id"),
  lockVersion: integer("lock_version").notNull().default(0),
  stopReason: text("stop_reason"),
  currentDiagnosisRevision: integer("current_diagnosis_revision").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("investigation_runs_incident_idx").on(table.incidentId),
  index("investigation_runs_created_idx").on(table.createdAt),
]);

export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  argumentsJson: text("arguments_json").notNull(),
  canonicalSignature: text("canonical_signature").notNull(),
  status: text("status").notNull(),
  proposedActionId: text("proposed_action_id"),
  approvalId: text("approval_id"),
  agentIterationId: text("agent_iteration_id"),
  triggerMessageId: text("trigger_message_id"),
  cacheSourceToolCallId: text("cache_source_tool_call_id"),
  iteration: integer("iteration").notNull(),
  orderIndex: integer("order_index").notNull(),
  resultId: text("result_id"),
  requestedAt: text("requested_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
}, (table) => [
  index("tool_calls_run_idx").on(table.runId),
  index("tool_calls_signature_idx").on(table.runId, table.canonicalSignature),
  uniqueIndex("tool_calls_action_unique").on(table.proposedActionId),
]);

export const toolResults = sqliteTable("tool_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  toolCallId: text("tool_call_id").notNull().references(() => toolCalls.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  outputJson: text("output_json"),
  errorMessage: text("error_message"),
  retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("tool_results_call_unique").on(table.toolCallId),
  index("tool_results_run_idx").on(table.runId),
]);

export const evidence = sqliteTable("evidence", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  toolResultId: text("tool_result_id").notNull().references(() => toolResults.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  statement: text("statement").notNull(),
  source: text("source").notNull(),
  strength: text("strength").notNull(),
  provenance: text("provenance").notNull().default("synthetic"),
  collectedAt: text("collected_at").notNull(),
}, (table) => [
  index("evidence_run_idx").on(table.runId),
  index("evidence_result_idx").on(table.toolResultId),
]);

export const diagnoses = sqliteTable("diagnoses", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  selectedHypothesisId: text("selected_hypothesis_id"),
  groundingStatus: text("grounding_status").notNull().default("LEGACY_UNVERIFIED"),
  disposition: text("disposition"),
  rootCause: text("root_cause").notNull(),
  summary: text("summary").notNull(),
  causalChainJson: text("causal_chain_json").notNull(),
  affectedMetricsJson: text("affected_metrics_json").notNull(),
  affectedSegmentsJson: text("affected_segments_json").notNull(),
  validatedClaimsJson: text("validated_claims_json").notNull(),
  unvalidatedClaimsJson: text("unvalidated_claims_json").notNull(),
  confidence: text("confidence").notNull(),
  severity: text("severity").notNull(),
  recommendedAction: text("recommended_action").notNull(),
  revision: integer("revision").notNull().default(1),
  status: text("status").notNull().default("FINAL"),
  supersedesDiagnosisId: text("supersedes_diagnosis_id"),
  supersededAt: text("superseded_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull().default(""),
}, (table) => [
  uniqueIndex("diagnoses_run_revision_unique").on(table.runId, table.revision),
]);

export const proposedActions = sqliteTable("proposed_actions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  status: text("status").notNull(),
  title: text("title").notNull(),
  argumentsJson: text("arguments_json").notNull(),
  rationale: text("rationale").notNull(),
  revision: integer("revision").notNull().default(1),
  supersedesProposedActionId: text("supersedes_proposed_action_id"),
  supersededAt: text("superseded_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("proposed_actions_run_idx").on(table.runId),
  index("proposed_actions_diagnosis_idx").on(table.diagnosisId),
]);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  proposedActionId: text("proposed_action_id").notNull().references(() => proposedActions.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  decision: text("decision"),
  reason: text("reason"),
  requestedBy: text("requested_by").notNull(),
  decidedBy: text("decided_by"),
  targetOwner: text("target_owner"),
  targetRepo: text("target_repo"),
  revision: integer("revision").notNull().default(1),
  supersedesApprovalId: text("supersedes_approval_id"),
  withdrawnAt: text("withdrawn_at"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
}, (table) => [
  uniqueIndex("approvals_action_unique").on(table.proposedActionId),
  index("approvals_run_idx").on(table.runId),
]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  proposedActionId: text("proposed_action_id"),
  approvalId: text("approval_id"),
  toolCallId: text("tool_call_id"),
  type: text("type").notNull(),
  actor: text("actor").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("audit_events_run_idx").on(table.runId, table.createdAt),
  index("audit_events_action_idx").on(table.proposedActionId),
]);

export const agentIterations = sqliteTable("agent_iterations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  trigger: text("trigger").notNull(),
  plannerType: text("planner_type").notNull(),
  status: text("status").notNull(),
  decisionType: text("decision_type"),
  publicRationale: text("public_rationale"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("agent_iterations_run_sequence_unique").on(table.runId, table.sequence),
  index("agent_iterations_run_idx").on(table.runId),
]);

export const hypotheses = sqliteTable("hypotheses", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  statement: text("statement").notNull(),
  supportIf: text("support_if").notNull().default(""),
  refuteIf: text("refute_if").notNull().default(""),
  status: text("status").notNull(),
  confidence: text("confidence").notNull(),
  supportScore: real("support_score").notNull().default(0),
  contradictionScore: real("contradiction_score").notNull().default(0),
  confidenceReason: text("confidence_reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("hypotheses_run_idx").on(table.runId, table.revision),
]);

export const hypothesisEvidenceLinks = sqliteTable("hypothesis_evidence_links", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  hypothesisId: text("hypothesis_id").notNull().references(() => hypotheses.id, { onDelete: "cascade" }),
  evidenceId: text("evidence_id").notNull().references(() => evidence.id, { onDelete: "cascade" }),
  relation: text("relation").notNull(),
  explanation: text("explanation").notNull(),
  linkedBy: text("linked_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("hypothesis_evidence_unique").on(table.hypothesisId, table.evidenceId),
  index("hypothesis_evidence_run_idx").on(table.runId),
]);

export const investigationTraceEvents = sqliteTable("investigation_trace_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  iterationId: text("iteration_id"),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  actor: text("actor").notNull(),
  publicSummary: text("public_summary").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("investigation_trace_run_sequence_unique").on(table.runId, table.sequence),
]);

export const investigationMessages = sqliteTable("investigation_messages", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  clientRequestId: text("client_request_id").notNull(),
  role: text("role").notNull(),
  intent: text("intent").notNull(),
  content: text("content").notNull(),
  citedEvidenceIdsJson: text("cited_evidence_ids_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("investigation_messages_request_unique").on(table.runId, table.clientRequestId),
  index("investigation_messages_run_idx").on(table.runId, table.createdAt),
]);

export const diagnosisEvidenceLinks = sqliteTable("diagnosis_evidence_links", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  evidenceId: text("evidence_id").notNull().references(() => evidence.id, { onDelete: "cascade" }),
  relationship: text("relationship").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("diagnosis_evidence_unique").on(table.diagnosisId, table.evidenceId),
]);

export const diagnosisClaims = sqliteTable("diagnosis_claims", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  limitationType: text("limitation_type"),
  statement: text("statement").notNull(),
  groundingStatus: text("grounding_status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("diagnosis_claims_run_idx").on(table.runId),
  index("diagnosis_claims_diagnosis_idx").on(table.diagnosisId),
]);

export const diagnosisClaimEvidenceLinks = sqliteTable("diagnosis_claim_evidence_links", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  claimId: text("claim_id").notNull().references(() => diagnosisClaims.id, { onDelete: "cascade" }),
  evidenceId: text("evidence_id").notNull().references(() => evidence.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("diagnosis_claim_evidence_unique").on(table.claimId, table.evidenceId),
  index("diagnosis_claim_evidence_run_idx").on(table.runId),
  index("diagnosis_claim_evidence_diagnosis_idx").on(table.diagnosisId),
]);

export const approvalSnapshots = sqliteTable("approval_snapshots", {
  id: text("id").primaryKey(),
  approvalId: text("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  proposedActionId: text("proposed_action_id").notNull().references(() => proposedActions.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  frozenPayloadJson: text("frozen_payload_json").notNull(),
  checksum: text("checksum").notNull(),
  lifecycleStatus: text("lifecycle_status").notNull(),
  createdAt: text("created_at").notNull(),
  withdrawnAt: text("withdrawn_at"),
}, (table) => [
  uniqueIndex("approval_snapshots_approval_unique").on(table.approvalId),
  uniqueIndex("approval_snapshots_run_revision_unique").on(table.runId, table.revision),
]);

export const runtimeCommands = sqliteTable("runtime_commands", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  clientRequestId: text("client_request_id").notNull(),
  commandType: text("command_type").notNull(),
  resultReference: text("result_reference"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("runtime_commands_request_unique").on(table.runId, table.commandType, table.clientRequestId),
]);

export const actionCompletions = sqliteTable("action_completions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  proposedActionId: text("proposed_action_id").notNull().references(() => proposedActions.id, { onDelete: "cascade" }),
  approvalId: text("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  clientRequestId: text("client_request_id").notNull(),
  effectiveAt: text("effective_at").notNull(),
  changeReference: text("change_reference").notNull(),
  note: text("note"),
  confirmedBy: text("confirmed_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("action_completions_run_request_unique").on(table.runId, table.clientRequestId),
  uniqueIndex("action_completions_action_unique").on(table.proposedActionId),
  index("action_completions_run_idx").on(table.runId, table.createdAt),
]);

export const verificationRuns = sqliteTable("verification_runs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  diagnosisId: text("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  actionCompletionId: text("action_completion_id").references(() => actionCompletions.id),
  attempt: integer("attempt").notNull(),
  clientRequestId: text("client_request_id").notNull(),
  status: text("status").notNull(),
  anchorType: text("anchor_type").notNull(),
  anchorAt: text("anchor_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("verification_runs_attempt_unique").on(table.runId, table.attempt),
  uniqueIndex("verification_runs_request_unique").on(table.runId, table.clientRequestId),
  uniqueIndex("verification_runs_active_unique").on(table.runId)
    .where(sql`${table.status} in ('PENDING', 'WAITING_WINDOW', 'RUNNING')`),
  index("verification_runs_history_idx").on(table.runId, table.createdAt),
]);

export const verificationPolicySnapshots = sqliteTable("verification_policy_snapshots", {
  id: text("id").primaryKey(),
  verificationRunId: text("verification_run_id").notNull().references(() => verificationRuns.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  policyVersion: text("policy_version").notNull(),
  anchorAt: text("anchor_at").notNull(),
  settlingPeriodMinutes: integer("settling_period_minutes").notNull(),
  verificationWindowMinutes: integer("verification_window_minutes").notNull(),
  metricKey: text("metric_key").notNull(),
  baselineValue: real("baseline_value"),
  incidentObservedValue: real("incident_observed_value"),
  direction: text("direction"),
  granularityMinutes: integer("granularity_minutes"),
  affectedFiltersJson: text("affected_filters_json").notNull(),
  controlFiltersJson: text("control_filters_json"),
  controlBaselineValue: real("control_baseline_value"),
  minimumSampleSize: integer("minimum_sample_size").notNull(),
  requiredConsecutiveBuckets: integer("required_consecutive_buckets").notNull(),
  metricRecoveryThreshold: real("metric_recovery_threshold").notNull(),
  minimumImprovementThreshold: real("minimum_improvement_threshold").default(0.05).notNull(),
  feedbackTrendThreshold: real("feedback_trend_threshold").notNull(),
  feedbackRequired: integer("feedback_required", { mode: "boolean" }).default(false).notNull(),
  feedbackMinimumSampleSize: integer("feedback_minimum_sample_size").default(5).notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("verification_policy_run_unique").on(table.verificationRunId),
  index("verification_policy_history_idx").on(table.runId, table.createdAt),
]);

export const verificationEvidence = sqliteTable("verification_evidence", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  verificationRunId: text("verification_run_id").notNull().references(() => verificationRuns.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  queryJson: text("query_json").notNull(),
  windowStart: text("window_start").notNull(),
  windowEnd: text("window_end").notNull(),
  sampleSize: integer("sample_size").notNull(),
  observedValue: real("observed_value"),
  baselineValue: real("baseline_value"),
  recoveryRatio: real("recovery_ratio"),
  qualityStatus: text("quality_status").notNull(),
  detailsJson: text("details_json").notNull(),
  provenance: text("provenance").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("verification_evidence_run_idx").on(table.verificationRunId, table.createdAt),
]);

export const verificationEvaluations = sqliteTable("verification_evaluations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => investigationRuns.id, { onDelete: "cascade" }),
  verificationRunId: text("verification_run_id").notNull().references(() => verificationRuns.id, { onDelete: "cascade" }),
  clientRequestId: text("client_request_id").notNull(),
  outcome: text("outcome").notNull(),
  reasonCode: text("reason_code").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("verification_evaluations_run_unique").on(table.verificationRunId),
  uniqueIndex("verification_evaluations_request_unique").on(table.runId, table.clientRequestId),
]);

export const feedbackRecords = sqliteTable("feedback_records", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  platform: text("platform").notNull(),
  appVersion: text("app_version").notNull(),
  region: text("region").notNull(),
  userType: text("user_type").notNull(),
  content: text("content").notNull(),
  tagsJson: text("tags_json").notNull(),
  source: text("source").notNull(),
  sourceReference: text("source_reference").notNull(),
  searchText: text("search_text").notNull(),
}, (table) => [
  index("feedback_records_filter_idx").on(table.platform, table.appVersion, table.timestamp),
]);

export const incidentDocuments = sqliteTable("incident_documents", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull(),
  sourceDocument: text("source_document").notNull(),
  corpusVersion: text("corpus_version").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("incident_documents_corpus_incident_unique").on(table.corpusVersion, table.incidentId),
]);

export const incidentChunks = sqliteTable("incident_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => incidentDocuments.id, { onDelete: "cascade" }),
  incidentId: text("incident_id").notNull(),
  title: text("title").notNull(),
  section: text("section").notNull(),
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull(),
  searchText: text("search_text").notNull(),
  tokenCount: integer("token_count").notNull(),
  contentHash: text("content_hash").notNull(),
  corpusVersion: text("corpus_version").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embeddingJson: text("embedding_json"),
}, (table) => [
  uniqueIndex("incident_chunks_corpus_hash_unique").on(table.corpusVersion, table.contentHash),
  index("incident_chunks_incident_idx").on(table.incidentId),
]);

export const incidentChunkTerms = sqliteTable("incident_chunk_terms", {
  chunkId: text("chunk_id").notNull().references(() => incidentChunks.id, { onDelete: "cascade" }),
  term: text("term").notNull(),
  termFrequency: integer("term_frequency").notNull(),
}, (table) => [
  uniqueIndex("incident_chunk_terms_unique").on(table.chunkId, table.term),
  index("incident_chunk_terms_term_idx").on(table.term),
]);

export const ragIndexVersions = sqliteTable("rag_index_versions", {
  id: text("id").primaryKey(),
  corpusVersion: text("corpus_version").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  dimensions: integer("dimensions").notNull(),
  chunkerVersion: text("chunker_version").notNull(),
  corpusChecksum: text("corpus_checksum").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  activatedAt: text("activated_at"),
}, (table) => [
  uniqueIndex("rag_index_versions_identity_unique").on(
    table.corpusVersion,
    table.embeddingModel,
    table.chunkerVersion,
  ),
]);
