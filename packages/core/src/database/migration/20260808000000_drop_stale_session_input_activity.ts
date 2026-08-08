import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Dev databases migrated by the feat/oc2-ux-refresh-plan branch carry NOT NULL
// `activity` and `source` columns on `session_input` (added by
// 20260718002000_session_input_activity). The current schema does not include
// those columns, so every prompt insert fails with a NOT NULL constraint and
// the LLM is never invoked. Drop the stale columns when present; fresh
// databases never had them, so the PRAGMA check keeps this migration a no-op
// there.
export default {
  id: "20260808000000_drop_stale_session_input_activity",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session_input\`)`)
      if (columns.some((column) => column.name === "activity"))
        yield* tx.run(`ALTER TABLE \`session_input\` DROP COLUMN \`activity\`;`)
      if (columns.some((column) => column.name === "source"))
        yield* tx.run(`ALTER TABLE \`session_input\` DROP COLUMN \`source\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
