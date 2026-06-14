import type { Database } from "bun:sqlite"
import { fromJson, toJson } from "./json"

/** Persisted status snapshot for one MCP server. */
export interface McpSnapshot {
  readonly id: string
  readonly serverId: string
  readonly createdAt: string
  readonly status: unknown
}

interface McpSnapshotRow {
  readonly id: string
  readonly server_id: string
  readonly created_at: string
  readonly status_json: string
}

/** Repository for recording and reading latest MCP server status snapshots. */
export class McpSnapshotRepository {
  constructor(private readonly db: Database) {}

  append(
    input: Omit<McpSnapshot, "id" | "createdAt"> & { readonly id?: string; readonly createdAt?: string },
  ): McpSnapshot {
    const snapshot: McpSnapshot = {
      id: input.id ?? crypto.randomUUID(),
      serverId: input.serverId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      status: input.status,
    }
    this.db
      .query("INSERT INTO mcp_snapshots (id, server_id, created_at, status_json) VALUES (?, ?, ?, ?)")
      .run(snapshot.id, snapshot.serverId, snapshot.createdAt, toJson(snapshot.status))
    return snapshot
  }

  latest(serverId: string): McpSnapshot | undefined {
    const row = this.db
      .query<
        McpSnapshotRow,
        [string]
      >("SELECT * FROM mcp_snapshots WHERE server_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(serverId)
    return row
      ? {
          id: row.id,
          serverId: row.server_id,
          createdAt: row.created_at,
          status: fromJson(row.status_json, null),
        }
      : undefined
  }
}
