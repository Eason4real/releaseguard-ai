CREATE TABLE `public_incident_import_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`source_record_id` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text NOT NULL,
	`document_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_payload_hash` text NOT NULL,
	`embedding_backend` text NOT NULL,
	`vector_backend` text NOT NULL,
	`failure_stage` text,
	`failure_code` text,
	`failure_message` text,
	`retry_count` integer NOT NULL,
	`ingestion_version` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_incident_attempt_retry_unique` ON `public_incident_import_attempts` (`provider`,`source_record_id`,`content_hash`,`retry_count`);--> statement-breakpoint
CREATE INDEX `public_incident_attempt_status_idx` ON `public_incident_import_attempts` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `public_incident_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`source_record_id` text NOT NULL,
	`document_id` text,
	`status` text NOT NULL,
	`previous_content_hash` text,
	`content_hash` text NOT NULL,
	`source_payload_hash` text NOT NULL,
	`previous_ingestion_version` text,
	`ingestion_version` text NOT NULL,
	`source_url` text NOT NULL,
	`original_source_url` text NOT NULL,
	`detected_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_incident_revision_identity_unique` ON `public_incident_revisions` (`provider`,`source_record_id`,`content_hash`,`status`);--> statement-breakpoint
CREATE INDEX `public_incident_revision_source_idx` ON `public_incident_revisions` (`provider`,`source_record_id`,`detected_at`);--> statement-breakpoint
ALTER TABLE `incident_chunks` ADD `corpus_type` text DEFAULT 'FIXTURE' NOT NULL;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `corpus_type` text DEFAULT 'FIXTURE' NOT NULL;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `source_provider` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `source_record_id` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `original_source_url` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `dataset_license_name` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `dataset_license_url` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `original_rights_status` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `original_license_name` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `original_license_url` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `source_payload_hash` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `snapshot_version` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `index_status` text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `retrieved_at` text;--> statement-breakpoint
ALTER TABLE `incident_documents` ADD `ingestion_version` text;--> statement-breakpoint
CREATE UNIQUE INDEX `incident_documents_source_identity_unique` ON `incident_documents` (`source_provider`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `incident_documents_corpus_type_idx` ON `incident_documents` (`corpus_type`);--> statement-breakpoint
CREATE INDEX `incident_documents_source_url_idx` ON `incident_documents` (`source_url`);