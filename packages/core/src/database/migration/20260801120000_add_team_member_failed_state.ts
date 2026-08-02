import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801120000_add_team_member_failed_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`team\` ADD COLUMN \`protocol_version\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team_member\` ADD COLUMN \`failure_code\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
