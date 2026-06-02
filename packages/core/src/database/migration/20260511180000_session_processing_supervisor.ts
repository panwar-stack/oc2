import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260511180000_session_processing_supervisor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`time_processing\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`supervisor\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
