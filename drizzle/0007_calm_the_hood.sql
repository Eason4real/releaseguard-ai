CREATE TABLE `action_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`proposed_action_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`revision` integer NOT NULL,
	`client_request_id` text NOT NULL,
	`effective_at` text NOT NULL,
	`change_reference` text NOT NULL,
	`note` text,
	`confirmed_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposed_action_id`) REFERENCES `proposed_actions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_completions_run_request_unique` ON `action_completions` (`run_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `action_completions_action_unique` ON `action_completions` (`proposed_action_id`);--> statement-breakpoint
CREATE INDEX `action_completions_run_idx` ON `action_completions` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `verification_policy_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`verification_run_id` text NOT NULL,
	`run_id` text NOT NULL,
	`policy_version` text NOT NULL,
	`anchor_at` text NOT NULL,
	`settling_period_minutes` integer NOT NULL,
	`verification_window_minutes` integer NOT NULL,
	`metric_key` text NOT NULL,
	`affected_filters_json` text NOT NULL,
	`control_filters_json` text,
	`minimum_sample_size` integer NOT NULL,
	`required_consecutive_buckets` integer NOT NULL,
	`metric_recovery_threshold` real NOT NULL,
	`feedback_trend_threshold` real NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`verification_run_id`) REFERENCES `verification_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_policy_run_unique` ON `verification_policy_snapshots` (`verification_run_id`);--> statement-breakpoint
CREATE INDEX `verification_policy_history_idx` ON `verification_policy_snapshots` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `verification_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`action_completion_id` text,
	`attempt` integer NOT NULL,
	`client_request_id` text NOT NULL,
	`status` text NOT NULL,
	`anchor_type` text NOT NULL,
	`anchor_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_completion_id`) REFERENCES `action_completions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_runs_attempt_unique` ON `verification_runs` (`run_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_runs_request_unique` ON `verification_runs` (`run_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_runs_active_unique` ON `verification_runs` (`run_id`) WHERE "verification_runs"."status" in ('PENDING', 'WAITING_WINDOW', 'RUNNING');--> statement-breakpoint
CREATE INDEX `verification_runs_history_idx` ON `verification_runs` (`run_id`,`created_at`);