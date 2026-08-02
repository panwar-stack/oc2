ALTER TABLE `team` ADD COLUMN `protocol_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `team_member` ADD COLUMN `failure_code` text;
