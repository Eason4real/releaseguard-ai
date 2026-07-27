CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`proposed_action_id` text NOT NULL,
	`status` text NOT NULL,
	`decision` text,
	`reason` text,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`target_owner` text,
	`target_repo` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposed_action_id`) REFERENCES `proposed_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_action_unique` ON `approvals` (`proposed_action_id`);--> statement-breakpoint
CREATE INDEX `approvals_run_idx` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`proposed_action_id` text,
	`approval_id` text,
	`tool_call_id` text,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_events_run_idx` ON `audit_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`proposed_action_id`);--> statement-breakpoint
ALTER TABLE `proposed_actions` ADD `updated_at` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `proposed_action_id` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `approval_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_action_unique` ON `tool_calls` (`proposed_action_id`);
