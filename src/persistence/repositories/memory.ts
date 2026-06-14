import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { basename, resolve } from "node:path"

import { redactText, redactValue } from "../../logging/redaction"
import { fromJson, toJson } from "./json"

export interface RepositoryMemoryRepositoryRecord {
  readonly id: string
  readonly identity: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RepositoryMemoryEntryRecord {
  readonly id: string
  readonly repositoryId: string
  readonly kind: string
  readonly key: string
  readonly content: string
  readonly tokenText: string
  readonly metadata: Record<string, unknown>
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RepositoryMemorySearchResult extends RepositoryMemoryEntryRecord {
  readonly score: number
}

export interface RepositoryMemoryRetrievalLogRecord {
  readonly id: string
  readonly repositoryId: string
  readonly sessionId?: string
  readonly tool: string
  readonly query: string
  readonly returnedEntryIds: readonly string[]
  readonly selectedEntryIds: readonly string[]
  readonly createdAt: string
}

interface RepositoryRow {
  readonly id: string
  readonly identity: string
  readonly name: string
  readonly created_at: string
  readonly updated_at: string
}

interface EntryRow {
  readonly id: string
  readonly repository_id: string
  readonly kind: string
  readonly entry_key: string
  readonly content: string
  readonly token_text: string
  readonly metadata_json: string
  readonly created_at: string
  readonly updated_at: string
}

interface RetrievalLogRow {
  readonly id: string
  readonly repository_id: string
  readonly session_id: string | null
  readonly tool: string
  readonly query: string
  readonly returned_entry_ids_json: string
  readonly selected_entry_ids_json: string | null
  readonly created_at: string
}

/** Persists local repository memory entries and retrieval logs in SQLite. */
export class RepositoryMemoryRepository {
  constructor(private readonly db: Database) {}

  /** Ensures a local repository identity exists and returns its persisted row. */
  ensureRepository(input: { readonly identity: string; readonly name?: string }): RepositoryMemoryRepositoryRecord {
    const now = new Date().toISOString()
    const identity = normalizeIdentity(input.identity)
    const name = input.name ?? (basename(identity) || identity)
    this.db
      .query(
        `INSERT INTO repository_memory_repositories (id, identity, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(identity) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), identity, name, now, now)

    const row = this.db
      .query<RepositoryRow, [string]>("SELECT * FROM repository_memory_repositories WHERE identity = ?")
      .get(identity)
    if (!row) throw new Error("Repository memory row was not created")
    return mapRepository(row)
  }

  /** Stores or updates a local memory entry for later retrieval. */
  storeEntry(input: {
    readonly repositoryIdentity: string
    readonly repositoryName?: string
    readonly kind?: string
    readonly key: string
    readonly content: string
    readonly metadata?: Record<string, unknown>
  }): RepositoryMemoryEntryRecord {
    const repository = this.ensureRepository({ identity: input.repositoryIdentity, name: input.repositoryName })
    const now = new Date().toISOString()
    const kind = input.kind ?? "note"
    const content = redactText(input.content)
    const metadata = redactValue(input.metadata ?? {}) as Record<string, unknown>
    const tokenText = toTokenText([kind, input.key, content, JSON.stringify(metadata)])
    this.db
      .query(
        `INSERT INTO repository_memory_entries
         (id, repository_id, kind, entry_key, content, token_text, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository_id, kind, entry_key) DO UPDATE SET
           content = excluded.content,
           token_text = excluded.token_text,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), repository.id, kind, input.key, content, tokenText, toJson(metadata), now, now)

    const row = this.db
      .query<
        EntryRow,
        [string, string, string]
      >("SELECT * FROM repository_memory_entries WHERE repository_id = ? AND kind = ? AND entry_key = ?")
      .get(repository.id, kind, input.key)
    if (!row) throw new Error("Repository memory entry was not stored")
    return mapEntry(row)
  }

  /** Retrieves a specific local memory entry by repository, kind, and key. */
  getEntry(input: {
    readonly repositoryIdentity: string
    readonly kind?: string
    readonly key: string
  }): RepositoryMemoryEntryRecord | undefined {
    const repository = this.getRepositoryByIdentity(input.repositoryIdentity)
    if (!repository) return undefined
    const row = this.db
      .query<
        EntryRow,
        [string, string, string]
      >("SELECT * FROM repository_memory_entries WHERE repository_id = ? AND kind = ? AND entry_key = ?")
      .get(repository.id, input.kind ?? "note", input.key)
    return row ? mapEntry(row) : undefined
  }

  /** Searches local memory entries and records the retrieval for observability. */
  search(input: {
    readonly repositoryIdentity: string
    readonly query: string
    readonly kind?: string
    readonly limit?: number
    readonly sessionId?: string
    readonly tool?: string
  }): readonly RepositoryMemorySearchResult[] {
    const repository = this.getRepositoryByIdentity(input.repositoryIdentity)
    if (!repository) return []
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
    const rows = input.kind
      ? this.db
          .query<
            EntryRow,
            [string, string]
          >("SELECT * FROM repository_memory_entries WHERE repository_id = ? AND kind = ? ORDER BY updated_at DESC")
          .all(repository.id, input.kind)
      : this.db
          .query<
            EntryRow,
            [string]
          >("SELECT * FROM repository_memory_entries WHERE repository_id = ? ORDER BY updated_at DESC")
          .all(repository.id)
    const terms = toSearchTerms(input.query)
    const results = rows
      .map((row) => ({ ...mapEntry(row), score: scoreEntry(row.token_text, terms) }))
      .filter((entry) => entry.score > 0 || terms.length === 0)
      .toSorted((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
    this.logRetrieval({
      repositoryId: repository.id,
      sessionId: input.sessionId,
      tool: input.tool ?? "memory",
      query: input.query,
      returnedEntryIds: results.map((entry) => entry.id),
    })
    return results
  }

  /** Appends a retrieval log row without storing external service metadata. */
  logRetrieval(input: {
    readonly repositoryId: string
    readonly sessionId?: string
    readonly tool: string
    readonly query: string
    readonly returnedEntryIds: readonly string[]
    readonly selectedEntryIds?: readonly string[]
  }): RepositoryMemoryRetrievalLogRecord {
    const row = {
      id: randomUUID(),
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
      tool: input.tool,
      query: redactText(input.query),
      returnedEntryIds: input.returnedEntryIds,
      selectedEntryIds: input.selectedEntryIds ?? [],
      createdAt: new Date().toISOString(),
    }
    this.db
      .query(
        `INSERT INTO repository_memory_retrieval_logs
         (id, repository_id, session_id, tool, query, returned_entry_ids_json, selected_entry_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.repositoryId,
        row.sessionId ?? null,
        row.tool,
        row.query,
        toJson(row.returnedEntryIds),
        toJson(row.selectedEntryIds),
        row.createdAt,
      )
    return row
  }

  /** Lists retrieval logs for assertions and local diagnostics. */
  listRetrievalLogs(repositoryIdentity: string): readonly RepositoryMemoryRetrievalLogRecord[] {
    const repository = this.getRepositoryByIdentity(repositoryIdentity)
    if (!repository) return []
    return this.db
      .query<
        RetrievalLogRow,
        [string]
      >("SELECT * FROM repository_memory_retrieval_logs WHERE repository_id = ? ORDER BY created_at DESC, id DESC")
      .all(repository.id)
      .map(mapRetrievalLog)
  }

  private getRepositoryByIdentity(identity: string): RepositoryMemoryRepositoryRecord | undefined {
    const row = this.db
      .query<RepositoryRow, [string]>("SELECT * FROM repository_memory_repositories WHERE identity = ?")
      .get(normalizeIdentity(identity))
    return row ? mapRepository(row) : undefined
  }
}

const normalizeIdentity = (identity: string): string => resolve(identity)

const toTokenText = (parts: readonly string[]): string => parts.join("\n").toLocaleLowerCase()

const toSearchTerms = (query: string): readonly string[] =>
  query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)

const scoreEntry = (tokenText: string, terms: readonly string[]): number =>
  terms.reduce((score, term) => score + (tokenText.includes(term) ? 1 : 0), 0)

const mapRepository = (row: RepositoryRow): RepositoryMemoryRepositoryRecord => ({
  id: row.id,
  identity: row.identity,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapEntry = (row: EntryRow): RepositoryMemoryEntryRecord => ({
  id: row.id,
  repositoryId: row.repository_id,
  kind: row.kind,
  key: row.entry_key,
  content: row.content,
  tokenText: row.token_text,
  metadata: fromJson<Record<string, unknown>>(row.metadata_json, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapRetrievalLog = (row: RetrievalLogRow): RepositoryMemoryRetrievalLogRecord => ({
  id: row.id,
  repositoryId: row.repository_id,
  sessionId: row.session_id ?? undefined,
  tool: row.tool,
  query: row.query,
  returnedEntryIds: fromJson<readonly string[]>(row.returned_entry_ids_json, []),
  selectedEntryIds: fromJson<readonly string[]>(row.selected_entry_ids_json, []),
  createdAt: row.created_at,
})
