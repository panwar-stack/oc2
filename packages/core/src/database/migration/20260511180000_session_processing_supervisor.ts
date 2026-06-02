import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260511180000_session_processing_supervisor",
  up(tx) {
    return Effect.gen(function* () {
      // These columns briefly shipped through separate Drizzle migrations.
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)
      if (!columns.some((column) => column.name === "time_processing"))
        yield* tx.run(`ALTER TABLE \`session\` ADD \`time_processing\` integer DEFAULT 0 NOT NULL;`)
      if (!columns.some((column) => column.name === "supervisor"))
        yield* tx.run(`ALTER TABLE \`session\` ADD \`supervisor\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
