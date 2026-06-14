import type { Database } from "bun:sqlite"
import type { RuntimeEvent, RuntimeEventType } from "../../events/events"
import { fromJson, toJson } from "./json"

/** Runtime event shape after conversion to persistence-friendly values. */
export interface PersistedRuntimeEvent {
  readonly id: string
  readonly type: RuntimeEventType
  readonly timestamp: string
  readonly sessionId?: string
  readonly payload: unknown
}

interface EventRow {
  readonly id: string
  readonly type: RuntimeEventType
  readonly timestamp: string
  readonly session_id: string | null
  readonly payload_json: string
}

/** Append/read repository for runtime events associated with sessions. */
export class RuntimeEventRepository {
  constructor(private readonly db: Database) {}

  append(event: RuntimeEvent, sessionId?: string): PersistedRuntimeEvent {
    const record: PersistedRuntimeEvent = {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp.toISOString(),
      sessionId,
      payload: event.payload,
    }
    this.db
      .query("INSERT INTO runtime_events (id, type, timestamp, session_id, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, record.type, record.timestamp, record.sessionId ?? null, toJson(record.payload))
    return record
  }

  listBySession(sessionId: string): readonly PersistedRuntimeEvent[] {
    return this.db
      .query<EventRow, [string]>("SELECT * FROM runtime_events WHERE session_id = ? ORDER BY timestamp, id")
      .all(sessionId)
      .map(toRecord)
  }
}

const toRecord = (row: EventRow): PersistedRuntimeEvent => ({
  id: row.id,
  type: row.type,
  timestamp: row.timestamp,
  sessionId: row.session_id ?? undefined,
  payload: fromJson(row.payload_json, null),
})
