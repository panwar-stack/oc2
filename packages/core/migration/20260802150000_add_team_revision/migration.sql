ALTER TABLE `team` ADD COLUMN `revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `team` ADD COLUMN `final_report_revision` integer;
