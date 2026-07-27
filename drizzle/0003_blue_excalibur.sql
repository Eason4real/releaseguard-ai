CREATE TABLE `agent_iterations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`trigger` text NOT NULL,
	`planner_type` text NOT NULL,
	`status` text NOT NULL,
	`decision_type` text,
	`public_rationale` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_iterations_run_sequence_unique` ON `agent_iterations` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `agent_iterations_run_idx` ON `agent_iterations` (`run_id`);--> statement-breakpoint
CREATE TABLE `approval_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`run_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`proposed_action_id` text NOT NULL,
	`revision` integer NOT NULL,
	`frozen_payload_json` text NOT NULL,
	`checksum` text NOT NULL,
	`lifecycle_status` text NOT NULL,
	`created_at` text NOT NULL,
	`withdrawn_at` text,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposed_action_id`) REFERENCES `proposed_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_snapshots_approval_unique` ON `approval_snapshots` (`approval_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `approval_snapshots_run_revision_unique` ON `approval_snapshots` (`run_id`,`revision`);--> statement-breakpoint
CREATE TABLE `diagnosis_evidence_links` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`relationship` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnosis_evidence_unique` ON `diagnosis_evidence_links` (`diagnosis_id`,`evidence_id`);--> statement-breakpoint
CREATE TABLE `feedback_records` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`platform` text NOT NULL,
	`app_version` text NOT NULL,
	`region` text NOT NULL,
	`user_type` text NOT NULL,
	`content` text NOT NULL,
	`tags_json` text NOT NULL,
	`source` text NOT NULL,
	`source_reference` text NOT NULL,
	`search_text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_records_filter_idx` ON `feedback_records` (`platform`,`app_version`,`timestamp`);--> statement-breakpoint
CREATE TABLE `hypotheses` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`revision` integer NOT NULL,
	`statement` text NOT NULL,
	`status` text NOT NULL,
	`confidence` text NOT NULL,
	`support_score` real DEFAULT 0 NOT NULL,
	`contradiction_score` real DEFAULT 0 NOT NULL,
	`confidence_reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hypotheses_run_idx` ON `hypotheses` (`run_id`,`revision`);--> statement-breakpoint
CREATE TABLE `hypothesis_evidence_links` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`hypothesis_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`relation` text NOT NULL,
	`explanation` text NOT NULL,
	`linked_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hypothesis_id`) REFERENCES `hypotheses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hypothesis_evidence_unique` ON `hypothesis_evidence_links` (`hypothesis_id`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `hypothesis_evidence_run_idx` ON `hypothesis_evidence_links` (`run_id`);--> statement-breakpoint
CREATE TABLE `incident_chunk_terms` (
	`chunk_id` text NOT NULL,
	`term` text NOT NULL,
	`term_frequency` integer NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `incident_chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incident_chunk_terms_unique` ON `incident_chunk_terms` (`chunk_id`,`term`);--> statement-breakpoint
CREATE INDEX `incident_chunk_terms_term_idx` ON `incident_chunk_terms` (`term`);--> statement-breakpoint
CREATE TABLE `incident_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`title` text NOT NULL,
	`section` text NOT NULL,
	`content` text NOT NULL,
	`metadata_json` text NOT NULL,
	`search_text` text NOT NULL,
	`token_count` integer NOT NULL,
	`content_hash` text NOT NULL,
	`corpus_version` text NOT NULL,
	`embedding_model` text NOT NULL,
	`embedding_json` text,
	FOREIGN KEY (`document_id`) REFERENCES `incident_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incident_chunks_corpus_hash_unique` ON `incident_chunks` (`corpus_version`,`content_hash`);--> statement-breakpoint
CREATE INDEX `incident_chunks_incident_idx` ON `incident_chunks` (`incident_id`);--> statement-breakpoint
CREATE TABLE `incident_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`metadata_json` text NOT NULL,
	`source_document` text NOT NULL,
	`corpus_version` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incident_documents_corpus_incident_unique` ON `incident_documents` (`corpus_version`,`incident_id`);--> statement-breakpoint
CREATE TABLE `investigation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`role` text NOT NULL,
	`intent` text NOT NULL,
	`content` text NOT NULL,
	`cited_evidence_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investigation_messages_request_unique` ON `investigation_messages` (`run_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `investigation_messages_run_idx` ON `investigation_messages` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `investigation_trace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`iteration_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`public_summary` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investigation_trace_run_sequence_unique` ON `investigation_trace_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `rag_index_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`corpus_version` text NOT NULL,
	`embedding_model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`chunker_version` text NOT NULL,
	`corpus_checksum` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`activated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rag_index_versions_corpus_unique` ON `rag_index_versions` (`corpus_version`);--> statement-breakpoint
CREATE TABLE `runtime_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`command_type` text NOT NULL,
	`result_reference` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_commands_request_unique` ON `runtime_commands` (`run_id`,`command_type`,`client_request_id`);--> statement-breakpoint
DROP INDEX `diagnoses_run_unique`;--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `status` text DEFAULT 'FINAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `supersedes_diagnosis_id` text;--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `superseded_at` text;--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `updated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `diagnoses_run_revision_unique` ON `diagnoses` (`run_id`,`revision`);--> statement-breakpoint
ALTER TABLE `approvals` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `supersedes_approval_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `withdrawn_at` text;--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `planner_type` text DEFAULT 'DETERMINISTIC' NOT NULL;--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `current_iteration` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `active_iteration_id` text;--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `lock_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `current_diagnosis_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `proposed_actions` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `proposed_actions` ADD `supersedes_proposed_action_id` text;--> statement-breakpoint
ALTER TABLE `proposed_actions` ADD `superseded_at` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `agent_iteration_id` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `trigger_message_id` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `cache_source_tool_call_id` text;