CREATE TABLE `diagnosis_claim_evidence_links` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claim_id`) REFERENCES `diagnosis_claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnosis_claim_evidence_unique` ON `diagnosis_claim_evidence_links` (`claim_id`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `diagnosis_claim_evidence_run_idx` ON `diagnosis_claim_evidence_links` (`run_id`);--> statement-breakpoint
CREATE INDEX `diagnosis_claim_evidence_diagnosis_idx` ON `diagnosis_claim_evidence_links` (`diagnosis_id`);--> statement-breakpoint
CREATE TABLE `diagnosis_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`type` text NOT NULL,
	`limitation_type` text,
	`statement` text NOT NULL,
	`grounding_status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `investigation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `diagnosis_claims_run_idx` ON `diagnosis_claims` (`run_id`);--> statement-breakpoint
CREATE INDEX `diagnosis_claims_diagnosis_idx` ON `diagnosis_claims` (`diagnosis_id`);--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `selected_hypothesis_id` text;--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `grounding_status` text DEFAULT 'LEGACY_UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `disposition` text;
