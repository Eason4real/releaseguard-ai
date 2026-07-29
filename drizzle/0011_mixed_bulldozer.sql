ALTER TABLE `tool_calls` ADD `execution_attempt_id` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `execution_lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `external_dispatch_started_at` text;--> statement-breakpoint
UPDATE `tool_calls`
SET `status` = 'COMPLETED'
WHERE `name` = 'create_github_issue'
  AND `status` = 'SUCCESS'
  AND `result_id` IS NOT NULL;
