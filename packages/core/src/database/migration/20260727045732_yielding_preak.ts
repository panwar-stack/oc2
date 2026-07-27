import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727045732_yielding_preak",
  up() {
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
