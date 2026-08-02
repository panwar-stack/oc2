import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802150000_add_team_revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`team\` ADD COLUMN \`revision\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`team\` ADD COLUMN \`final_report_revision\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
