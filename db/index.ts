import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { investigationRuntimeSchema } from "./runtime-schema";
import { DEFAULT_MAX_MODEL_CALLS } from "../lib/investigation/model-call-budget";
import { isLocalSchemaAutoMigrationEnabled } from "../lib/deployment-mode";

type D1Database = Parameters<typeof drizzle>[0];

let schemaReadiness: Promise<void> | null = null;

const requiredRuntimeColumns = {
  investigation_runs: ["model_call_count", "max_model_calls", "stop_reason"],
  tool_calls: ["execution_attempt_id", "execution_lease_expires_at", "external_dispatch_started_at"],
  hypotheses: ["support_if", "refute_if"],
  diagnoses: ["selected_hypothesis_id", "grounding_status", "disposition"],
  verification_policy_snapshots: ["baseline_value", "minimum_improvement_threshold"],
  incident_documents: ["corpus_type", "index_status"],
  public_incident_import_attempts: ["status", "content_hash"],
} as const;

export class RuntimeSchemaMigrationRequiredError extends Error {
  readonly code = "DATABASE_MIGRATION_REQUIRED";

  constructor(readonly missing: string[]) {
    super("The production database schema is not ready. Apply ordered Drizzle migrations before serving traffic.");
    this.name = "RuntimeSchemaMigrationRequiredError";
  }
}

export async function assertRuntimeSchemaReady(d1: D1Database) {
  const missing: string[] = [];
  for (const [table, expectedColumns] of Object.entries(requiredRuntimeColumns)) {
    const info = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const columns = new Set(info.results.map((column: { name: string }) => column.name));
    if (columns.size === 0) missing.push(table);
    else expectedColumns.forEach((column) => {
      if (!columns.has(column)) missing.push(`${table}.${column}`);
    });
  }
  if (missing.length > 0) throw new RuntimeSchemaMigrationRequiredError(missing);
}

