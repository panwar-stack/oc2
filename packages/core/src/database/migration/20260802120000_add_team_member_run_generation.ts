import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802120000_add_team_member_run_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`team_member\` ADD COLUMN \`run_generation\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
