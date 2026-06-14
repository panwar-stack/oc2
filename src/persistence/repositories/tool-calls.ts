import type { Database } from "bun:sqlite"
import type { RuntimeErrorShape } from "../../events/events"
import type { RuntimeStatus } from "../../session/message"
import { fromJson, toJson } from "./json"

/** Durable snapshot of a tool call's latest execution state. */
export interface PersistedToolCall {
  readonly id: string
  readonly sessionId: string
  readonly messageId?: string
  readonly name: string
  readonly input: unknown
  readonly status: RuntimeStatus
  readonly startedAt?: string
  readonly completedAt?: string
  readonly result?: unknown
  readonly error?: RuntimeErrorShape
}

interface ToolCallRow {
  readonly id: string
  readonly session_id: string
  readonly message_id: string | null
  readonly name: string
  readonly input_json: string
  readonly status: RuntimeStatus
  readonly started_at: string | null
  readonly completed_at: string | null
  readonly result_json: string | null
  readonly error_json: string | null
}

/** Repository for upserting and reading tool call execution snapshots. */
export class ToolCallRepository {
  constructor(private readonly db: Database) {}

  upsert(call: PersistedToolCall): PersistedToolCall {
    // Preserve one row per logical call while refreshing its latest state.
    this.db
      .query(
        `INSERT INTO tool_calls
        (id, session_id, message_id, name, input_json, status, started_at, completed_at, result_json, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          message_id = excluded.message_id,
          name = excluded.name,
          input_json = excluded.input_json,
          status = excluded.status,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          result_json = excluded.result_json,
          error_json = excluded.error_json`,
      )
      .run(
        call.id,
        call.sessionId,
        call.messageId ?? null,
        call.name,
        toJson(call.input),
        call.status,
        call.startedAt ?? null,
        call.completedAt ?? null,
        call.result === undefined ? null : toJson(call.result),
        call.error === undefined ? null : toJson(call.error),
      )
    return this.get(call.id) as PersistedToolCall
  }

  get(id: string): PersistedToolCall | undefined {
    const row = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?").get(id)
    return row ? this.toRecord(row) : undefined
  }

  listBySession(sessionId: string): readonly PersistedToolCall[] {
    return this.db
      .query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY started_at, id")
      .all(sessionId)
      .map((row) => this.toRecord(row))
  }

  private toRecord(row: ToolCallRow): PersistedToolCall {
    return {
      id: row.id,
      sessionId: row.session_id,
      messageId: row.message_id ?? undefined,
      name: row.name,
      input: fromJson(row.input_json, null),
      status: row.status,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      result: fromJson<unknown | undefined>(row.result_json, undefined),
      error: fromJson<RuntimeErrorShape | undefined>(row.error_json, undefined),
    }
  }
}
