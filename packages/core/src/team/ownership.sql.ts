import { sql } from "drizzle-orm"
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

export type TeamFileOwnership = {
  id: string
  team_id: string
  task_id: string
  root_key: string
  path_key: string
  display_path: string
  owner_session_id: string | null
  time_released: number | null
  time_created: number
  time_updated: number
}

export const TeamFileOwnershipTable = sqliteTable(
  "team_file_ownership",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    task_id: text().notNull(),
    root_key: text().notNull(),
    path_key: text().notNull(),
    display_path: text().notNull(),
    owner_session_id: text(),
    time_released: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => ({
    // Global active-path uniqueness: separate lead sessions can own different
    // teams in the same worktree, so the key is path_key alone while a row is
    // active. Released rows are preserved for audit and excluded from the key.
    active_path_idx: uniqueIndex("team_file_ownership_active_path_idx")
      .on(table.path_key)
      .where(sql`${table.time_released} IS NULL`),
    task_idx: index("team_file_ownership_task_idx").on(table.team_id, table.task_id),
    owner_idx: index("team_file_ownership_owner_session_idx").on(
      table.team_id,
      table.owner_session_id,
      table.time_released,
    ),
  }),
)
