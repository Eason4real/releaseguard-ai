import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { investigationRuntimeSchema } from "./runtime-schema";

let initialization: Promise<void> | null = null;

async function initializeRuntimeSchema(d1: Parameters<typeof drizzle>[0]) {
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
  if (!approvalColumns.has("revision")) upgrades.push(d1.prepare("ALTER TABLE approvals ADD COLUMN revision integer DEFAULT 1 NOT NULL"));
  if (!approvalColumns.has("supersedes_approval_id")) upgrades.push(d1.prepare("ALTER TABLE approvals ADD COLUMN supersedes_approval_id text"));
  if (!approvalColumns.has("withdrawn_at")) upgrades.push(d1.prepare("ALTER TABLE approvals ADD COLUMN withdrawn_at text"));
  if (!hypothesisColumns.has("support_if")) upgrades.push(d1.prepare("ALTER TABLE hypotheses ADD COLUMN support_if text DEFAULT '' NOT NULL"));
  if (!hypothesisColumns.has("refute_if")) upgrades.push(d1.prepare("ALTER TABLE hypotheses ADD COLUMN refute_if text DEFAULT '' NOT NULL"));
  if (upgrades.length > 0) await d1.batch(upgrades);
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
  initialization ??= initializeRuntimeSchema(env.DB)
    .catch((error: unknown) => {
      initialization = null;
      throw error;
    });
  await initialization;

  return drizzle(env.DB, { schema });
}