async function initializeRuntimeSchema(d1: D1Database) {
  const tableStatements = investigationRuntimeSchema.filter((statement) =>
    statement.trimStart().startsWith("CREATE TABLE"));
  const indexStatements = investigationRuntimeSchema.filter((statement) =>
    !statement.trimStart().startsWith("CREATE TABLE"));
  await d1.batch(tableStatements.map((statement) => d1.prepare(statement)));

  const toolInfo = await d1.prepare("PRAGMA table_info(tool_calls)").all<{ name: string }>();
  const toolColumns = new Set(toolInfo.results.map((column: { name: string }) => column.name));
  const actionInfo = await d1.prepare("PRAGMA table_info(proposed_actions)").all<{ name: string }>();
  const actionColumns = new Set(actionInfo.results.map((column: { name: string }) => column.name));
  const runInfo = await d1.prepare("PRAGMA table_info(investigation_runs)").all<{ name: string }>();
  const runColumns = new Set(runInfo.results.map((column: { name: string }) => column.name));
  const diagnosisInfo = await d1.prepare("PRAGMA table_info(diagnoses)").all<{ name: string }>();
  const diagnosisColumns = new Set(diagnosisInfo.results.map((column: { name: string }) => column.name));
  const approvalInfo = await d1.prepare("PRAGMA table_info(approvals)").all<{ name: string }>();
  const approvalColumns = new Set(approvalInfo.results.map((column: { name: string }) => column.name));
  const hypothesisInfo = await d1.prepare("PRAGMA table_info(hypotheses)").all<{ name: string }>();
  const hypothesisColumns = new Set(hypothesisInfo.results.map((column: { name: string }) => column.name));
  const diagnosisClaimInfo = await d1.prepare("PRAGMA table_info(diagnosis_claims)").all<{ name: string }>();
  const diagnosisClaimColumns = new Set(diagnosisClaimInfo.results.map((column: { name: string }) => column.name));
  const verificationPolicyInfo = await d1.prepare("PRAGMA table_info(verification_policy_snapshots)").all<{ name: string }>();
  const verificationPolicyColumns = new Set(verificationPolicyInfo.results.map((column: { name: string }) => column.name));
  const incidentDocumentInfo = await d1.prepare("PRAGMA table_info(incident_documents)").all<{ name: string }>();
  const incidentDocumentColumns = new Set(incidentDocumentInfo.results.map((column: { name: string }) => column.name));
  const incidentChunkInfo = await d1.prepare("PRAGMA table_info(incident_chunks)").all<{ name: string }>();
  const incidentChunkColumns = new Set(incidentChunkInfo.results.map((column: { name: string }) => column.name));
  const upgrades = [];
  if (!runColumns.has("risk_event_id")) {
    upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN risk_event_id text REFERENCES risk_events(id)"));
  }
  if (!runColumns.has("release_id")) {
    upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN release_id text REFERENCES releases(id)"));
  }
  if (!runColumns.has("planner_type")) upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN planner_type text DEFAULT 'DETERMINISTIC' NOT NULL"));
  if (!runColumns.has("current_iteration")) upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN current_iteration integer DEFAULT 0 NOT NULL"));
  if (!runColumns.has("active_iteration_id")) upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN active_iteration_id text"));
  if (!runColumns.has("lock_version")) upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN lock_version integer DEFAULT 0 NOT NULL"));
  if (!runColumns.has("model_call_count")) upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN model_call_count integer DEFAULT 0 NOT NULL"));
  if (!runColumns.has("max_model_calls")) upgrades.push(d1.prepare(`ALTER TABLE investigation_runs ADD COLUMN max_model_calls integer DEFAULT ${DEFAULT_MAX_MODEL_CALLS} NOT NULL`));
  if (!runColumns.has("stop_reason")) upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN stop_reason text"));
  if (!runColumns.has("current_diagnosis_revision")) upgrades.push(d1.prepare("ALTER TABLE investigation_runs ADD COLUMN current_diagnosis_revision integer DEFAULT 0 NOT NULL"));
  if (!toolColumns.has("proposed_action_id")) {
    upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN proposed_action_id text"));
  }
  if (!toolColumns.has("approval_id")) {
    upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN approval_id text"));
  }
  if (!toolColumns.has("agent_iteration_id")) upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN agent_iteration_id text"));
  if (!toolColumns.has("trigger_message_id")) upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN trigger_message_id text"));
  if (!toolColumns.has("cache_source_tool_call_id")) upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN cache_source_tool_call_id text"));
  if (!toolColumns.has("execution_attempt_id")) upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN execution_attempt_id text"));
  if (!toolColumns.has("execution_lease_expires_at")) upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN execution_lease_expires_at text"));
  if (!toolColumns.has("external_dispatch_started_at")) upgrades.push(d1.prepare("ALTER TABLE tool_calls ADD COLUMN external_dispatch_started_at text"));
  if (!actionColumns.has("updated_at")) {
    upgrades.push(d1.prepare("ALTER TABLE proposed_actions ADD COLUMN updated_at text NOT NULL DEFAULT ''"));
  }
  if (!actionColumns.has("revision")) upgrades.push(d1.prepare("ALTER TABLE proposed_actions ADD COLUMN revision integer DEFAULT 1 NOT NULL"));
  if (!actionColumns.has("supersedes_proposed_action_id")) upgrades.push(d1.prepare("ALTER TABLE proposed_actions ADD COLUMN supersedes_proposed_action_id text"));
  if (!actionColumns.has("superseded_at")) upgrades.push(d1.prepare("ALTER TABLE proposed_actions ADD COLUMN superseded_at text"));
  if (!diagnosisColumns.has("revision")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN revision integer DEFAULT 1 NOT NULL"));
  if (!diagnosisColumns.has("status")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN status text DEFAULT 'FINAL' NOT NULL"));
  if (!diagnosisColumns.has("supersedes_diagnosis_id")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN supersedes_diagnosis_id text"));
  if (!diagnosisColumns.has("superseded_at")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN superseded_at text"));
  if (!diagnosisColumns.has("updated_at")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN updated_at text DEFAULT '' NOT NULL"));
  if (!diagnosisColumns.has("selected_hypothesis_id")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN selected_hypothesis_id text"));
  if (!diagnosisColumns.has("grounding_status")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN grounding_status text DEFAULT 'LEGACY_UNVERIFIED' NOT NULL"));
  if (!diagnosisColumns.has("disposition")) upgrades.push(d1.prepare("ALTER TABLE diagnoses ADD COLUMN disposition text"));
  if (!approvalColumns.has("revision")) upgrades.push(d1.prepare("ALTER TABLE approvals ADD COLUMN revision integer DEFAULT 1 NOT NULL"));
  if (!approvalColumns.has("supersedes_approval_id")) upgrades.push(d1.prepare("ALTER TABLE approvals ADD COLUMN supersedes_approval_id text"));
  if (!approvalColumns.has("withdrawn_at")) upgrades.push(d1.prepare("ALTER TABLE approvals ADD COLUMN withdrawn_at text"));
  if (!hypothesisColumns.has("support_if")) upgrades.push(d1.prepare("ALTER TABLE hypotheses ADD COLUMN support_if text DEFAULT '' NOT NULL"));
  if (!hypothesisColumns.has("refute_if")) upgrades.push(d1.prepare("ALTER TABLE hypotheses ADD COLUMN refute_if text DEFAULT '' NOT NULL"));
  if (!diagnosisClaimColumns.has("limitation_type")) upgrades.push(d1.prepare("ALTER TABLE diagnosis_claims ADD COLUMN limitation_type text"));
  if (!verificationPolicyColumns.has("baseline_value")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN baseline_value real"));
  if (!verificationPolicyColumns.has("incident_observed_value")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN incident_observed_value real"));
  if (!verificationPolicyColumns.has("direction")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN direction text"));
  if (!verificationPolicyColumns.has("granularity_minutes")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN granularity_minutes integer"));
  if (!verificationPolicyColumns.has("feedback_required")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN feedback_required integer DEFAULT 0 NOT NULL"));
  if (!verificationPolicyColumns.has("feedback_minimum_sample_size")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN feedback_minimum_sample_size integer DEFAULT 5 NOT NULL"));
  if (!verificationPolicyColumns.has("control_baseline_value")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN control_baseline_value real"));
  if (!verificationPolicyColumns.has("minimum_improvement_threshold")) upgrades.push(d1.prepare("ALTER TABLE verification_policy_snapshots ADD COLUMN minimum_improvement_threshold real DEFAULT 0.05 NOT NULL"));
  if (!incidentDocumentColumns.has("corpus_type")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN corpus_type text DEFAULT 'FIXTURE' NOT NULL"));
  if (!incidentDocumentColumns.has("source_provider")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN source_provider text"));
  if (!incidentDocumentColumns.has("source_record_id")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN source_record_id text"));
  if (!incidentDocumentColumns.has("source_url")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN source_url text"));
  if (!incidentDocumentColumns.has("original_source_url")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN original_source_url text"));
  if (!incidentDocumentColumns.has("dataset_license_name")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN dataset_license_name text"));
  if (!incidentDocumentColumns.has("dataset_license_url")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN dataset_license_url text"));
  if (!incidentDocumentColumns.has("original_rights_status")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN original_rights_status text"));
  if (!incidentDocumentColumns.has("original_license_name")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN original_license_name text"));
  if (!incidentDocumentColumns.has("original_license_url")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN original_license_url text"));
  if (!incidentDocumentColumns.has("source_payload_hash")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN source_payload_hash text"));
  if (!incidentDocumentColumns.has("snapshot_version")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN snapshot_version text"));
  if (!incidentDocumentColumns.has("index_status")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN index_status text DEFAULT 'ACTIVE' NOT NULL"));
  if (!incidentDocumentColumns.has("retrieved_at")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN retrieved_at text"));
  if (!incidentDocumentColumns.has("ingestion_version")) upgrades.push(d1.prepare("ALTER TABLE incident_documents ADD COLUMN ingestion_version text"));
  if (!incidentChunkColumns.has("corpus_type")) upgrades.push(d1.prepare("ALTER TABLE incident_chunks ADD COLUMN corpus_type text DEFAULT 'FIXTURE' NOT NULL"));
  if (upgrades.length > 0) await d1.batch(upgrades);
  await d1.prepare(`UPDATE tool_calls
    SET status = 'COMPLETED'
    WHERE name = 'create_github_issue'
      AND status = 'SUCCESS'
      AND result_id IS NOT NULL`).run();
  await d1.prepare("DROP INDEX IF EXISTS diagnoses_run_unique").run();
  await d1.batch(indexStatements.map((statement) => d1.prepare(statement)));
}

export async function getDb() {
  const workersModule = "cloudflare:workers";
  const { env } = await import(/* @vite-ignore */ workersModule) as {
    env: { DB?: Parameters<typeof drizzle>[0] };
  };
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }
  schemaReadiness ??= (isLocalSchemaAutoMigrationEnabled()
    ? initializeRuntimeSchema(env.DB)
    : assertRuntimeSchemaReady(env.DB))
    .catch((error: unknown) => {
      schemaReadiness = null;
      throw error;
    });
  await schemaReadiness;

  return drizzle(env.DB, { schema });
}
