ALTER TABLE `investigation_runs` ADD `model_call_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `max_model_calls` integer DEFAULT 20 NOT NULL;