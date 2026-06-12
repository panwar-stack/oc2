import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260612000000_add_team_member_daemon_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `lifecycle` text DEFAULT 'task' NOT NULL")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `daemon_state` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `daemon_last_active` integer")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `daemon_error` text")
    })
  },
} satisfies DatabaseMigration.Migration
