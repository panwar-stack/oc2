CREATE TABLE `session_root` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`name` text,
	`directory` text NOT NULL,
	`worktree` text NOT NULL,
	`project_id` text NOT NULL,
	`path` text,
	`created` integer NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_session_root_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_root_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `session` ADD `time_processing` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `session_root_session_directory_idx` ON `session_root` (`session_id`,`directory`);--> statement-breakpoint
CREATE INDEX `session_root_session_idx` ON `session_root` (`session_id`);