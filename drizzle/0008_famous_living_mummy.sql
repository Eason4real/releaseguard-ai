CREATE TABLE `verification_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`verification_run_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verification_run_id`) REFERENCES `verification_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_evaluations_run_unique` ON `verification_evaluations` (`verification_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_evaluations_request_unique` ON `verification_evaluations` (`run_id`,`client_request_id`);--> statement-breakpoint
CREATE TABLE `verification_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`verification_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`query_json` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`sample_size` integer NOT NULL,
	`observed_value` real,
	`baseline_value` real,
	`recovery_ratio` real,
	`quality_status` text NOT NULL,
	`details_json` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verification_run_id`) REFERENCES `verification_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `verification_evidence_run_idx` ON `verification_evidence` (`verification_run_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `baseline_value` real;--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `incident_observed_value` real;--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `direction` text;--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `granularity_minutes` integer;--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `control_baseline_value` real;--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `feedback_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `feedback_minimum_sample_size` integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE `verification_policy_snapshots` ADD `minimum_improvement_threshold` real DEFAULT 0.05 NOT NULL;
