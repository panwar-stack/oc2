CREATE TABLE `session_pause_blocker` (
	`session_id` text NOT NULL,
	`cascade_id` text NOT NULL,
	CONSTRAINT `session_pause_blocker_pk` PRIMARY KEY(`session_id`, `cascade_id`),
	CONSTRAINT `fk_session_pause_blocker_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_pause_blocker_cascade_id_session_pause_cascade_id_fk` FOREIGN KEY (`cascade_id`) REFERENCES `session_pause_cascade`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_pause_cascade` (
	`id` text PRIMARY KEY,
	`root_session_id` text NOT NULL,
	`generation` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_released` integer,
	CONSTRAINT `fk_session_pause_cascade_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_resume_intent` (
	`session_id` text PRIMARY KEY,
	`generation` integer NOT NULL,
	`reason` text NOT NULL,
	CONSTRAINT `fk_session_resume_intent_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_pause_blocker_cascade_idx` ON `session_pause_blocker` (`cascade_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_pause_cascade_root_generation_idx` ON `session_pause_cascade` (`root_session_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_pause_cascade_active_root_idx` ON `session_pause_cascade` (`root_session_id`) WHERE "session_pause_cascade"."time_released" IS NULL;