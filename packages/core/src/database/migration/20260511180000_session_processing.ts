import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260511180000_session_processing",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)
      if (!columns.some((column) => column.name === "time_processing"))
        yield* tx.run(`ALTER TABLE \`session\` ADD \`time_processing\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
