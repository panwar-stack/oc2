import type { Database } from "bun:sqlite"
import type { RuntimeErrorShape } from "../../events/events"
import type { MessagePart, MessageRole, RuntimeStatus, SessionMessage, TokenUsage } from "../../session/message"
import { fromJson, toJson } from "./json"

export interface CreateMessageInput {
  readonly id?: string
  readonly sessionId: string
  readonly role: MessageRole
  readonly parts: readonly MessagePart[]
  readonly status?: RuntimeStatus
  readonly parentMessageId?: string
  readonly modelId?: string
  readonly usage?: TokenUsage
  readonly error?: RuntimeErrorShape
  readonly now?: string
}

export interface UpdateMessageInput {
  readonly parts?: readonly MessagePart[]
  readonly status?: RuntimeStatus
  readonly usage?: TokenUsage
  readonly error?: RuntimeErrorShape
  readonly modelId?: string
  readonly now?: string
}

interface MessageRow {
  readonly id: string
  readonly session_id: string
  readonly role: MessageRole
  readonly created_at: string
  readonly updated_at: string
  readonly status: RuntimeStatus
  readonly parent_message_id: string | null
  readonly model_id: string | null
  readonly usage_json: string | null
  readonly error_json: string | null
}

interface PartRow {
  readonly data_json: string
}

const createId = (): string => crypto.randomUUID()

export class MessageRepository {
  constructor(private readonly db: Database) {}

  append(input: CreateMessageInput): SessionMessage {
    const now = input.now ?? new Date().toISOString()
    const id = input.id ?? createId()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db
        .query(
          `INSERT INTO messages
          (id, session_id, role, created_at, updated_at, status, parent_message_id, model_id, usage_json, error_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.role,
          now,
          now,
          input.status ?? "completed",
          input.parentMessageId ?? null,
          input.modelId ?? null,
          input.usage ? toJson(input.usage) : null,
          input.error ? toJson(input.error) : null,
        )
      this.replaceParts(id, input.parts)
      this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId)
      this.db.exec("COMMIT")
      return this.get(id) as SessionMessage
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  get(id: string): SessionMessage | undefined {
    const row = this.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(id)
    if (!row) return undefined
    return this.toRecord(row)
  }

  listBySession(sessionId: string): readonly SessionMessage[] {
    return this.db
      .query<MessageRow, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId)
      .map((row) => this.toRecord(row))
  }

  update(id: string, input: UpdateMessageInput): SessionMessage {
    const existing = this.get(id)
    if (!existing) throw new Error(`Message not found: ${id}`)
    const now = input.now ?? new Date().toISOString()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db
        .query(
          `UPDATE messages SET updated_at = ?, status = ?, model_id = ?, usage_json = ?, error_json = ? WHERE id = ?`,
        )
        .run(
          now,
          input.status ?? existing.status,
          input.modelId ?? existing.modelId ?? null,
          input.usage ? toJson(input.usage) : existing.usage ? toJson(existing.usage) : null,
          input.error ? toJson(input.error) : existing.error ? toJson(existing.error) : null,
          id,
        )
      if (input.parts) this.replaceParts(id, input.parts)
      this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, existing.sessionId)
      this.db.exec("COMMIT")
      return this.get(id) as SessionMessage
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  private replaceParts(messageId: string, parts: readonly MessagePart[]): void {
    this.db.query("DELETE FROM message_parts WHERE message_id = ?").run(messageId)
    const insertPart = this.db.query(
      "INSERT INTO message_parts (id, message_id, part_index, type, data_json) VALUES (?, ?, ?, ?, ?)",
    )
    parts.forEach((part, index) => insertPart.run(createId(), messageId, index, part.type, toJson(part)))
  }

  private toRecord(row: MessageRow): SessionMessage {
    const parts = this.db
      .query<PartRow, [string]>("SELECT data_json FROM message_parts WHERE message_id = ? ORDER BY part_index")
      .all(row.id)
      .map((part) => fromJson<MessagePart>(part.data_json, { type: "text", text: "" }))
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      parts,
      status: row.status,
      parentMessageId: row.parent_message_id ?? undefined,
      modelId: row.model_id ?? undefined,
      usage: fromJson<TokenUsage | undefined>(row.usage_json, undefined),
      error: fromJson<RuntimeErrorShape | undefined>(row.error_json, undefined),
    }
  }
}
