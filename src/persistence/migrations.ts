import type { Database } from "bun:sqlite"
import { RuntimeError } from "../events/events"
import { CURRENT_SCHEMA_VERSION, createSchemaSql } from "./schema"

/** Ordered database migration definition applied once by id. */
export interface Migration {
  readonly id: string
  readonly sql: string
}

export const migrations: readonly Migration[] = [
  {
    id: "0001_persistence_session_storage",
    sql: createSchemaSql,
  },
]

interface MigrationRow {
  readonly id: string
}

/** Applies pending migrations in a single transaction and updates SQLite user_version. */
export const applyMigrations = (db: Database): void => {
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    const applied = new Set(
      db
        .query<MigrationRow, []>("SELECT id FROM migrations")
        .all()
        .map((row) => row.id),
    )
    const insertMigration = db.query("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue
      db.exec(migration.sql)
      insertMigration.run(migration.id, new Date().toISOString())
    }

    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`)
    db.exec("COMMIT")
  } catch (cause) {
    db.exec("ROLLBACK")
    throw new RuntimeError({
      code: "unknown",
      message: "Failed to apply database migrations",
      recoverable: false,
      cause,
    })
  }
}

/** Reads applied migration ids in deterministic order for diagnostics/tests. */
export const getAppliedMigrationIds = (db: Database): readonly string[] =>
  db
    .query<MigrationRow, []>("SELECT id FROM migrations ORDER BY id")
    .all()
    .map((row) => row.id)
