import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { RuntimeError } from "../events/events"
import { applyMigrations } from "./migrations"

export interface OpenDatabaseOptions {
  readonly path: string
  readonly readonly?: boolean
  readonly migrate?: boolean
}

/** Open database handle exposed to repository-backed services. */
export interface Oc2Database {
  readonly sqlite: Database
  close(): void
}

/** Opens the SQLite database, applies safety pragmas, and runs migrations by default. */
export const openOc2Database = (options: OpenDatabaseOptions): Oc2Database => {
  const shouldCreateParent = options.path !== ":memory:" && !options.readonly
  if (shouldCreateParent) mkdirSync(dirname(options.path), { recursive: true })

  try {
    const sqlite = new Database(options.path, { readonly: options.readonly ?? false, create: options.readonly !== true })
    sqlite.exec("PRAGMA foreign_keys = ON")
    sqlite.exec("PRAGMA busy_timeout = 5000")
    if (!options.readonly && options.path !== ":memory:") {
      // WAL improves concurrent readers for the long-lived application database.
      sqlite.exec("PRAGMA journal_mode = WAL")
      sqlite.exec("PRAGMA synchronous = NORMAL")
    }
    if (options.migrate ?? true) applyMigrations(sqlite)
    return { sqlite, close: () => sqlite.close() }
  } catch (cause) {
    throw new RuntimeError({
      code: "unknown",
      message: `Failed to open oc2 database at ${options.path}`,
      recoverable: false,
      cause,
    })
  }
}
