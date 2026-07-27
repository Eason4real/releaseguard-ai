CREATE TABLE `metric_buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`metric_key` text NOT NULL,
	`bucket_start` text NOT NULL,
	`bucket_end` text NOT NULL,
	`granularity_minutes` integer NOT NULL,
	`numerator` integer,
	`denominator` integer,
	`value` real NOT NULL,
	`sample_size` integer NOT NULL,
	`platform` text,
	`app_version` text,
	`region` text,
	`user_type` text,
	`dimension_signature` text NOT NULL,
	`release_id` text,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_buckets_fact_unique` ON `metric_buckets` (`metric_key`,`bucket_start`,`dimension_signature`);--> statement-breakpoint
CREATE INDEX `metric_buckets_metric_time_idx` ON `metric_buckets` (`metric_key`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `metric_buckets_release_idx` ON `metric_buckets` (`release_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`platform` text NOT NULL,
	`released_at` text NOT NULL,
	`rollout_status` text NOT NULL,
	`rollout_percentage` real NOT NULL,
	`feature_flags_json` text NOT NULL,
	`changed_modules_json` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_platform_version_unique` ON `releases` (`platform`,`version`);--> statement-breakpoint
CREATE INDEX `releases_released_idx` ON `releases` (`released_at`);--> statement-breakpoint
CREATE TABLE `risk_events` (
	`id` text PRIMARY KEY NOT NULL,
	`correlated_release_id` text,
	`metric_key` text NOT NULL,
	`status` text NOT NULL,
	`direction` text NOT NULL,
	`filters_json` text NOT NULL,
	`segment_signature` text NOT NULL,
	`detected_at` text NOT NULL,
	`first_breached_at` text NOT NULL,
	`last_breached_at` text NOT NULL,
	`observed_value` real NOT NULL,
	`baseline_value` real NOT NULL,
	`absolute_deviation` real NOT NULL,
	`relative_deviation` real NOT NULL,
	`sample_size` integer NOT NULL,
	`threshold_pct` real NOT NULL,
	`min_sample_size` integer NOT NULL,
	`required_consecutive_buckets` integer NOT NULL,
	`trigger_bucket_ids_json` text NOT NULL,
	`baseline_method` text NOT NULL,
	`baseline_point_count` integer NOT NULL,
	`trigger_signature` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`correlated_release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `risk_events_trigger_unique` ON `risk_events` (`trigger_signature`);--> statement-breakpoint
CREATE INDEX `risk_events_release_idx` ON `risk_events` (`correlated_release_id`);--> statement-breakpoint
CREATE INDEX `risk_events_metric_detected_idx` ON `risk_events` (`metric_key`,`detected_at`);--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `risk_event_id` text REFERENCES risk_events(id);--> statement-breakpoint
ALTER TABLE `investigation_runs` ADD `release_id` text REFERENCES releases(id);
