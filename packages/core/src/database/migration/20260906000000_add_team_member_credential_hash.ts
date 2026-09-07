import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906000000_add_team_member_credential_hash",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`team_member\` ADD COLUMN \`credential_hash\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
