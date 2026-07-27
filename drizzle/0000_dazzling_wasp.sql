CREATE TABLE `diagnoses` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`root_cause` text NOT NULL,
	`summary` text NOT NULL,
	`causal_chain_json` text NOT NULL,
	`affected_metrics_json` text NOT NULL,
	`affected_segments_json` text NOT NULL,
	`validated_claims_json` text NOT NULL,
	`unvalidated_claims_json` text NOT NULL,
	`confidence` text NOT NULL,
	`severity` text NOT NULL,
	`recommended_action` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnoses_run_unique` ON `diagnoses` (`run_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_result_id` text NOT NULL,
	`category` text NOT NULL,
	`statement` text NOT NULL,
	`source` text NOT NULL,
	`strength` text NOT NULL,
	`provenance` text DEFAULT 'synthetic' NOT NULL,
	`collected_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_result_id`) REFERENCES `tool_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_run_idx` ON `evidence` (`run_id`);--> statement-breakpoint
CREATE INDEX `evidence_result_idx` ON `evidence` (`tool_result_id`);--> statement-breakpoint
CREATE TABLE `investigation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`question` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `investigation_runs_incident_idx` ON `investigation_runs` (`incident_id`);--> statement-breakpoint
CREATE INDEX `investigation_runs_created_idx` ON `investigation_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `proposed_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`arguments_json` text NOT NULL,
	`rationale` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposed_actions_run_idx` ON `proposed_actions` (`run_id`);--> statement-breakpoint
CREATE INDEX `proposed_actions_diagnosis_idx` ON `proposed_actions` (`diagnosis_id`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`arguments_json` text NOT NULL,
	`canonical_signature` text NOT NULL,
	`status` text NOT NULL,
	`iteration` integer NOT NULL,
	`order_index` integer NOT NULL,
	`result_id` text,
	`requested_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tool_calls_run_idx` ON `tool_calls` (`run_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_signature_idx` ON `tool_calls` (`run_id`,`canonical_signature`);--> statement-breakpoint
CREATE TABLE `tool_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`status` text NOT NULL,
	`output_json` text,
	`error_message` text,
	`retryable` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_results_call_unique` ON `tool_results` (`tool_call_id`);--> statement-breakpoint
CREATE INDEX `tool_results_run_idx` ON `tool_results` (`run_id`);