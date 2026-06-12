ALTER TABLE `team_member` ADD COLUMN `lifecycle` text DEFAULT 'task' NOT NULL;
ALTER TABLE `team_member` ADD COLUMN `daemon_state` text;
ALTER TABLE `team_member` ADD COLUMN `daemon_last_active` integer;
ALTER TABLE `team_member` ADD COLUMN `daemon_error` text;
